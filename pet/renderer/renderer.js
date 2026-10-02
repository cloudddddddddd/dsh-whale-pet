// whale-girl desktop renderer: sprite animation driven by /whale-girl/state
// plus session bubbles from /whale-girl/sessions. Loads sheets cross-origin
// as <img> (safe: we only drawImage, never read pixels).
//
// Behavior parity with the official web client (vlln/whale-girl lib/client):
// the 15-state priority table (drag -> drag-release idle buffer -> server
// activity burst -> eat/play/wake transient -> wait -> celebrate ->
// working interlude -> think -> joy -> sleep -> walk -> idle), blink playback
// for idle (random 3-9s blinks), random facing flips on static states,
// working interludes during think (12-30s apart, 2.5-6s long), feed/play
// interaction (POST /interact via the main process -> reply bubble + eat/play
// + joy).
const BASE = 'http://127.0.0.1:3080'
// sprite 素材已弃置：形象完全由 Live2D 渲染（见 live2d-pet.js）。
// 保留空串，使兜底路径不再对旧端点发网络请求。
const ASSETS = ''

const STAGE_BASE = 220
// Sleep tuning.
//  - how long the pet naps is re-rolled for EVERY nap (5..15 minutes)
//  - after a nap it stays awake for a fixed 5 minutes, pottering about
//  - the idle delay before dozing off is also re-rolled each cycle
let SLEEP_CYCLE_MIN_MS = 300000  // 5 minutes  (shortest nap)
let SLEEP_CYCLE_MAX_MS = 900000  // 15 minutes (longest nap)
let SLEEP_CYCLE_MS = rollSleepCycle() // nap length for the current nap
let WAKE_ACTIVE_MS = 300000      // awake 5 minutes between naps (fixed)
let SLEEP_AFTER_MS = 300000      // 5 minutes idle (fixed) before dozing off

/** Uniform random value in [lo, hi] (ms). */
function rollRange(lo, hi) {
  const a = lo
  const b = Math.max(a, hi)
  return Math.round(a + Math.random() * (b - a))
}
/** Nap length for the next sleep: 5..15 minutes. */
function rollSleepCycle() { return rollRange(SLEEP_CYCLE_MIN_MS, SLEEP_CYCLE_MAX_MS) }
const WELCOME_MS = 2500
const CLICK_MAX_MOVE = 5 // px; a press that moves less is a click, not a drag

// ---- behavior constants (parity with official lib/client/logic.mjs) ----
const TRANSIENT_MS = 1500    // eat/play transient duration
const JOY_MS = 1600          // post-interaction joy window
const DRAG_RELEASE_MS = 1500 // idle buffer after dropping a drag
const WALK_MS = 800          // short walk-back after a drag drop
const REPLY_MS = 2500        // interaction reply bubble lifetime
const WORKING_MIN_WAIT_MS = 12000
const WORKING_MAX_WAIT_MS = 30000
const WORKING_MIN_DUR_MS = 2500
const WORKING_MAX_DUR_MS = 6000
const BLINK_MIN_INTERVAL_MS = 3000
const BLINK_MAX_INTERVAL_MS = 9000
const FACING_MIN_INTERVAL_MS = 10000
const FACING_MAX_INTERVAL_MS = 25000

const canvas = document.getElementById('pet')
const gfx = canvas.getContext('2d')
const bubblesEl = document.getElementById('bubbles')
const sessionBubblesEl = document.getElementById('session-bubbles')
const replyEl = document.getElementById('reply')

// HiDPI-aware backing store: the canvas is stage CSS px but renders at
// devicePixelRatio resolution, so the sprite stays crisp on 2x/3x displays.
// `stage` follows the main process scale preset (B2) via pet-scale IPC.
const DPR = window.devicePixelRatio || 1
let stage = STAGE_BASE

// Live2D mode: when the Live2D model loads, it renders the character and the
// sprite canvas becomes an invisible click layer. The sprite path stays as a
// fallback if the engine or model fails to load.
let live2dActive = false
const LIVE2D_SHEET_STUB = { complete: true, naturalWidth: 1, naturalHeight: 1 }

