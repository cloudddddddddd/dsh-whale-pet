// dsh-whale-pet — Electron main process (Live2D desktop companion).
//
// Responsibilities:
//  - transparent, frameless, always-on-top pet window (drag via IPC-managed
//    manual drag: a draggable app-region swallows clicks, so the renderer
//    reports mouse deltas and the window follows)
//  - polls GET /dsh-whale-pet/state and GET /dsh-whale-pet/sessions, forwards both
//    to the renderer over IPC
//  - presence heartbeat POST /dsh-whale-pet/presence (15s renew; farewell on quit)
//  - click-to-toggle embedded DSH web window (second BrowserWindow, hidden
//    until the pet is clicked; never touches the DSH service itself)
//  - size presets 75/100/125/150/200% via right-click menu, persisted
//  - feed/play interaction proxy POST /dsh-whale-pet/interact (menu items ->
//    eat/play animation + reply bubble in the renderer)
//  - position persistence; `--screenshot=<path>` captures the window for tests
const { app, BrowserWindow, screen, Menu, ipcMain, Tray, nativeImage, shell } = require('electron')

// Single instance: a second launch (e.g. from a startup script while the pet is
// already running) focuses the existing window instead of spawning a duplicate.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}
app.on('second-instance', () => {
  // Re-launch from the desktop shortcut: show the pet and the web window.
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  toggleWeb()
})
const fs = require('node:fs')
const path = require('node:path')
const { execFile, spawn } = require('node:child_process')

const BASE_ARG = process.argv.find((arg) => arg.startsWith('--base-url='))
const BASE = BASE_ARG ? BASE_ARG.slice('--base-url='.length) : 'http://127.0.0.1:3080'
const STATE_URL = `${BASE}/dsh-whale-pet/state`
const SESSIONS_URL = `${BASE}/dsh-whale-pet/sessions`
const PRESENCE_URL = `${BASE}/dsh-whale-pet/presence`
const INTERACT_URL = `${BASE}/dsh-whale-pet/interact`
// dsh web launcher facts (same values the one-click VBS launcher uses).
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe'
const DSH_BIN = 'C:\\Users\\clouddddd\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const PNPM_DIR = 'F:\\文档\\文档\\deepseek work\\.tooling\\pnpm'
const POLL_MS = 1500
const HEARTBEAT_MS = 15000
const PET_SIZE = 220
const WIN_MARGIN = 20
// Size presets are percentages of PET_SIZE (the new 100% = 220px, which is the
// size the old 200% preset produced). The old presets were [0.75, 1, 1.25,
// 1.5, 2] over PET_SIZE=110; loadScale() migrates a saved value accordingly.
const SCALE_PRESETS = [1, 1.25, 1.5, 2, 2.5, 3]
const LEGACY_SCALE_PRESETS = [0.75, 1, 1.25, 1.5, 2]
const BUBBLE_H = 36
const BUBBLE_GAP = 4
const BUBBLE_MIN_W = 210
// 头顶给计时提醒预留的透明高度：不预留的话，没有会话气泡时舞台上方的余量
// 只有 margin，提醒框会被窗口直接裁掉（表现为“飞起来看不见”）。
const CLOCK_ALERT_AREA = 78
const WEB_WIN_W = 1200
const WEB_WIN_H = 800

let win = null
let webWin = null
let tray = null
let menuWin = null          // the control panel window (replaces the native menu)
let currentLook = { mood: null, motion: null, stopped: false, hand: null, prop: null } // mirrored from the renderer
let cursorTimer = null      // polls the global cursor so the pet can look at it
let gazeEnabled = true      // "eyes follow the mouse" toggle
let scale = 1
let bubbleCount = 0
let dragState = null
let isQuitting = false

const posFile = path.join(app.getPath('userData'), 'position.json')
const scaleFile = path.join(app.getPath('userData'), 'scale.json')
function loadPos() {
  try { return JSON.parse(fs.readFileSync(posFile, 'utf8')) } catch { return null }
}
function savePos(bounds) {
  try { fs.writeFileSync(posFile, JSON.stringify(bounds)) } catch { /* non-fatal */ }
}
function loadScale() {
  try {
    const raw = JSON.parse(fs.readFileSync(scaleFile, 'utf8'))
    // v2 marks the re-based preset list. Without it the file predates the
    // change: the old 200% (220px) IS the new 100%, so migrate to 1 and
    // persist, otherwise a legacy "2" would be read as the new 200% (440px).
    if (raw && raw.v === 2) {
      return SCALE_PRESETS.includes(raw.scale) ? raw.scale : 1
    }
    saveScale(1)
    return 1
  } catch { return 1 }
}
function saveScale(s) {
  try { fs.writeFileSync(scaleFile, JSON.stringify({ scale: s, v: 2 })) } catch { /* non-fatal */ }
}

function stageSize() { return Math.round(PET_SIZE * scale) }
function marginSize() { return Math.round(WIN_MARGIN * scale) }

/** Window metrics: bubbles sit above the pet, so the window grows upward when sessions are active. */
function windowMetrics() {
  const stage = stageSize()
  const margin = marginSize()
  // Cap the bubble area: tasks flick activity labels, and an unbounded count
  // would stretch the window taller on every poll. Max 3 bubbles shown.
  const bubbles = Math.min(bubbleCount, 3)
  const bubbleArea = bubbles > 0 ? bubbles * BUBBLE_H + (bubbles - 1) * BUBBLE_GAP : 0
  return {
    stage,
    w: Math.max(stage + margin * 2, bubbles > 0 ? BUBBLE_MIN_W : 0),
    // 头顶恒定预留一块透明空间给计时提醒：不预留的话，没有会话气泡时
    // 舞台上方的余量只有 margin，提醒框会直接被窗口裁掉（看起来"飞走了"）。
    h: margin + CLOCK_ALERT_AREA + bubbleArea + stage + margin,
  }
}

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// NOTE: the sprite sheet manifest is gone. The pet is rendered with Live2D
// (see renderer/live2d-pet.js), which loads the model from pet/live2d/model.

async function pokePresence(online) {
  try {
    await fetch(PRESENCE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ online }),
      signal: AbortSignal.timeout(3000),
    })
  } catch { /* DSH may be down; heartbeat resumes on the next interval */ }
}

/** Interaction (feed/play parity with the official web client): POST /interact
 *  and forward the pet's reply to the renderer for its bubble + eat/play/joy. */
async function postInteract(action) {
  console.log('[menu] postInteract ->', action)
  try {
    const res = await fetch(INTERACT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action }),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok || !win || win.isDestroyed()) return
    const body = await res.json()
    win.webContents.send('pet-interact-result', { action, reply: body?.reply })
  } catch { /* DSH down; an interaction simply has no effect */ }
}