function applyStage(next) {
  stage = Math.max(8, Math.round(next || STAGE_BASE))
  // 计时提醒用 calc(var(--stage) + 10px) 定位，必须把实际舞台高度同步给 CSS
  try { document.documentElement.style.setProperty('--stage', stage + 'px') } catch { /* 忽略 */ }
  canvas.style.width = `${stage}px`
  canvas.style.height = `${stage}px`
  canvas.width = Math.round(stage * DPR)
  canvas.height = Math.round(stage * DPR)
  gfx.setTransform(DPR, 0, 0, DPR, 0, 0)
  gfx.imageSmoothingEnabled = true
  gfx.imageSmoothingQuality = 'high'
  // keep the Live2D stage the same size as the sprite canvas
  const l2d = document.getElementById('live2d-stage')
  if (l2d) {
    l2d.style.width = `${stage}px`
    l2d.style.height = `${stage}px`
    if (window.PetLive2D && window.PetLive2D.isReady()) {
      if (window.PetLive2D.resize) {
        window.PetLive2D.resize(stage, stage)
      } else {
        window.PetLive2D.layout()
      }
    }
  }
}
applyStage(STAGE_BASE)

let manifest = null
let sheets = new Map()          // state name -> HTMLImageElement
let payload = { online: false, state: null }
let welcomed = false
let welcomeUntil = 0
let idleSince = Date.now()
let sleepSince = 0               // when the current nap started (0 = awake)

// animation state
let animName = 'idle'
let animFrame = 0
let frameAt = 0

// ---- local behavior state (official client parity) ----
let transient = null           // 'eat' | 'play' | 'wake' | null
let transientUntil = 0
let joyUntil = 0
let dragReleaseUntil = 0
let walking = false
let walkingUntil = 0
let working = { active: false, until: 0 }
let blinkPhase = false
let blinkStartAt = 0
let nextBlinkAt = Date.now() + BLINK_MIN_INTERVAL_MS + Math.random() * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS)
let facing = 1                 // 1 = normal, -1 = mirrored
let nextFacingAt = Date.now() + FACING_MIN_INTERVAL_MS + Math.random() * (FACING_MAX_INTERVAL_MS - FACING_MIN_INTERVAL_MS)
let replyTimer = 0

// pointer state (B1): manual drag via IPC because a draggable app-region
// swallows clicks; the window follows the mouse deltas, a still press toggles
// the embedded DSH web window.
let pointerDown = null

// The manifest arrives over IPC from the main process (a file:// page cannot
// fetch() the DSH origin; <img> sprite loads below are fine).
window.pet.onManifest((m) => {
  manifest = m
  sheets.clear() // a manifest only arrives when it changes; drop stale sprite cache
})

window.pet.onScale((metrics) => {
  if (metrics && Number.isFinite(metrics.stage)) applyStage(metrics.stage)
})

// Debug overrides for tests: shorten SLEEP_AFTER_MS for fast sleep-capture,
// or fire one feed interaction to capture the eat/reply/joy sequence.
window.pet.onDebug((debug) => {
  if (debug && Number.isFinite(debug.sleepAfterMs) && debug.sleepAfterMs > 0) {
    SLEEP_AFTER_MS = debug.sleepAfterMs
    console.log(`[renderer] debug sleepAfterMs=${SLEEP_AFTER_MS}`)
  }
  if (debug && Number.isFinite(debug.sleepCycleMs) && debug.sleepCycleMs > 0) {
    SLEEP_CYCLE_MIN_MS = debug.sleepCycleMs
    SLEEP_CYCLE_MAX_MS = debug.sleepCycleMs
    SLEEP_CYCLE_MS = debug.sleepCycleMs
    console.log(`[renderer] debug sleepCycleMs=${SLEEP_CYCLE_MS}`)
  }
  if (debug && Number.isFinite(debug.wakeActiveMs) && debug.wakeActiveMs > 0) {
    WAKE_ACTIVE_MS = debug.wakeActiveMs
    console.log(`[renderer] debug wakeActiveMs=${WAKE_ACTIVE_MS}`)
  }
  if (debug && debug.interactTest === true) {
    setTimeout(() => window.pet.interact('feed'), 1200) // let the sprite load first
    console.log('[renderer] debug interactTest')
  }
})