/** Resize the pet window to the current scale + bubble count, keeping the bottom edge fixed. */
function applyWindowSize() {
  if (!win || win.isDestroyed()) return
  const { stage, w, h } = windowMetrics()
  const bounds = win.getBounds()
  // Keep the bottom edge fixed while growing upward for bubbles, but NEVER
  // let the resize push the window off-screen (y = bottom - h can go negative
  // when bubbles vanish). Clamp the final top-left corner.
  const bottom = bounds.y + bounds.height
  const clamped = clampToWorkArea(bounds.x, bottom - h)
  win.setBounds({ x: Math.round(clamped.x), y: Math.round(clamped.y), width: w, height: h })
  win.webContents.send('pet-scale', { stage })
}

async function pollLoop() {
  for (;;) {
    try {
      const state = await fetchJSON(STATE_URL)
      if (win && !win.isDestroyed()) win.webContents.send('pet-state', { online: true, state })
      // Sent every round: the first send may race the renderer's listener
      // registration, and the manifest is small enough to resend harmlessly.
      sendManifest()
    } catch {
      if (win && !win.isDestroyed()) win.webContents.send('pet-state', { online: false, state: null })
    }
    pollSessions()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Poll /dsh-whale-pet/sessions (same cadence as /state); finished sessions drop their bubble. */
async function pollSessions() {
  try {
    const list = await fetchJSON(SESSIONS_URL)
    if (!Array.isArray(list)) return
    const active = list.filter((s) => s && typeof s === 'object' && s.activity !== 'done')
    if (win && !win.isDestroyed()) win.webContents.send('pet-sessions', active)
    // Resize only on a REAL change of bubble count (not per activity flicker).
    // windowMetrics caps at 3 bubbles, so applying the capped value here keeps
    // the window size stable while a task cycles tool:xxx -> thinking -> wait.
    const capped = Math.min(active.length, 3)
    if (capped !== bubbleCount) {
      bubbleCount = capped
      // Do not resize mid-drag: applyWindowSize repositions the window and
      // would fight the drag (the user feels the range "shrink"). The size
      // settles on the next poll after the drag ends.
      if (!dragState) applyWindowSize()
    }
  } catch { /* /sessions may be absent (pre-A plugin); bubbles stay empty */ }
}

function heartbeatLoop() {
  pokePresence(true)
  setInterval(() => pokePresence(true), HEARTBEAT_MS)
}

// ---- embedded DSH web window (B1): a second BrowserWindow over the same GUI,
// hidden until the pet is clicked; toggling only shows/hides, never stops DSH.
function ensureWebWin() {
  if (webWin && !webWin.isDestroyed()) return webWin
  webWin = new BrowserWindow({
    width: WEB_WIN_W,
    height: WEB_WIN_H,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      backgroundThrottling: false, // keep painting while hidden (web-shot capture)
    },
  })
  webWin.loadURL(BASE)
  // External links (e.g. the plugin marketplace's "GitHub 原链" button, which
  // uses target="_blank") must open in the SYSTEM default browser, not in a
  // new Electron window. Every popup/new-window request is handed to
  // shell.openExternal; in-app navigation stays inside this window.
  webWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  webWin.webContents.on('will-navigate', (event, url) => {
    // Middle-click / JS-driven navigations to other hosts also go external.
    const target = new URL(url)
    const base = new URL(BASE)
    if (target.origin !== base.origin) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })
  webWin.on('closed', () => { webWin = null })
  // Open near the pet, clamped to the pet's display work area.
  if (win && !win.isDestroyed()) {
    const [px, py] = win.getPosition()
    const wa = screen.getDisplayMatching(win.getBounds()).workArea
    let x = px + 24
    let y = py + 24
    if (x + WEB_WIN_W > wa.x + wa.width) x = Math.max(wa.x, px - WEB_WIN_W - 24)
    if (y + WEB_WIN_H > wa.y + wa.height) y = Math.max(wa.y, py - WEB_WIN_H - 24)
    webWin.setPosition(Math.round(x), Math.round(y))
  }
  return webWin
}

function toggleWeb() {
  const w = ensureWebWin()
  if (w.isVisible()) w.hide()
  else { w.show(); w.focus() }
}

/** Show or hide the pet window (tray double-click / menu). */
function togglePetWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isVisible()) win.hide()
  else { win.show(); win.focus() }
}

/** Open the DSH web GUI in the system default browser (one click from the tray). */
function openInBrowser() {
  shell.openExternal(BASE)
}

/** Local copy of the awesome-dsh-plugins directory (plugin catalog). */
const PLUGINS_DIR = 'F:\\文档\\文档\\deepseek work\\awesome-dsh-plugins'
/** GitHub page of the plugin catalog (always up to date). */
const PLUGINS_REPO_URL = 'https://github.com/AdamPlatin123/awesome-dsh-plugins'

/** Open the local plugin catalog directory in Explorer. */
function openPluginsDir() {
  if (fs.existsSync(PLUGINS_DIR)) {
    shell.openPath(PLUGINS_DIR)
  } else {
    shell.openExternal(PLUGINS_REPO_URL) // fall back to GitHub if not present
  }
}

/** Open the plugin catalog on GitHub in the default browser. */
function openPluginsRepo() {
  shell.openExternal(PLUGINS_REPO_URL)
}

/**
 * Open the DSH plugin MARKETPLACE (dsh-plugin-marketplace bundle):
 * it lives inside the DSH web GUI (Settings → DSH插件市场), so this shows
 * the embedded DSH web window — the user lands on the GUI and the market is
 * one click away in Settings. Falls back to the system browser.
 */
function openMarketplace() {
  const w = ensureWebWin()
  if (w && !w.isDestroyed()) {
    w.show()
    w.focus()
  } else {
    openInBrowser()
  }
}

// ---- gaze tracking ------------------------------------------------------
// The pet window is tiny, so the cursor is almost always OUTSIDE it. That is
// why the position has to come from the main process (screen.getCursorScreenPoint)
// instead of a DOM mousemove listener: only the main process sees the whole
// screen. Polling is throttled and skips frames where the cursor did not move.
const CURSOR_POLL_MS = 60

function startCursorTracking() {
  if (cursorTimer) return
  let lastX = Number.NaN
  let lastY = Number.NaN
  let lastSentAt = 0
  cursorTimer = setInterval(() => {
    try {
      if (!gazeEnabled || !win || win.isDestroyed() || !win.isVisible()) return
      const pt = screen.getCursorScreenPoint()
      const moved = pt.x !== lastX || pt.y !== lastY
      const now = Date.now()
      // While the cursor is still, only send a slow heartbeat: the renderer
      // uses it (plus the `moved` flag) to decide when to face forward again.
      if (!moved && now - lastSentAt < 500) return
      lastX = pt.x
      lastY = pt.y
      lastSentAt = now
      const b = win.getBounds()
      win.webContents.send('pet-cursor', {
        x: pt.x,
        y: pt.y,
        moved,
        winX: b.x,
        winY: b.y,
        winW: b.width,
        winH: b.height,
        stage: stageSize(),
      })
    } catch { /* non-fatal */ }
  }, CURSOR_POLL_MS)
}

function stopCursorTracking() {
  if (cursorTimer) { clearInterval(cursorTimer); cursorTimer = null }
}

/** Set eye tracking explicitly (used by the control panel). */
function setGaze(value) {
  gazeEnabled = value !== false
  if (gazeEnabled) startCursorTracking()
  if (win && !win.isDestroyed()) win.webContents.send('pet-gaze', { enabled: gazeEnabled })
  pushMenuState()
}

/** Toggle eye/face tracking (tray menu item). */
function toggleGaze(menuItem) {
  gazeEnabled = menuItem && typeof menuItem.checked === 'boolean' ? menuItem.checked : !gazeEnabled
  if (gazeEnabled) startCursorTracking()
  console.log('[menu] toggleGaze ->', gazeEnabled)
  if (win && !win.isDestroyed()) {
    // Tell the renderer to recentre when tracking is switched off.
    win.webContents.send('pet-gaze', { enabled: gazeEnabled })
  }
}

// ---- 计时器：秒表 / 计时器 / 会话 ------------------------------------------
// 三种模式共用一套「基于绝对时间戳」的算法：所有推进都用 Date.now() 计算，
// 不累加定时器节拍，所以即使卡顿或休眠也不会累积误差（精度到秒）。
// 状态放在主进程，桌宠窗口与控制面板两个渲染进程都能读，避免双份计时。
const CLOCK_MAX_SEC = 99 * 3600 // 上限 99:00:00

const clock = {
  mode: 'stopwatch', // 'stopwatch' | 'timer' | 'session'
  // 秒表：accumulated 是已暂停累计的毫秒；base 是本段开始的时间戳
  stopwatch: { running: false, base: 0, accumulated: 0, laps: [] },
  // 计时器：duration 设定的总时长；endAt 结束时间戳；remaining 暂停时剩余
  timer: { running: false, duration: 0, endAt: 0, remaining: 0 },
  // 会话：多个时间段各自计时，跑完一轮进下一轮，可设循环次数
  session: {
    running: false,
    slots: [],          // [{ label, seconds }]
    loops: 1,           // 循环次数，0 = 无限
    loop: 0,            // 当前第几轮（从 1 起）
    slot: 0,            // 当前第几段（从 0 起，索引）
    endAt: 0,           // 当前段的结束时间戳
    remaining: 0,       // 暂停时当前段的剩余毫秒
  },
}

let clockTickTimer = null
let clockAlertSeq = 0
// 上次把计时状态推给面板的时间：只要有任一时间在跑，就每秒推一次，
// 让面板的大字自己走秒（否则只有点按钮才会刷新，等于看不见时间流逝）。
let clockLastPushAt = 0

/** 毫秒 -> 00:00:00（超过 99 小时就夹到上限） */
function formatClock(ms) {
  let total = Math.floor(Math.max(0, ms) / 1000)
  const max = CLOCK_MAX_SEC
  if (total > max) total = max
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return pad(h) + ':' + pad(m) + ':' + pad(s)
}

function clockNow() { return Date.now() }

/** 秒表格式：分:秒:厘秒（精度到 1/100 秒）。分钟不补 0，上限 99 小时=5940 分。 */
function formatStopwatch(ms) {
  let totalCs = Math.floor(Math.max(0, ms) / 10)
  const cap = CLOCK_MAX_SEC * 100
  if (totalCs > cap) totalCs = cap
  const cs = totalCs % 100
  const secs = Math.floor(totalCs / 100)
  const s = secs % 60
  const m = Math.floor(secs / 60)
  const p = (n) => String(n).padStart(2, '0')
  return String(m).padStart(2, '0') + ':' + p(s) + ':' + p(cs)
}

/** 秒表当前经过毫秒 */
function stopwatchElapsed(now) {
  const sw = clock.stopwatch
  return sw.running ? sw.accumulated + (now - sw.base) : sw.accumulated
}

/** 计时器当前剩余毫秒 */
function timerRemaining(now) {
  const t = clock.timer
  if (!t.running) return t.remaining
  return Math.max(0, t.endAt - now)
}

/** 会话当前段剩余毫秒（未开始则返回全部） */
function sessionRemaining(now) {
  const s = clock.session
  if (!s.running) {
    if (s.remaining > 0) return s.remaining
    const slot = s.slots[s.slot]
    return slot ? slot.seconds * 1000 : 0
  }
  return Math.max(0, s.endAt - now)
}

/** 给桌宠气泡 + 面板推一条提醒 */
function clockAlert(text, big, sub, accent) {
  clockAlertSeq++
  // 只发一次：桌宠收到后只显示头顶的大框（不再同时弹小气泡）。
  // 之前这里有两次 send，等于同一条提醒推两遍。
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('pet-clock-alert', {
        text,
        big: big || '',
        sub: sub || text,
        accent: accent || '#2f6feb',
        seq: clockAlertSeq,
        at: clockNow(),
      })
    }
  } catch { /* 桌宠可能没起来 */ }
  pushClockState()
}

/** 会话：进入第 (loop, slot) 段并设定结束时间 */
function sessionArmSlot(now) {
  const s = clock.session
  const slot = s.slots[s.slot]
  if (!slot) { s.running = false; return false }
  s.endAt = now + slot.seconds * 1000
  s.remaining = 0
  return true
}

/** 会话推进到下一段；跑完所有循环就停 */
function sessionAdvance(now) {
  const s = clock.session
  const finishedSlot = s.slots[s.slot]
  clockAlert('⏱ 会话：第 ' + (s.slot + 1) + ' 段' +
    (finishedSlot && finishedSlot.label ? '「' + finishedSlot.label + '」' : '') + ' 结束',
    finishedSlot ? formatClock((finishedSlot.seconds || 0) * 1000) : '',
    '第 ' + (s.slot + 1) + ' 段结束' +
    (finishedSlot && finishedSlot.label ? '（' + finishedSlot.label + '）' : ''),
    '#2f6feb')

  s.slot++
  if (s.slot >= s.slots.length) {
    // 本轮结束
    s.slot = 0
    s.loop++
    if (s.loops > 0 && s.loop >= s.loops) {
      s.running = false
      s.remaining = 0
      clockAlert('✅ 会话全部完成（共 ' + s.loops + ' 轮）',
        String(s.loops) + ' 轮', '会话全部完成', '#1a7f37')
      return
    }
    clockAlert('🔁 进入第 ' + (s.loop + 1) + ' 轮')
  }
  if (!sessionArmSlot(now)) { s.running = false; return }
  pushClockState()
}