function characterId() {
  if (!manifest) return null
  return manifest.default || Object.keys(manifest.characters || {})[0] || null
}

function character() {
  if (!manifest) return null
  const id = characterId()
  return id ? manifest.characters[id] : null
}

function sheetFor(name) {
  const ch = character()
  const id = characterId()
  if (!ch || !id || !ch.states[name]) return null
  if (!sheets.has(name)) {
    // Sheets live under assets/characters/<characterId>/<sheet> in the package.
    const img = new Image()
    img.src = `${ASSETS}/characters/${id}/${ch.states[name].sheet}`
    sheets.set(name, img)
  }
  return sheets.get(name)
}

/** Live2D mode has no sprite sheets: treat every state as available so the
 *  state machine keeps its full range of states instead of degrading to idle. */
function sheetForMode(name) {
  return live2dActive ? LIVE2D_SHEET_STUB : sheetFor(name)
}

// ---- state selection (parity with the official STATE_TABLE priorities) ----
// Wall-clock decisions use Date.now() (absolute Unix ms), matching the
// server's absolute turnCompletedUntil deadline; the rAF timestamp is
// page-relative and would make the celebrate window appear never to expire.
function pickTarget(now) {
  if (!payload.online || !payload.state) return 'idle'
  const act = payload.state.activity || {}
  // 1. dragging overrides everything
  if (pointerDown) return sheetForMode('drag') ? 'drag' : 'idle'
  // 2. brief idle buffer right after a drag drop (no hard switch to think/working)
  if (now < dragReleaseUntil) return 'idle'
  // 3. server activity burst window (welcome/celebrate/error/disappointed/...)
  if (typeof act.name === 'string' && act.name !== 'idle' && act.name !== 'working'
      && Number.isFinite(act.until) && act.until > now && sheetForMode(act.name)) return act.name
  // 4. interaction transient (eat/play)
  if (transient && now < transientUntil) return transient
  // 5. waiting for user approval
  if (act.sessionWait === true) return 'wait'
  // 6. local turn-completed celebration (server deadline)
  if (Number.isFinite(act.turnCompletedUntil) && act.turnCompletedUntil > now) return 'celebrate'
  // 7. working interlude (random, think-only rhythm)
  if (working.active) return 'working'
  // 8. thinking is the companionship default while a session runs
  if (act.sessionThink === true) return 'think'
  // 9. post-interaction joy
  if (now < joyUntil) return 'joy'
  // 10. sleep after a long idle, in repeating sleep -> wake -> sleep cycles
  if ((act.name === 'idle' || typeof act.name !== 'string') && now - idleSince > SLEEP_AFTER_MS) {
    if (sleepSince === 0) {
      sleepSince = now
      SLEEP_CYCLE_MS = rollSleepCycle() // fresh nap length every time
      console.log(`[renderer] nap starting: ${Math.round(SLEEP_CYCLE_MS / 60000 * 10) / 10} min`)
    }
    if (now - sleepSince < SLEEP_CYCLE_MS) return 'sleep'
    // Napped long enough: wake up and act lively for WAKE_ACTIVE_MS. Rewinding
    // idleSince by (SLEEP_AFTER_MS - WAKE_ACTIVE_MS) puts the next nap exactly
    // WAKE_ACTIVE_MS away, so the pet is active in between and then settles
    // back down on its own.
    sleepSince = 0
    // Rewind the idle clock so the pet stays active for WAKE_ACTIVE_MS before
    // it can doze off again (the next nap length is rolled on entry).
    idleSince = now - (SLEEP_AFTER_MS - WAKE_ACTIVE_MS)
    console.log(`[renderer] nap over -> awake for ${Math.round(WAKE_ACTIVE_MS / 60000 * 10) / 10} min; next nap in ${Math.round(SLEEP_AFTER_MS / 60000 * 10) / 10} min`)
    return 'wake'
  }
  sleepSince = 0 // not sleepy -> reset the cycle
  // 11. brief walk-back after a drag drop
  if (walking && now < walkingUntil) return sheetForMode('walk') ? 'walk' : 'idle'
  // 12. named state the server pushed (working or others with a sheet)
  return typeof act.name === 'string' && sheetForMode(act.name) ? act.name : 'idle'
}

/** Random working-interlude rhythm (parity with official nextWorkingRhythm). */
function updateWorking(now) {
  const think = payload.online && payload.state?.activity?.sessionThink === true
  if (!think) {
    working = { active: false, until: 0 }
    return
  }
  if (working.active) {
    if (now >= working.until) {
      // interlude over -> schedule the next one
      working = { active: false, until: now + WORKING_MIN_WAIT_MS + Math.random() * (WORKING_MAX_WAIT_MS - WORKING_MIN_WAIT_MS) }
    }
  } else if (now >= working.until) {
    working = { active: true, until: now + WORKING_MIN_DUR_MS + Math.random() * (WORKING_MAX_DUR_MS - WORKING_MIN_DUR_MS) }
  }
}

function drive(clock) {
  // `clock` is the rAF DOMHighResTimeStamp: page-relative, only good for
  // animation timing. All state decisions need the absolute wall clock.
  const now = Date.now()
  if (transient && now >= transientUntil) {
    // A feed / play / wake transient just finished: return the pet to whatever
    // look the menu was set to (pinned expression + motion), or to the plain
    // state look when nothing was picked.
    console.log(`[renderer] transient ${transient} ended -> resumeManualLook (curState=${window.PetLive2D ? window.PetLive2D.getState() : '?'})`)
    transient = null
    if (window.PetLive2D && window.PetLive2D.isReady() && window.PetLive2D.resumeManualLook) {
      window.PetLive2D.resumeManualLook()
    }
  }
  updateWorking(now)
  let target = pickTarget(now)

  // welcome once, shortly after the first online snapshot (held for WELCOME_MS)
  if (payload.online && !welcomed) {
    welcomed = true
    welcomeUntil = now + WELCOME_MS
  }
  if (now < welcomeUntil) target = 'welcome'
  // wake transition out of sleep (not while dragging or mid-interaction)
  if (animName === 'sleep' && target !== 'sleep' && !pointerDown && !transient) target = 'wake'
  // stay awake while interacting with anything other than plain idle.
  // `sleep` must NOT reset the clock: pickTarget returns 'sleep' while the
  // condition still holds, and resetting here would flip the pet back to idle
  // the very next frame (the sleep state could never settle in).
  if (target !== 'idle' && target !== 'sleep') idleSince = now

  // Live2D mode: the model draws the character, so skip the sprite path
  // entirely and just push state changes into the Live2D module.
  if (live2dActive) {
    if (target !== animName) {
      animName = target
      animFrame = 0
      frameAt = clock
      if (animName === 'wake') idleSince = now
      console.log(`[renderer] state ${target} (live2d)`)
      if (window.PetLive2D && window.PetLive2D.isReady()) {
        window.PetLive2D.setState(animName)
      }
    }
    requestAnimationFrame(drive)
    return
  }

  const want = sheetFor(target)
  if (!want || !want.complete || want.naturalWidth === 0) {
    drawPlaceholder()
    requestAnimationFrame(drive)
    return
  }

  // state change resets the frame clock
  if (target !== animName) {
    animName = target
    animFrame = 0
    frameAt = clock
    // Only wake restarts the idle clock here: entering sleep must preserve the
    // idle age (the sleep condition stays true while the pet sleeps), and
    // waking up means fresh activity from now on.
    if (animName === 'wake') idleSince = now
    console.log(`[renderer] state ${target}`)
  }

  const spec = character().states[animName]
  const frames = Math.max(1, spec.frames || 1)
  const fps = spec.fps || 2
  const play = spec.playback || 'loop'
  const frameW = Math.floor(want.naturalWidth / frames)
  const frameH = want.naturalHeight
  const elapsed = clock - frameAt
  let fi

  if (play === 'blink') {
    // frame 0 is the resting pose; a random interval triggers one blink pass
    // (frames 1..N-1) back to frame 0 (parity with official blink playback).
    if (blinkPhase) {
      const dur = (frames / fps) * 1000
      if (clock - blinkStartAt >= dur) {
        blinkPhase = false
        nextBlinkAt = now + BLINK_MIN_INTERVAL_MS + Math.random() * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS)
      }
      fi = Math.min(Math.floor(((clock - blinkStartAt) / 1000) * fps), frames - 1)
    } else {
      if (now >= nextBlinkAt) {
        blinkPhase = true
        blinkStartAt = clock
      }
      fi = 0
    }
  } else if (play === 'once') {
    fi = Math.min(Math.floor((elapsed / 1000) * fps), frames - 1)
  } else if (play === 'pingpong') {
    const period = Math.max(1, frames * 2 - 2)
    fi = Math.floor((elapsed / 1000) * fps)
    fi = ((fi % period) + period) % period
    if (fi >= frames) fi = period - fi
  } else {
    fi = Math.floor((elapsed / 1000) * fps)
    fi = ((fi % frames) + frames) % frames
  }
  animFrame = fi

  // random facing flips on static companion states (parity with official)
  if ((animName === 'idle' || animName === 'think' || animName === 'wait') && now >= nextFacingAt) {
    facing *= -1
    nextFacingAt = now + FACING_MIN_INTERVAL_MS + Math.random() * (FACING_MAX_INTERVAL_MS - FACING_MIN_INTERVAL_MS)
  }

  // motion transforms (cheap approximations of the web client's effects)
  gfx.clearRect(0, 0, stage, stage)
  gfx.save()
  if (facing < 0) {
    gfx.translate(stage, 0)
    gfx.scale(-1, 1)
  }
  const bob = clock / 1000
  if (animName === 'think') gfx.translate(0, Math.sin(bob * 2) * 3)
  if (animName === 'wait') gfx.rotate(Math.sin(bob * 4) * 0.05)
  if (animName === 'error') gfx.translate(Math.sin(bob * 40) * 2, 0)
  if (animName === 'drag') gfx.rotate(Math.sin(bob * 5) * 0.08)
  // Frames are 256x256; scale the whole frame down to fit the stage instead
  // of cropping it (an unscaled draw at a negative offset shows only the
  // character's center).
  const fit = Math.min(stage / frameW, stage / frameH)
  const dw = Math.round(frameW * fit)
  const dh = Math.round(frameH * fit)
  gfx.drawImage(
    want, animFrame * frameW, 0, frameW, frameH,
    Math.round((stage - dw) / 2), Math.round((stage - dh) / 2), dw, dh,
  )
  gfx.restore()

  requestAnimationFrame(drive)
}