/** 每秒（更密一点，200ms）检查一次到点事件 */
function clockTick() {
  const now = clockNow()
  let dirty = false

  // 秒表：只处理 99 小时上限
  const sw = clock.stopwatch
  if (sw.running && stopwatchElapsed(now) >= CLOCK_MAX_SEC * 1000) {
    sw.accumulated = CLOCK_MAX_SEC * 1000
    sw.running = false
    clockAlert('秒表已达上限 99:00:00', '99:00:00', '秒表达到上限', '#2f6feb')
    dirty = true
  }

  // 计时器：到点提醒（只提醒一次）
  const t = clock.timer
  if (t.running && now >= t.endAt) {
    t.running = false
    t.remaining = 0
    clockAlert('⏰ 计时器到点：' + formatClock(t.duration * 1000),
      formatClock(t.duration * 1000), '计时器结束', '#2f6feb')
    dirty = true
  }

  // 会话：当前段到点则推进
  const s = clock.session
  if (s.running && now >= s.endAt) {
    sessionAdvance(now)
    dirty = true
  }

  // 有事件（到点/推进）必须立刻推；此外只要有任一时间在走，就每秒推一次，
  // 让面板的 00:00:00 真的在走秒，而不是等用户点按钮才刷新。
  const anyRunning =
    clock.stopwatch.running || clock.timer.running || clock.session.running ||
    // 暂停中也推几次，保证暂停那一刻的数值（剩余/累计）落到面板
    (clock.stopwatch.accumulated > 0) || (clock.timer.remaining > 0) || (clock.session.remaining > 0)
  if (dirty || (anyRunning && now - clockLastPushAt >= 900)) {
    clockLastPushAt = now
    pushClockState()
  }
}

function startClockTicker() {
  if (clockTickTimer) return
  clockTickTimer = setInterval(() => {
    try { clockTick() } catch (err) { console.error('[clock] tick failed:', err && err.message) }
  }, 200)
  if (typeof clockTickTimer.unref === 'function') clockTickTimer.unref()
}

/** 给控制面板的完整计时状态 */
function clockState() {
  const now = clockNow()
  const s = clock.session
  const slot = s.slots[s.slot]
  return {
    maxSec: CLOCK_MAX_SEC,
    mode: clock.mode,
    stopwatch: {
      running: clock.stopwatch.running,
      elapsed: stopwatchElapsed(now),
      text: formatStopwatch(stopwatchElapsed(now)),
      // 原始时间戳：面板据此在本地插值出厘秒，避免为了流畅而每秒推几十次 IPC
      base: clock.stopwatch.base,
      accumulated: clock.stopwatch.accumulated,
      laps: clock.stopwatch.laps.map((l) => ({ ...l, text: formatStopwatch(l.total), lapText: formatStopwatch(l.lap) })),
    },
    timer: {
      running: clock.timer.running,
      paused: !clock.timer.running && clock.timer.remaining > 0,
      duration: clock.timer.duration,
      remaining: clock.timer.remaining,
      text: formatClock(timerRemaining(now)),
      durationText: formatClock(clock.timer.duration * 1000),
    },
    session: {
      running: s.running,
      // 明确区分"暂停中"与"已结束/未开始"：之前 UI 拿 sessionRemaining() 的
      // 返回值判断，而它在未运行时会返回"下一段的完整时长"，于是跑完后的
      // 会话被误判成"已暂停"，界面卡在「继续/重置」回不到设置页。
      paused: !s.running && s.remaining > 0,
      slots: s.slots.map((x) => ({ ...x, text: formatClock(x.seconds * 1000) })),
      loops: s.loops,
      loop: s.loop,
      slot: s.slot,
      label: slot ? (slot.label || '第 ' + (s.slot + 1) + ' 段') : '',
      remaining: s.remaining, // 暂停时的剩余（未暂停为 0）
      text: formatClock(sessionRemaining(now)),
      totalLoopsText: s.loops === 0 ? '无限' : String(s.loops),
    },
  }
}

function pushClockState() {
  if (!menuWin || menuWin.isDestroyed()) return
  menuWin.webContents.send('clock-state', clockState())
}

/** 处理控制面板发来的计时命令 */
function handleClockCommand(cmd) {
  if (!cmd || typeof cmd !== 'object') return
  const now = clockNow()
  const type = String(cmd.type || '')
  const sw = clock.stopwatch
  const t = clock.timer
  const s = clock.session
  const clampSec = (n) => {
    const v = Math.floor(Number(n) || 0)
    if (v < 0) return 0
    return v > CLOCK_MAX_SEC ? CLOCK_MAX_SEC : v
  }

  switch (type) {
    // ---------------- 模式 ----------------
    case 'mode':
      clock.mode = cmd.mode === 'timer' || cmd.mode === 'session' ? cmd.mode : 'stopwatch'
      break

    // ---------------- 秒表 ----------------
    case 'sw-start':
      if (!sw.running) { sw.base = now; sw.running = true }
      break
    case 'sw-pause':
      if (sw.running) { sw.accumulated = stopwatchElapsed(now); sw.running = false }
      break
    case 'sw-lap': {
      const total = stopwatchElapsed(now)
      const prev = sw.laps.length > 0 ? sw.laps[0].total : 0
      sw.laps.unshift({ index: sw.laps.length + 1, total, lap: total - prev })
      if (sw.laps.length > 100) sw.laps.length = 100
      break
    }
    case 'sw-reset':
      sw.running = false; sw.base = 0; sw.accumulated = 0; sw.laps = []
      break
    case 'sw-clear-laps':
      sw.laps = []
      break

    // ---------------- 计时器 ----------------
    case 'tm-set':
      if (!t.running) t.remaining = clampSec(cmd.seconds) * 1000
      t.duration = clampSec(cmd.seconds)
      break
    case 'tm-start': {
      const secs = clampSec(cmd.seconds !== undefined ? cmd.seconds : t.duration)
      if (secs <= 0) break
      t.duration = secs
      t.endAt = now + secs * 1000
      t.remaining = 0
      t.running = true
      break
    }
    case 'tm-pause':
      if (t.running) { t.remaining = Math.max(0, t.endAt - now); t.running = false }
      break
    case 'tm-resume':
      if (!t.running && t.remaining > 0) { t.endAt = now + t.remaining; t.running = true }
      break
    case 'tm-reset':
      t.running = false; t.endAt = 0; t.remaining = 0
      break

    // ---------------- 会话 ----------------
    case 'ss-set-slots': {
      if (s.running) break
      const list = Array.isArray(cmd.slots) ? cmd.slots : []
      s.slots = list.slice(0, 20).map((x, i) => ({
        label: typeof x.label === 'string' && x.label ? x.label.slice(0, 24) : '第 ' + (i + 1) + ' 段',
        seconds: clampSec(x.seconds),
      })).filter((x) => x.seconds > 0)
      s.slot = 0; s.loop = 0; s.remaining = 0
      break
    }
    case 'ss-set-loops':
      s.loops = Math.max(0, Math.min(999, Math.floor(Number(cmd.loops) || 0)))
      break
    case 'ss-start':
      if (s.slots.length === 0) break
      s.loop = 0; s.slot = 0; s.running = true
      if (!sessionArmSlot(now)) { s.running = false; break }
      clockAlert('▶️ 会话开始：共 ' + s.slots.length + ' 段，' +
        (s.loops === 0 ? '无限循环' : s.loops + ' 轮'))
      break
    case 'ss-pause':
      if (s.running) { s.remaining = Math.max(0, s.endAt - now); s.running = false }
      break
    case 'ss-resume':
      if (!s.running && s.remaining > 0 && s.slots.length > 0) {
        s.endAt = now + s.remaining; s.running = true; s.remaining = 0
      }
      break
    case 'ss-reset':
      s.running = false; s.loop = 0; s.slot = 0; s.endAt = 0; s.remaining = 0
      break
    default:
      break
  }
  pushClockState()
}

/** Push the live state to the control panel so it re-renders. */
function pushMenuState() {
  if (!menuWin || menuWin.isDestroyed()) return
  menuWin.webContents.send('menu-state', {
    mood: currentLook.mood,
    motion: currentLook.motion,
    stopped: currentLook.stopped,
    hand: currentLook.hand,
    prop: currentLook.prop,
    gaze: gazeEnabled,
    scale,
  })
}

// ---- Live2D expression / motion catalog --------------------------------
// Read straight from the bundled model so the menu can never drift out of
// sync with what actually shipped in it.
const L2D_MODEL_DIR = path.join(__dirname, 'live2d', 'model')

/** Expression names: files are named after the expression
 *  ("问号.exp3.json" -> "问号"). */
function listExpressions() {
  try {
    return fs.readdirSync(L2D_MODEL_DIR)
      .filter((f) => /\.exp3\.json$/i.test(f))
      .map((f) => f.replace(/\.exp3\.json$/i, ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'zh'))
  } catch { return [] }
}

/** Motion display names: a few files are named in pinyin. */
const MOTION_LABELS = { chuipaopao: '吹泡泡', '自拍简单': '快速自拍' }
/** Expression display names for files with English names. */
const EXPRESSION_LABELS = { love: '比心', '喵喵手~喵~动画': '喵喵手' }

/** Hand poses and props the pet can wear. These are independent, PERSISTENT
 *  look layers: once picked (by the user or by a random idle performance) they
 *  stay until something changes them. */
const HAND_EXPRESSIONS = ['双手比耶', '喵喵手~喵~动画', '撤回', '画笔', '橡皮', '点菜按下', '挤']
const PROP_EXPRESSIONS = ['鲸鱼', '鲸鱼放桌上', '巴菲', '蛋包饭', '手机换色', '魔爪', '魔爪换色', '深色桌布', '情绪花花']