function drawPlaceholder() {
  gfx.clearRect(0, 0, stage, stage)
  gfx.fillStyle = 'rgba(80, 120, 220, 0.35)'
  gfx.beginPath()
  gfx.arc(stage / 2, stage / 2, 26, 0, Math.PI * 2)
  gfx.fill()
  gfx.fillStyle = 'rgba(255,255,255,0.8)'
  gfx.font = '10px sans-serif'
  gfx.textAlign = 'center'
  gfx.fillText('whale-girl', stage / 2, stage / 2 + 4)
}

window.pet.onState((p) => {
  payload = p
  // Only active states restart the idle clock; resetting on every poll would
  // make sleep unreachable (the pet stays awake forever).
  if (p.online) {
    const act = p.state?.activity || {}
    const active = act.sessionThink === true || act.sessionWait === true
      || (typeof act.name === 'string' && act.name !== 'idle')
      || (Number.isFinite(act.turnCompletedUntil) && act.turnCompletedUntil > Date.now())
    if (active) idleSince = Date.now()
  }
})

// ---- interaction (feed/play parity): eat/play transient + joy + reply bubble ----
window.pet.onInteractResult(({ action, reply }) => {
  transient = action === 'feed' ? 'eat' : 'play'
  transientUntil = Date.now() + TRANSIENT_MS
  joyUntil = Date.now() + TRANSIENT_MS + JOY_MS
  idleSince = Date.now() // interaction means the user is present
  console.log(`[renderer] interact=${action} -> transient=${transient} (${TRANSIENT_MS}ms) joy (${TRANSIENT_MS + JOY_MS}ms)`)
  if (typeof reply === 'string' && reply) showReply(reply)
})

function showReply(text) {
  replyEl.textContent = text
  replyEl.classList.add('show')
  clearTimeout(replyTimer)
  replyTimer = setTimeout(() => replyEl.classList.remove('show'), REPLY_MS)
}

// ---- session bubbles (B3): title + current action above the pet ----
function actionLabel(activity) {
  if (typeof activity !== 'string') return ''
  if (activity === 'thinking') return '深度思考中'
  if (activity === 'waiting') return '等待批准'
  if (activity.startsWith('tool:')) {
    const name = activity.slice('tool:'.length)
    return name === 'bash' || name === 'pwsh' ? '运行命令行中' : `执行 ${name} 工具`
  }
  return ''
}

/** Classify an activity into a visual state: drives the bubble accent colour
 *  and its status dot, so a glance tells you WHAT the agent is doing rather
 *  than just that it is busy. */
function stateOf(activity) {
  if (typeof activity !== 'string' || !activity) return 'idle'
  if (activity === 'thinking') return 'thinking'
  if (activity === 'waiting') return 'waiting'
  if (activity === 'done') return 'done'
  if (activity === 'error' || activity === 'failed') return 'error'
  if (activity.startsWith('tool:')) {
    const name = activity.slice('tool:'.length).toLowerCase()
    if (/^(read|fs_read|glob|grep|search_files|list)/.test(name)) return 'reading'
    if (/^(write|edit|apply_patch|create|multi_edit)/.test(name)) return 'writing'
    if (/^(bash|pwsh|shell|exec|cmd|run)/.test(name)) return 'running'
    if (/(web_search|web_fetch|browser|fetch|search_pro|platform_search)/.test(name)) return 'searching'
    if (/(task|agent|subagent|delegate)/.test(name)) return 'delegating'
    if (/(todo|plan|update_plan)/.test(name)) return 'planning'
    return 'working'
  }
  return 'idle'
}

/** Short Chinese label for a state (shown as the bubble's status line). */
const STATE_LABEL = {
  idle: '待机',
  thinking: '深度思考中',
  waiting: '等待批准',
  working: '干活中',
  reading: '读文件',
  writing: '写代码',
  running: '跑命令',
  searching: '联网搜索',
  delegating: '派子代理',
  planning: '列计划',
  done: '已完成',
  error: '出错了',
}

window.pet.onSessions((sessions) => {
  sessionBubblesEl.replaceChildren()
  for (const s of sessions || []) {
    if (!s || typeof s !== 'object') continue
    if (s.activity === 'done') continue // 会话结束后框消失
    const state = stateOf(s.activity)
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.dataset.state = state
    const title = document.createElement('div')
    title.className = 'bubble-title'
    const dot = document.createElement('span')
    dot.className = 'bubble-dot'
    const titleText = document.createElement('span')
    titleText.className = 'bubble-title-text'
    titleText.textContent = typeof s.title === 'string' && s.title ? s.title : '会话'
    title.append(dot, titleText)
    const action = document.createElement('div')
    action.className = 'bubble-action'
    const detail = actionLabel(s.activity)
    action.textContent = detail || STATE_LABEL[state] || '空闲'
    // Progress bar: an indeterminate flowing bar while busy, full when done.
    const progress = document.createElement('div')
    progress.className = 'bubble-progress'
    const progressFill = document.createElement('div')
    progressFill.className = 'bubble-progress-fill'
    progress.append(progressFill)
    bubble.append(title, action, progress)
    sessionBubblesEl.append(bubble)
  }
})