/** Tap-group motions: index (model order) + display name. */
function listMotions() {
  try {
    const m3 = JSON.parse(fs.readFileSync(path.join(L2D_MODEL_DIR, 'c_0120.model3.json'), 'utf8'))
    const tap = (m3 && m3.FileReferences && m3.FileReferences.Motions && m3.FileReferences.Motions.Tap) || []
    return tap.map((entry, index) => {
      const raw = String((entry && entry.File) || `动作${index + 1}`)
        .replace(/^motions\//, '')
        .replace(/\.motion3\.json$/i, '')
      return { index, name: MOTION_LABELS[raw] || raw }
    })
  } catch { return [] }
}

/** The model ships 44 expressions, so a flat context menu is unusable:
 *  group them the way they are actually used. */
const EXPRESSION_GROUPS = [
  { label: '👀 眼睛', names: ['星星眼', '爱心眼', '呆呆眼', '晕晕', '阴暗'] },
  { label: '💗 情绪', names: ['开心兴奋', '调皮', '脸红', '心跳', 'love', '悲伤', '哭', '生气', '闭眼口水', '吐魂'] },
  { label: '❗ 符号', names: ['问号', '感叹号', '流汗'] },
  { label: '👄 嘴部', names: ['吐舌'] },
  { label: '🕶 眼镜', names: ['圆眼镜', '方眼镜', '椭圆眼镜', '墨镜'] },
  { label: '🎀 贴纸', names: ['猫猫贴纸', '兔兔贴纸', '蝴蝶结贴纸'] },
  { label: '💇 发型', names: ['头箍', '单边马尾'] },
  { label: '✋ 手部', names: ['双手比耶', '喵喵手~喵~动画', '撤回', '画笔', '橡皮', '点菜按下', '挤'] },
  { label: '🎁 道具', names: ['鲸鱼', '鲸鱼放桌上', '巴菲', '蛋包饭', '手机换色', '魔爪', '魔爪换色', '深色桌布', '情绪花花'] },
]

function sendToPet(channel, payload) {
  if (win && !win.isDestroyed()) {
    console.log('[menu] send', channel, JSON.stringify(payload))
    win.webContents.send(channel, payload)
  } else {
    console.log('[menu] DROPPED (no live window):', channel)
  }
}
/** Pin a face on the pet (null = let the state machine drive it again). */
function applyExpression(name) {
  console.log('[menu] applyExpression ->', name)
  sendToPet('pet-expression', { name: name || null })
}
/** Play one Tap motion once (null = stop and return to idle). The display
 *  name is resolved here so the renderer can show a readable confirmation. */
function applyMotion(index) {
  if (index === null || index === undefined) {
    sendToPet('pet-motion', { index: null, name: null })
    return
  }
  console.log('[menu] applyMotion ->', index)
  const hit = listMotions().find((m) => m.index === index)
  sendToPet('pet-motion', { index, name: hit ? hit.name : `#${index}` })
}

/** Pin a hand pose (null = bare hands). */
function applyHand(name) {
  console.log('[menu] applyHand ->', name)
  sendToPet('pet-hand', { name: name || null })
}
/** Pin a prop (null = nothing held). */
function applyProp(name) {
  console.log('[menu] applyProp ->', name)
  sendToPet('pet-prop', { name: name || null })
}

/** Build a submenu for one persistent layer (hand / prop). */
function layerMenuItems(list, apply) {
  const available = listExpressions()
  const names = list.filter((n) => available.includes(n))
  if (names.length === 0) return [{ label: '（模型没有该部位的资源）', enabled: false }]
  const items = [{ label: '无', click: () => apply(null) }, { type: 'separator' }]
  for (const n of names) items.push({ label: EXPRESSION_LABELS[n] || n, click: () => apply(n) })
  return items
}

function expressionMenuItems() {
  const all = listExpressions()
  if (all.length === 0) return [{ label: '（未找到模型表情）', enabled: false }]
  const labelOf = (n) => EXPRESSION_LABELS[n] || n
  // Radio items so the menu shows what is currently pinned.
  const items = [{
    label: '无（跟随状态自动切换）',
    click: () => applyExpression(null),
  }, { type: 'separator' }]
  const used = new Set()
  for (const group of EXPRESSION_GROUPS) {
    const names = group.names.filter((n) => all.includes(n))
    names.forEach((n) => used.add(n))
    if (names.length > 0) {
      items.push({
        label: group.label,
        submenu: names.map((n) => ({
          label: (currentLook.mood === n ? '✓ ' : '') + labelOf(n),
          click: () => applyExpression(n),
        })),
      })
    }
  }
  const rest = all.filter((n) => !used.has(n))
  if (rest.length > 0) {
    items.push({ type: 'separator' }, {
      label: '📦 其他',
      submenu: rest.map((n) => ({
        label: (currentLook.mood === n ? '✓ ' : '') + labelOf(n),
        click: () => applyExpression(n),
      })),
    })
  }
  return items
}

function motionMenuItems() {
  const motions = listMotions()
  // A plain item, NOT a radio: with nothing selected the menu shows no dot at
  // all, so nothing looks "chosen" by default.
  const items = [{ label: '停止（回到待机）', click: () => applyMotion(null) }]
  if (motions.length > 0) {
    items.push({ type: 'separator' })
    for (const m of motions) {
      items.push({
        label: (currentLook.motion === m.index ? '✓ ' : '') + m.name,
        click: () => applyMotion(m.index),
      })
    }
  }
  return items
}

/**
 * Restart the dsh web service: kill whatever listens on :3080, then relaunch
 * it hidden (same command the one-click VBS launcher uses: node dsh bin.js
 * --profile web). The pet window is a separate Electron process and keeps
 * running; its poll loop reconnects once the service is back up.
 */
function restartDshWeb() {
  execFile('netstat', ['-ano'], { windowsHide: true }, (err, stdout) => {
    if (err) return
    const pid = findListenerPid(stdout, 3080)
    if (pid) {
      try { process.kill(pid) } catch { /* already gone */ }
    }
    // Wait for the port to free, then relaunch.
    const waitUntilFree = (tries) => {
      if (tries <= 0) { launchDshWeb(); return }
      execFile('netstat', ['-ano'], { windowsHide: true }, (err2, out2) => {
        if (findListenerPid(out2, 3080) === null) { launchDshWeb(); return }
        setTimeout(() => waitUntilFree(tries - 1), 300)
      })
    }
    waitUntilFree(10)
  })
}

/** Extract the PID listening on a TCP port from `netstat -ano` output. */
function findListenerPid(netstatOut, port) {
  for (const line of String(netstatOut).split(/\r?\n/)) {
    const m = /TCP\s+\S+?:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
    if (m && Number(m[1]) === port) return Number(m[2])
  }
  return null
}

/** Launch dsh web hidden (no console window), like the VBS one-click launcher. */
function launchDshWeb() {
  const env = { ...process.env, PATH: `${PNPM_DIR};${process.env.PATH || ''}` }
  const child = spawn(NODE_EXE, [DSH_BIN, '--profile', 'web'], {
    cwd: __dirname,
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  // Reconnect the embedded web window to the fresh instance once it is up.
  const waitUp = (tries) => {
    if (tries <= 0) return
    fetch(STATE_URL, { signal: AbortSignal.timeout(2000) })
      .then((r) => { if (r.ok && webWin && !webWin.isDestroyed()) webWin.loadURL(BASE) })
      .catch(() => setTimeout(() => waitUp(tries - 1), 1000))
  }
  waitUp(20)
}

/** Reveal the pet window and bring it forward (used by tray click). */
function showPetWindow() {
  if (!win || win.isDestroyed()) return
  win.show()
  win.focus()
}

/**
 * System tray (taskbar-hiding companion):
 *  - pet window uses skipTaskbar, so it never occupies the taskbar
 *  - the tray icon owns the app lifecycle: show/hide pet, open web GUI
 *    (embedded window or system browser), and quit
 *  - single left-click on the tray icon toggles the pet; right-click opens
 *    the context menu; double-click opens the embedded DSH web window
 */


function createTray() {
  if (tray) return
  let iconPath = path.join(__dirname, 'tray.png')
  if (!fs.existsSync(iconPath)) iconPath = path.join(__dirname, 'tray.ico')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('鲸鱼娘 · DeepSeek Harness 桌宠')
  // No setContextMenu: that would swallow right-click. The tray opens the same
  // control panel as the pet's right-click instead.
  tray.on('click', () => togglePetWindow())
  tray.on('right-click', () => openMenuWindow())
  tray.on('double-click', () => {
    showPetWindow()
    toggleWeb()
  })
}

// ---- size presets (B2): right-click menu with radio items, persisted ----
function setScale(next) {
  scale = next
  saveScale(next)
  applyWindowSize()
}

const MENU_W = 400
const MENU_H = 520



/**
 * Open (or focus) the control panel — a real window with category tabs on top,
 * a scrollable body and an explicit 退出 button. It deliberately never closes
 * by itself: no blur handler, no auto-hide, so a click elsewhere cannot dismiss
 * it while you are choosing something. Only ✕ / 退出 closes it.
 */
function openMenuWindow() {
  if (menuWin && !menuWin.isDestroyed()) {
    menuWin.show()
    menuWin.focus()
    pushMenuState()
    return
  }
  // Place it near the cursor but fully inside the current display's work area.
  let x = 0
  let y = 0
  try {
    const pt = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(pt).workArea
    x = Math.round(pt.x - 60)
    y = Math.round(pt.y - 60)
    if (x + MENU_W > wa.x + wa.width) x = wa.x + wa.width - MENU_W
    if (y + MENU_H > wa.y + wa.height) y = wa.y + wa.height - MENU_H
    if (x < wa.x) x = wa.x
    if (y < wa.y) y = wa.y
  } catch { /* fall back to the default position */ }

  menuWin = new BrowserWindow({
    width: MENU_W,
    height: MENU_H,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Created on top. NOTE: setAlwaysOnTop(true) has no effect at runtime on
    // Windows (only this constructor option does), so the panel must be born
    // pinned — and the pet is deliberately left alone.
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: false,
      preload: path.join(__dirname, 'menu-preload.cjs'),
      backgroundThrottling: false,
    },
  })
  menuWin.loadFile(path.join(__dirname, 'renderer', 'menu.html'))
  // Bring it to the front once it has something to show.
  menuWin.once('ready-to-show', () => {
    if (!menuWin || menuWin.isDestroyed()) return
    // NOTE: never call moveTop() — on Windows it clears WS_EX_TOPMOST.
    menuWin.show()
    menuWin.focus()
    // Same workaround as the pet window: clear then set at 'screen-saver',
    // a moment after showing. Focus makes it sit in front of the pet, and
    // because both are topmost the panel can never be buried again.
    const assertPin = () => {
      if (!menuWin || menuWin.isDestroyed()) return
      menuWin.setAlwaysOnTop(false)
      menuWin.setAlwaysOnTop(true, 'screen-saver')
    }
    setTimeout(assertPin, 300)
    setTimeout(assertPin, 1500)
    setTimeout(() => menuWin && !menuWin.isDestroyed() && menuWin.focus(), 400)
  })
  menuWin.on('closed', () => { menuWin = null })
  console.log('[menu] control panel opened')
}

/** Legacy entry point (the renderer's right-click still calls this). */
function showMenu() {
  console.log('[menu] showMenu called (win=' + (win && !win.isDestroyed() ? 'ok' : 'null') + ')')
  if (!win || win.isDestroyed()) return
  openMenuWindow()
}



// ---- IPC (renderer -> main) ----
ipcMain.on('pet-toggle-web', toggleWeb)
ipcMain.on('pet-menu', showMenu)
// ---- control panel -------------------------------------------------------
ipcMain.handle('menu-data', () => {
  const all = listExpressions()
  const groups = EXPRESSION_GROUPS
    .map((g) => ({ label: g.label, names: g.names.filter((n) => all.includes(n)) }))
    .filter((g) => g.names.length > 0)
  const used = new Set()
  for (const g of groups) for (const n of g.names) used.add(n)
  const rest = all.filter((n) => !used.has(n))
  if (rest.length > 0) groups.push({ label: '📦 其他', names: rest })
  return {
    expressionGroups: groups,
    motions: listMotions(),
    handExpressions: HAND_EXPRESSIONS.filter((n) => all.includes(n)),
    propExpressions: PROP_EXPRESSIONS.filter((n) => all.includes(n)),
    scales: SCALE_PRESETS,
    clock: clockState(),
    state: {
      mood: currentLook.mood,
      motion: currentLook.motion,
      stopped: currentLook.stopped,
      hand: currentLook.hand,
      prop: currentLook.prop,
      gaze: gazeEnabled,
      scale,
    },
  }
})

ipcMain.handle('clock-state', () => clockState())

ipcMain.on('clock-cmd', (_event, cmd) => {
  try { handleClockCommand(cmd) } catch (err) { console.error('[clock] command failed:', err && err.message) }
})

ipcMain.on('menu-close', () => {
  if (menuWin && !menuWin.isDestroyed()) menuWin.close()
})

// "退出" on the panel quits the whole application. isQuitting has to be set
// first: the pet window's close handler otherwise prevents the close and just
// hides the window to the tray, so app.quit() would never finish.
ipcMain.on('app-quit', () => {
  console.log('[menu] quit requested from the control panel')
  isQuitting = true
  app.quit()
})

ipcMain.on('menu-cmd', (_event, command) => {
  if (!command || typeof command !== 'object') return
  switch (command.type) {
    case 'feed': postInteract('feed'); break
    case 'play': postInteract('play'); break
    case 'pet':
      // a head-pat: the same transient the renderer uses for interactions
      if (win && !win.isDestroyed()) win.webContents.send('pet-interact-result', { action: 'feed', reply: '摸摸头～' })
      break
    case 'idleShow': sendToPet('pet-idle-show', {}); break
    case 'expression': applyExpression(command.name); break
    case 'motion': applyMotion(command.index); break
    case 'hand': applyHand(command.name); break
    case 'prop': applyProp(command.name); break
    case 'scale': setScale(command.value); pushMenuState(); break
    case 'gaze': setGaze(command.value); break
    case 'openWeb': toggleWeb(); break
    case 'openBrowser': openInBrowser(); break
    case 'marketplace': openMarketplace(); break
    case 'pluginsDir': openPluginsDir(); break
    case 'pluginsRepo': openPluginsRepo(); break
    case 'restartDsh': restartDshWeb(); break
    case 'togglePet': togglePetWindow(); break
    default: break
  }
})

ipcMain.on('pet-look', (_event, state) => {
  if (state && typeof state === 'object') {
    currentLook = {
      mood: typeof state.mood === 'string' ? state.mood : null,
      motion: typeof state.motion === 'number' ? state.motion : null,
      stopped: state.stopped === true,
      hand: typeof state.hand === 'string' ? state.hand : null,
      prop: typeof state.prop === 'string' ? state.prop : null,
    }
    pushMenuState()
  }
})
ipcMain.on('pet-interact', (_event, action) => {
  if (action === 'feed' || action === 'play') postInteract(action)
})

/**
 * Clamp a window position so the ENTIRE window stays inside the display work
 * area the window currently sits on. The pet can never leave the screen, no
 * matter how the cursor is dragged.
 */
function clampToWorkArea(x, y) {
  // Use the real window size; when called before the window exists (startup
  // positioning) fall back to the computed metrics, NOT the bare stage size —
  // the stage is smaller than the window, which would let the window escape.
  let w, h
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    w = b.width
    h = b.height
  } else {
    const m = windowMetrics()
    w = m.w
    h = m.h
  }
  const bounds = { x, y, width: w, height: h }
  const wa = screen.getDisplayMatching(bounds).workArea
  const cx = Math.min(Math.max(x, wa.x), wa.x + wa.width - w)
  const cy = Math.min(Math.max(y, wa.y), wa.y + wa.height - h)
  return { x: cx, y: cy }
}

// ---- drag tracking ----
// The renderer arms the drag (mousedown) and disarms it (mouseup); the main
// process then POLLS the cursor at 60fps while dragging. This is required
// because once the window follows the cursor, the cursor stops moving
// relative to the window, Chromium stops firing mousemove, and an
// event-driven drag stalls mid-screen. Polling with absolute-position math
// (window origin + cursor delta, all DIP) is direction-correct and immune to
// both display scaling and feedback loops. Zero movement is guaranteed when
// the cursor is still: the target equals the current position, so
// setPosition is a no-op (verified: getCursorScreenPoint is stable to the
// pixel when the mouse does not move).
let dragTimer = null
function stopDragPoll() {
  if (dragTimer !== null) {
    clearInterval(dragTimer)
    dragTimer = null
  }
}
ipcMain.on('pet-drag-start', () => {
  if (!win || win.isDestroyed()) return
  stopDragPoll()
  const cursor = screen.getCursorScreenPoint()
  dragState = {
    winX: win.getPosition()[0],
    winY: win.getPosition()[1],
    mouseX: cursor.x,
    mouseY: cursor.y,
  }
  dragTimer = setInterval(() => {
    if (!dragState || !win || win.isDestroyed()) {
      stopDragPoll()
      return
    }
    const cursorNow = screen.getCursorScreenPoint()
    const target = clampToWorkArea(
      dragState.winX + (cursorNow.x - dragState.mouseX),
      dragState.winY + (cursorNow.y - dragState.mouseY),
    )
    const [curX, curY] = win.getPosition()
    if (Math.round(target.x) !== curX || Math.round(target.y) !== curY) {
      win.setPosition(Math.round(target.x), Math.round(target.y))
    }
  }, 16) // ~60fps; a still cursor is a no-op every tick
})
ipcMain.on('pet-drag-move', () => {
  // No-op: the poll loop owns movement. Kept so the renderer's mousemove
  // signal is harmless.
})
ipcMain.on('pet-drag-end', () => {
  dragState = null
  stopDragPoll()
  // The drag may have skipped a pending bubble resize (see pollSessions);
  // settle the window size now that the user released the pet.
  applyWindowSize()
})

function createWindow() {
  scale = loadScale()
  const { w, h } = windowMetrics()
  const pos = loadPos()
  let x = pos?.x
  let y = pos?.y
  if (x === undefined || y === undefined) {
    // First run: bottom-right of the primary display.
    const work = screen.getPrimaryDisplay().workArea
    x = work.x + work.width - w - 16
    y = work.y + work.height - h - 16
  } else {
    // A persisted position must never put the pet off-screen (an old drag bug
    // once saved y=-925). Clamp to the work area so the pet is always reachable.
    const clamped = clampToWorkArea(x, y)
    x = clamped.x
    y = clamped.y
  }
  win = new BrowserWindow({
    width: w,
    height: h,
    x,
    y,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    skipTaskbar: true, // live in the tray, not the taskbar
    webPreferences: {
      // contextIsolation off so the preload can expose `window.pet` in the same
      // world as the renderer (callback crossing through contextBridge proved
      // unreliable here). The app loads only local files; the renderer only
      // talks to loopback DSH.
      contextIsolation: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // The Live2D model (model3.json / moc3 / textures) is fetched with XHR,
      // which a file:// page cannot do under the default same-origin policy.
      // Everything loaded here is local and ships with the app, so relaxing it
      // is what lets the Live2D renderer read its own assets.
      webSecurity: false,
      // Without this Chromium freezes requestAnimationFrame whenever the pet
      // window loses focus, which stops the PIXI ticker entirely: no idle
      // performances, no motion looping, no gaze smoothing.
      backgroundThrottling: false,
    },
  })
  // Closing the pet window hides it to the tray instead of quitting the app.
  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    win.hide()
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => {
    // The renderer starts at the default stage; resend the persisted scale
    // once the page is up so canvas CSS + backing store match the window.
    win.webContents.send('pet-scale', { stage: stageSize() })
    // WORKAROUND (verified experimentally on Windows): only the 'screen-saver'
    // level actually sets WS_EX_TOPMOST. The constructor's alwaysOnTop option,
    // setAlwaysOnTop(true), setAlwaysOnTop(true, 'floating') and a false->true
    // toggle were ALL silently ignored — the window never became topmost.
    // It also has to be re-asserted a moment later: issuing it while the window
    // is still settling is ignored too.
    const assertPin = () => {
      if (!win || win.isDestroyed()) return
      // Clear first, then set: in the experiment the ONLY successful sequence
      // was setAlwaysOnTop(false) followed by setAlwaysOnTop(true,'screen-saver').
      win.setAlwaysOnTop(false)
      win.setAlwaysOnTop(true, 'screen-saver')
    }
    setTimeout(assertPin, 2000)
    setTimeout(assertPin, 6000)
  })
  if (screenshotFlag || process.argv.includes('--dev')) {
    win.webContents.on('console-message', (_event, _level, message) => console.log('[renderer]', message))
  }
  win.on('move', () => {
    try { const [px, py] = win.getPosition(); savePos({ x: px, y: py }) } catch { /* non-fatal */ }
  })
  win.on('closed', () => {
    stopCursorTracking()
    win = null
  })
  startCursorTracking()
  return win
}