// ---- pointer handling (B1 + drag) ----
// Drag is event-driven from the renderer but positioned by the MAIN process:
// the renderer only signals "dragging" (mousedown/mousemove/mouseup), and the
// main process reads the authoritative cursor (screen.getCursorScreenPoint,
// DIP) to compute an ABSOLUTE target = start window pos + cursor delta.
// Absolute math means a feedback mousemove (the window moved under a still
// cursor) reads the same cursor and computes the same target -> no movement,
// so the pet can never self-accelerate. And because it is event-driven, a
// still mouse emits no events and the pet never drifts.
let dragging = false
canvas.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return
  pointerDown = { x: event.screenX, y: event.screenY }
  dragging = true
  window.pet.dragStart()
})
window.addEventListener('mousemove', (event) => {
  if (!dragging) return
  window.pet.dragMove()
})
window.addEventListener('mouseup', (event) => {
  if (!pointerDown) return
  const dx = event.screenX - pointerDown.x
  const dy = event.screenY - pointerDown.y
  const moved = Math.hypot(dx, dy) > CLICK_MAX_MOVE
  pointerDown = null
  dragging = false
  window.pet.dragEnd()
  if (moved) {
    // drag dropped: brief idle buffer + a short walk-back; user presence
    // restarts the idle clock so the pet does not drop straight back to sleep.
    dragReleaseUntil = Date.now() + DRAG_RELEASE_MS
    walking = true
    walkingUntil = Date.now() + WALK_MS
    idleSince = Date.now()
  } else {
    window.pet.toggleWeb()
  }
})
canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault()
  window.pet.openMenu()
})

// Safety net: if the button-up somehow escapes the window (e.g. the OS grabs
// the cursor, or a native context menu takes focus), never leave the pet stuck
// in dragging state. Note this clears on ANY stray pointerDown too — a stuck
// pointerDown makes pickTarget() return 'drag' forever.
window.addEventListener('blur', () => {
  if (dragging || pointerDown) {
    dragging = false
    pointerDown = null
    window.pet.dragEnd()
  }
})

// ---- Live2D expression / motion commands from the pet menu ----
// A pinned expression keeps its face through state changes; motion playback
// is one-shot (the state scheduler resumes afterwards). Each command shows a
// short confirmation bubble so a click always has visible feedback.
window.pet.onExpression((payload) => {
  const name = payload && typeof payload.name === 'string' ? payload.name : null
  const ready = !!(window.PetLive2D && window.PetLive2D.isReady())
  console.log(`[renderer] onExpression received=${name || '(auto)'} ready=${ready}`)
  if (ready) window.PetLive2D.setExpression(name)
  // Feedback is shown regardless of Live2D readiness so a click is never
  // silent; if the model is not up, say so instead of doing nothing.
  if (typeof showReply === 'function') {
    if (!ready) showReply('⚠️ Live2D 未就绪，表情无法应用')
    else showReply(name ? `😊 表情：${name}` : '😊 表情：跟随状态自动切换')
  }
})
// ---- 计时器到点提醒：用气泡说出来，并让桌宠切到"庆祝/惊动"状态 ----
let clockAlertShowTimer = null
let clockAlertHideTimer = null
const CLOCK_ALERT_MS = 5000    // 停留时长（比之前短，不长期占位）
const CLOCK_ALERT_FADE_MS = 340 // 与 CSS transition 时长一致

/** 桌宠头顶的大号提醒（蓝色、淡入淡出）。不弹独立窗口、也不再弹小气泡。 */
function showBigClockAlert(payload) {
  const box = document.getElementById('clockAlert')
  const timeEl = document.getElementById('clockAlertTime')
  const textEl = document.getElementById('clockAlertText')
  if (!box || !timeEl || !textEl) return
  timeEl.textContent = (payload && payload.big) || '⏰'
  textEl.textContent = (payload && payload.sub) || ''

  if (clockAlertShowTimer) clearTimeout(clockAlertShowTimer)
  if (clockAlertHideTimer) clearTimeout(clockAlertHideTimer)

  box.style.display = 'block'
  box.classList.remove('hide')
  // 强制一次样式重算，保证连续触发时淡入动画能重新播放
  void box.offsetWidth
  box.classList.add('show')

  clockAlertShowTimer = setTimeout(() => {
    box.classList.remove('show')
    box.classList.add('hide')
    clockAlertHideTimer = setTimeout(() => {
      box.style.display = 'none'
      box.classList.remove('hide')
    }, CLOCK_ALERT_FADE_MS)
  }, CLOCK_ALERT_MS)
}