const screenshotFlag = process.argv.find((arg) => arg.startsWith('--screenshot='))
const screenshotDelayArg = process.argv.find((arg) => arg.startsWith('--screenshot-delay='))
const screenshotDelay = screenshotDelayArg ? Number(screenshotDelayArg.slice('--screenshot-delay='.length)) : 5000
// Debug: shorten the renderer idle→sleep threshold for fast sleep-capture tests
// (e.g. --sleep-after=8000). Forwarded over IPC once the page is up.
const sleepAfterArg = process.argv.find((arg) => arg.startsWith('--sleep-after='))
const sleepAfterMs = sleepAfterArg ? Number(sleepAfterArg.slice('--sleep-after='.length)) : null
// Debug: --web-shot=<path> opens the embedded DSH web window, waits for it to
// load, captures it to <path> and quits — verifies B1 without a manual click.
const webShotFlag = process.argv.find((arg) => arg.startsWith('--web-shot='))

// Debug: --interact-test triggers one feed interaction after load so screenshots
// capture the eat animation + reply bubble + joy without a manual menu click.
const interactTestFlag = process.argv.includes('--interact-test')

app.whenReady().then(() => {
  createWindow()
  createTray() // system tray: the app's home (taskbar-free)
  startClockTicker() // 计时器：200ms 检查一次到点事件










  heartbeatLoop()
  pollLoop()
  if (win) {
    win.webContents.on('did-finish-load', () => {
      const debug = {}
      if (sleepAfterMs !== null && sleepAfterMs > 0) debug.sleepAfterMs = sleepAfterMs
      if (interactTestFlag) debug.interactTest = true
      if (Object.keys(debug).length > 0) win.webContents.send('pet-debug', debug)
    })
  }
  if (webShotFlag) {
    setTimeout(async () => {
      try {
        const w = ensureWebWin()
        w.show()
        w.focus()
        await new Promise((resolve) => {
          if (w.webContents.isLoading()) w.webContents.once('did-finish-load', resolve)
          else resolve()
        })
        await new Promise((resolve) => setTimeout(resolve, 6000)) // let the GUI paint a frame
        const image = await w.webContents.capturePage()
        fs.writeFileSync(webShotFlag.slice('--web-shot='.length), image.toPNG())
        console.log('[dsh-whale-pet] web-shot saved')
      } catch (error) {
        console.error('[dsh-whale-pet] web-shot failed:', error.message)
      }
      app.quit()
    }, 4000)
  }
  if (screenshotFlag) {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage()
        fs.writeFileSync(screenshotFlag.slice('--screenshot='.length), image.toPNG())
        console.log('[dsh-whale-pet] screenshot saved')
      } catch (error) {
        console.error('[dsh-whale-pet] screenshot failed:', error.message)
      }
      app.quit()
    }, screenshotDelay)
  }
})

app.on('before-quit', () => {
  isQuitting = true
  pokePresence(false)
})
// Tray-owned lifecycle: closing the pet window hides it (see win.on('close'));
// the app only truly exits from the tray menu, so never quit on window-all-closed.
app.on('window-all-closed', () => { /* stay in the tray */ })