window.pet.onClockAlert((payload) => {
  const text = payload && typeof payload.text === 'string' ? payload.text : ''
  if (!text) return
  console.log('[renderer] clock alert: ' + text)
  // 只显示大框：不再调用 showReply()，否则大框小框会同时出现
  showBigClockAlert(payload)
  // 到点也是个事件：让桌宠演一下，配合提醒更容易被注意到
  transient = 'play'
  transientUntil = Date.now() + TRANSIENT_MS
  joyUntil = Date.now() + TRANSIENT_MS + JOY_MS
})

// ---- "random performance" button from the control panel ----
window.pet.onIdleShow(() => {
  if (window.PetLive2D && window.PetLive2D._triggerIdleShow) {
    window.PetLive2D._triggerIdleShow()
    console.log('[renderer] idle show triggered from the control panel')
  }
})

// ---- persistent look layers (hand pose / held prop) ----
window.pet.onHand((payload) => {
  const name = payload && typeof payload.name === 'string' ? payload.name : null
  const ready = !!(window.PetLive2D && window.PetLive2D.isReady())
  console.log('[renderer] onHand received=' + (name || '(none)') + ' ready=' + ready)
  if (ready) window.PetLive2D.setHandExpr(name)
  if (typeof showReply === 'function') showReply(ready ? (name ? `✋ 手部：${name}` : '✋ 手部：无') : '⚠️ Live2D 未就绪')
})
window.pet.onProp((payload) => {
  const name = payload && typeof payload.name === 'string' ? payload.name : null
  const ready = !!(window.PetLive2D && window.PetLive2D.isReady())
  console.log('[renderer] onProp received=' + (name || '(none)') + ' ready=' + ready)
  if (ready) window.PetLive2D.setPropExpr(name)
  if (typeof showReply === 'function') showReply(ready ? (name ? `🎁 道具：${name}` : '🎁 道具：无') : '⚠️ Live2D 未就绪')
})

// ---- gaze: the main process streams the global cursor position ----
window.pet.onCursor((p) => {
  if (window.PetLive2D && window.PetLive2D.setCursor) window.PetLive2D.setCursor(p)
})
window.pet.onGaze((payload) => {
  const on = !!(payload && payload.enabled)
  if (window.PetLive2D && window.PetLive2D.setGazeEnabled) window.PetLive2D.setGazeEnabled(on)
  console.log('[renderer] gaze ' + (on ? 'on' : 'off'))
})
window.pet.onMotion((payload) => {
  const index = payload && typeof payload.index === 'number' ? payload.index : null
  const label = payload && typeof payload.name === 'string' ? payload.name : null
  const ready = !!(window.PetLive2D && window.PetLive2D.isReady())
  console.log(`[renderer] onMotion received=${index === null ? '(idle)' : index} ready=${ready}`)
  if (ready) window.PetLive2D.playMotionOnce(index)
  if (typeof showReply === 'function') {
    if (!ready) showReply('⚠️ Live2D 未就绪，动作无法应用')
    else showReply(index === null ? '🎬 动作：已停止' : `🎬 动作：${label || '#' + index}`)
  }
})

// ---- Live2D boot ----
// Try the Live2D model first; if the engine, Cubism Core or the model cannot
// load, the sprite renderer keeps running untouched (live2dActive stays false).
;(async () => {
  if (!window.PetLive2D) {
    console.log('[renderer] Live2D module unavailable; using sprites')
    return
  }
  try {
    const ok = await window.PetLive2D.init('../live2d/model/c_0120.model3.json')
    if (!ok) {
      console.log('[renderer] Live2D init failed; using sprites')
      return
    }
    live2dActive = true
    const l2d = document.getElementById('live2d-stage')
    if (l2d) {
      l2d.style.width = `${stage}px`
      l2d.style.height = `${stage}px`
    }
    window.PetLive2D.setState(animName)
    console.log('[renderer] Live2D active')
  } catch (e) {
    console.log('[renderer] Live2D boot error:', e && e.message)
  }
})()

requestAnimationFrame(drive)
