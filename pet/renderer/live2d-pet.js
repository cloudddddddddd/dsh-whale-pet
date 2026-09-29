/**
 * Live2D rendering module for whale-girl-desktop.
 *
 * Renders the DS 鲸鱼娘 Live2D model as the pet's character, replacing the
 * sprite-sheet renderer while keeping every existing feature (tray menu, drag,
 * bubbles, DSH restart, NovelAI viewer) intact — the state machine in
 * renderer.js still owns behaviour; this module only turns a state name into
 * a face + motion.
 *
 * Design notes (learned from a mature implementation):
 *  - Faces are written STRAIGHT into model parameters, not via
 *    model.expression(): that API is async (rapid state changes land out of
 *    order) and additive (clearing one does not undo it). Direct synchronous
 *    writes are race-free and undo exactly.
 *  - The write is re-asserted every frame AFTER internalModel.update(), which
 *    is the only order that outranks the motion curves' own parameter writes.
 *  - Motions rotate through a per-state pool: a pet that loops one clip for
 *    minutes reads as broken, not busy.
 *
 * Exposes window.PetLive2D:
 *   init(modelUrl) -> Promise<boolean>   load engine + model
 *   setState(name)                       switch state (face + motion pool)
 *   isReady() / isFailed()
 *   layout()                             re-fit after a stage resize
 *   setVariant(n)                        strip clothes variant (0/1)
 *   destroy()
 */
(function () {
  'use strict'

  let app = null
  let model = null
  let ready = false
  let failed = false
  let initPromise = null

  let curState = 'idle'
  // ---- gaze (eyes + head follow the mouse) --------------------------------
  // The cursor position arrives from the MAIN process (the pet window is tiny,
  // so the pointer is almost always outside it and a DOM listener would never
  // fire). Targets are smoothed here and written into the model after every
  // motion update, so the look never fights the animation.
  let gazeOn = true
  let gazeTargetX = 0
  let gazeTargetY = 0
  let gazeCurX = 0
  let gazeCurY = 0
  const GAZE_LERP = 0.14          // smoothing factor per frame
  // If the pointer has not moved for this long, the pet stops staring and
  // eases back to facing straight ahead.
  const GAZE_RECENTER_AFTER_MS = 8000
  let lastCursorMoveAt = 0
  const GAZE_YAW = 30             // head yaw range (degrees)
  const GAZE_PITCH = 26           // head pitch range
  const GAZE_ROLL = 8             // head roll from horizontal offset
  const GAZE_BODY_X = 7           // body follows a little
  const GAZE_BODY_Y = 4

  /** Feed a cursor sample from the main process (screen coordinates). */
  function setCursor(p) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return
    // A heartbeat (moved === false) means the pointer is parked: do NOT touch
    // the target, otherwise the recentre below is undone on every heartbeat
    // and the pet oscillates forever between the mouse and straight ahead.
    if (p.moved === false) return
    lastCursorMoveAt = performance.now()
    // Approximate screen position of the character's head: the model is
    // bottom-centred in the window, head somewhere in the upper part of the
    // stage box.
    const stage = typeof p.stage === 'number' && p.stage > 0 ? p.stage : 220
    // Anchor on the middle of the CHARACTER box (not the whole window, which
    // also contains the bubble strip): pointing at the pet means looking
    // straight ahead, which is what the user expects.
    const anchorX = p.winX + p.winW / 2
    const anchorY = p.winY + p.winH - stage * 0.5
    // "Field of view": larger = the pet turns less for the same distance.
    // Vertical is deliberately tighter so up/down feels as responsive as
    // left/right (the screen is wider than tall).
    const rangeX = Math.max(300, p.winW * 2.2)
    const rangeY = Math.max(260, p.winH * 1.6)
    const nx = (p.x - anchorX) / rangeX * 1.7
    const ny = (p.y - anchorY) / rangeY * 1.4
    gazeTargetX = nx < -1 ? -1 : (nx > 1 ? 1 : nx)
    gazeTargetY = ny < -1 ? -1 : (ny > 1 ? 1 : ny)
  }

  /** Enable / disable tracking; recentres the face when switched off. */
  function setGazeEnabled(on) {
    gazeOn = !!on
    if (!gazeOn) {
      gazeTargetX = 0
      gazeTargetY = 0
    }
  }

  /** Smooth the gaze toward its target (called once per frame). */
  function tickGaze() {
    if (!ready || !model) return
    // Cursor parked for a while -> ease the target back to dead centre so she
    // looks straight ahead instead of freezing on the last position.
    if (lastCursorMoveAt > 0 && performance.now() - lastCursorMoveAt > GAZE_RECENTER_AFTER_MS) {
      gazeTargetX *= 0.92
      gazeTargetY *= 0.92
      if (Math.abs(gazeTargetX) < 0.01) gazeTargetX = 0
      if (Math.abs(gazeTargetY) < 0.01) gazeTargetY = 0
    }
    gazeCurX += (gazeTargetX - gazeCurX) * GAZE_LERP
    gazeCurY += (gazeTargetY - gazeCurY) * GAZE_LERP
  }

  /** Write the gaze parameters (called after the model's own update). */
  function applyGaze() {
    if (!gazeOn) return
    setParam('ParamEyeBallX', gazeCurX)
    setParam('ParamEyeBallY', -gazeCurY)     // screen Y grows downward
    setParam('ParamAngleX', gazeCurX * GAZE_YAW)
    setParam('ParamAngleY', -gazeCurY * GAZE_PITCH)
    setParam('ParamAngleZ', -gazeCurX * GAZE_ROLL)
    setParam('ParamBodyAngleX', gazeCurX * GAZE_BODY_X)
    setParam('ParamBodyAngleY', -gazeCurY * GAZE_BODY_Y)
  }

  // ---- idle "fidget" show -------------------------------------------------
  // While the agent has nothing to do the pet occasionally performs a random
  // face + motion for a few seconds, then returns to its default look. It never
  // touches a look the user pinned by hand, and it aborts the moment real work
  // starts.
  const IDLE_SHOW_MIN_WAIT_MS = 18000   // shortest gap between performances
  const IDLE_SHOW_MAX_WAIT_MS = 50000   // longest gap
  const IDLE_SHOW_MIN_MS = 3000         // shortest performance
  const IDLE_SHOW_MAX_MS = 5500         // longest performance
  // Faces that read as "she is doing something cute", deliberately excluding
  // props / outfits (glasses, stickers, tablecloth, whale ...) which look like
  // a glitch when they appear unbidden.
  const IDLE_SHOW_EXPRESSIONS = [
    '开心兴奋', '调皮', '星星眼', '爱心眼', '脸红', '心跳',
    '问号', '感叹号', '流汗', '吐舌', '闭眼口水', '晕晕', '呆呆眼', '吐魂',
  ]
  // Hand poses for a random performance. 喵喵手~喵~动画 is excluded: it is a long
  // looping clip, so the short performance window cuts it off mid-pose and the
  // hand ends up looking wrong.
  const IDLE_SHOW_HANDS = ['双手比耶', '撤回', '画笔', '橡皮', '点菜按下', '挤']
  // Props for a random performance. Anything that alters the DESK is excluded
  // (深色桌布 / 巴菲 / 蛋包饭 / 鲸鱼放桌上 / 桌面粉魔爪), as is 情绪花花 (another
  // long looping clip). What is left only affects the character herself.
  // 手机换色 is gone too: it only recolours the phone, so the change reads as a
  // flicker that reverts the moment the performance ends. What is left is a prop
  // with a clear, self-contained visual (the little whale on her head).
  const IDLE_SHOW_PROPS = ['鲸鱼']
  let tickCount = 0
  let tickErrors = 0
  let idleShowActive = false
  let idleShowUntil = 0
  let idleShowNextAt = 0
  let lastIdleShowMotion = null

  let manualExpr = null       // user-pinned face (null = states drive it)
  let manualMotionIdx = null  // user-picked motion (null = none pinned)
  let suspendedMotionIdx = null // pinned motion parked during a feed/play
  let motionStopped = false   // user pressed "停止（回到待机）"
  let motionPool = null       // array of Tap indices, or null
  let motionIdx = 0
  let motionDueAt = 0
  let motionInterval = 3.2

  // ---------------------------------------------------------------- faces
  // Real emotions are written into the model's own parameters. Every
  // ParamCheek* / Paramhh* below is a CUSTOM parameter of this model whose
  // rest value is 0; the stock parameters that appear are listed in
  // STOCK_REST with their real rest values so a face can be removed cleanly.
  const STOCK_REST = {
    ParamEyeLOpen: 1, ParamEyeROpen: 1,
    ParamEyeBallX: 0, ParamEyeBallY: 0,
    ParamBrowLX: 0, ParamBrowLY: 0, ParamBrowLAngle: 0, ParamBrowLForm: 0,
    ParamBrowRX: 0, ParamBrowRY: 0, ParamBrowRAngle: 0, ParamBrowRForm: 0,
    ParamMouthForm: 0, ParamMouthOpenY: 0,
  }

  // Expression definitions are loaded at init from the model's own .exp3.json
  // files (all 44 of them, parameters and blend modes included). This tiny
  // fallback only covers the core emotions if those files cannot be read.
  const EXPR_FALLBACK = {
    '问号': { ParamCheek74: 1 },
    '呆呆眼': { ParamCheek20: 1 },
    '流汗': { ParamCheek19: 1 },
    '开心兴奋': {
      ParamCheek76: 1, ParamEyeLOpen: 0, ParamEyeROpen: 0,
      ParamBrowLX: -1, ParamBrowLY: -0.8, ParamBrowLAngle: -1,
      ParamBrowRX: -1, ParamBrowRY: -0.8, ParamBrowRAngle: -1, ParamMouthForm: 1,
    },
    '晕晕': {
      ParamCheek77: 1, ParamEyeLOpen: -0.5, ParamEyeROpen: -0.5,
      ParamBrowLForm: 1, ParamBrowRForm: 1,
    },
    '星星眼': { ParamCheek16: 1 },
    '爱心眼': {
      ParamCheek17: 1, Paramhh2: 1,
      ParamBrowLY: -0.3, ParamBrowLAngle: 0.2,
      ParamBrowRY: -0.3, ParamBrowRAngle: 0.2,
    },
    '脸红': { Paramhh2: 1 },
    '闭眼口水': { ParamCheek22: 1 },
    '吐魂': { ParamCheek18: 1 },
    '调皮': { ParamCheek21: 1, ParamEyeROpen: -1, ParamMouthForm: 1.5 },
  }

  /** Per-Tap-motion duration in seconds (from the model's Meta.Duration), so
   *  a short clip (喷水 is 0.47s) loops promptly instead of every ~3s. */
  let motionDurations = []

  /** name -> [{ id, value, blend }] loaded from the model at init. */
  let exprDefs = null

  // The look is built from THREE independent layers, applied in this order so a
  // later layer wins on conflicting parameters:
  //   prop   (鲸鱼 / 蛋包饭 / 魔爪 ...)   - sticks around
  //   hand   (双手比耶 / 画笔 / 橡皮 ...) - sticks around
  //   mood   (星星眼 / 脸红 / 流汗 ...)   - the temporary performance face
  // Mood is cleared when a performance ends; prop and hand deliberately stay,
  // so the pet keeps whatever it picked up.
  let moodExpr = null
  let handExpr = null
  let propExpr = null
  /** Parameters the last applied look wrote (they get reset on restyle). */
  let appliedLookIds = []
  /** Cached {id, value} pairs re-written every frame. */
  let lookWrites = []
  /** Ids the layer stack currently owns (these are NOT suppressed). */
  let lookOwnedIds = new Set()

  /** Read every expression the model declares (model3.json -> exp3.json). */
  async function loadExpressionDefs(modelDir) {
    const defs = {}
    try {
      const res = await fetch(`${modelDir}/c_0120.model3.json`)
      const m3 = await res.json()
      const list = (m3 && m3.FileReferences && m3.FileReferences.Expressions) || []
      for (const entry of list) {
        if (!entry || !entry.Name || !entry.File) continue
        try {
          const defRes = await fetch(`${modelDir}/${entry.File}`)
          const def = await defRes.json()
          const params = (def && def.Parameters) || []
          defs[entry.Name] = params.map((p) => ({
            id: p.Id,
            value: Number(p.Value) || 0,
            blend: p.Blend || 'Add',
          }))
        } catch (e) { /* skip a single unreadable expression */ }
      }
    } catch (e) { /* fall back to the hard-coded core below */ }
    for (const name in EXPR_FALLBACK) {
      if (!defs[name]) {
        defs[name] = Object.entries(EXPR_FALLBACK[name]).map(([id, value]) => ({ id, value, blend: 'Add' }))
      }
    }
    return defs
  }

  /** Read the Tap motion durations so the loop cadence can match the clip. */
  async function loadMotionDurations(modelDir) {
    const out = []
    try {
      const res = await fetch(`${modelDir}/c_0120.model3.json`)
      const m3 = await res.json()
      const tap = (m3 && m3.FileReferences && m3.FileReferences.Motions && m3.FileReferences.Motions.Tap) || []
      for (const entry of tap) {
        let dur = 3
        try {
          const defRes = await fetch(`${modelDir}/${entry.File}`)
          const def = await defRes.json()
          if (def && def.Meta && typeof def.Meta.Duration === 'number') dur = def.Meta.Duration
        } catch (e) { /* keep the default */ }
        out.push(dur)
      }
    } catch (e) { /* empty table -> fall back to the state interval */ }
    return out
  }

  /** The model's own rest value for a parameter (Cubism knows it; STOCK_REST
   *  covers the handful the fallback face touches). */
  function paramDefault(id) {
    const cm = coreModel()
    if (cm && typeof cm.getParameterDefaultValueById === 'function') {
      try {
        const v = cm.getParameterDefaultValueById(id)
        if (typeof v === 'number' && isFinite(v)) return v
      } catch (e) { /* ignore */ }
    }
    return Object.prototype.hasOwnProperty.call(STOCK_REST, id) ? STOCK_REST[id] : 0
  }

  // ------------------------------------------------------- state -> look
  // motion = index (or pool) in the model's "Tap" group:
  //   0 吹泡泡 5s   1 喷水 0.5s   2 开盖 1s
  //   3 番茄酱 5s   4 自拍 3.3s   5 自拍简单 1.3s
  // A face is NEVER derived from a motion, so the face holds steady while the
  // body acts. Long states get a pool; moments play one clip and rest.
  const STATE_MAP = {
    // core states
    idle: { expr: null, motion: null, interval: 3.2 },
    drag: { expr: '晕晕', motion: null, interval: 3.0 },
    wait: { expr: '问号', motion: null, interval: 3.6 },
    celebrate: { expr: '开心兴奋', motion: [4, 4, 5], interval: 3.4 },
    working: { expr: '流汗', motion: [0, 0, 2], interval: 2.4 },
    think: { expr: '呆呆眼', motion: null, interval: 4.0 },
    joy: { expr: '星星眼', motion: [5, 5], interval: 3.6 },
    sleep: { expr: '闭眼口水', motion: null, interval: 5.0 },
    walk: { expr: '调皮', motion: null, interval: 3.0 },
    wake: { expr: '呆呆眼', motion: null, interval: 3.0 },
    eat: { expr: '爱心眼', motion: [3, 1], interval: 3.2 },
    play: { expr: '调皮', motion: [4, 4, 5], interval: 3.0 },
    error: { expr: '晕晕', motion: [1], interval: 4.0 },
    // server-driven extras (fall back to sensible looks)
    reading: { expr: '呆呆眼', motion: null, interval: 4.4 },
    writing: { expr: '调皮', motion: [5, 5, 2], interval: 3.0 },
    running: { expr: '流汗', motion: [0, 0, 2], interval: 2.4 },
    searching: { expr: '星星眼', motion: [5, 5], interval: 4.0 },
    planning: { expr: '感叹号', motion: [2, 2, 5], interval: 3.0 },
    proud: { expr: '爱心眼', motion: [4, 4, 5], interval: 3.6 },
    struggling: { expr: '脸红', motion: [3, 1], interval: 4.2 },
    hype: { expr: '星星眼', motion: [4, 4], interval: 3.0 },
  }

  // The model's own idle animation is BUSY: it drives ~89 parameters, including
  // hand poses (maoshou2..7) and a dozen prop show/hide+size groups (j2..j57),
  // sparkles (Param73..77) and mouth bubbles (paopao*). That is why the pet kept
  // looking like it was holding a phone or throwing peace signs no matter what
  // the menus said — those are the model's factory idle routine, not our state.
  //
  // We pin them to their rest value after every motion update so the default
  // look really is "no props, hands at rest". Anything the user (or a
  // performance) explicitly sets is written by the layer stack and therefore
  // exempt — see applyLook().
  // Each entry is [parameterId, restValue]. The rest value is the value the
  // model's OWN idle animation starts from:
  //   1 -> the part stays visible and natural (hands, cat ears, paws)
  //   0 -> the element is hidden (props, bubbles, sparkles, flowers)
  // Pinning the hand/ear parameters to 0 was what made the hands disappear.
  //
  // Only parameters the idle animation actually drives are listed. Anything the
  // user can pick from the menu (撤回 / 画笔 / 橡皮 / 点菜按下 / 挤 / 手机 /
  // 蛋包饭 / 鲸鱼 / 魔爪 ...) is deliberately NOT suppressed, otherwise those
  // menu items would look like they do nothing.
  const IDLE_SUPPRESS = [
    // 手 (猫手 左1/左2/左3/右1/右2/右3) — stay visible
    ['maoshou2', 1], ['maoshou3', 1], ['maoshou4', 1], ['maoshou5', 1], ['maoshou6', 1], ['maoshou7', 1],
    // 猫猫耳 + 左右爪子 — stay visible
    ['c1', 1], ['c2', 1], ['c3', 1], ['c4', 1], ['c5', 0], ['c6', 0],
    // 捶出包: 锤子 / 星星 / 兔兔耳 — hidden
    ['Param70', 0], ['Param71', 0], ['Param72', 0], ['Param73', 0], ['Param74', 0],
    ['Param75', 0], ['Param76', 0], ['Param77', 0], ['Param78', 0], ['Param79', 0],
    // 道具组 出N / 出现N / 大小X / 大小Y — hidden
    ['j2', 0], ['j3', 0], ['j4', 0], ['j5', 0], ['j6', 0], ['j7', 0], ['j8', 0], ['j8_1', 0],
    ['j9', 0], ['j10', 0], ['j11', 0], ['j12', 0], ['j13', 0], ['j14', 0], ['j15', 0], ['j16', 0],
    ['j17', 0], ['j18', 0], ['j19', 0], ['j20', 0], ['j21', 0], ['j22', 0], ['j23', 0], ['j24', 0],
    ['j25', 0], ['j26', 0], ['j27', 0], ['j28', 0], ['j29', 0], ['j30', 0], ['j31', 0], ['j32', 0],
    ['j34', 0], ['j35', 0], ['j36', 0], ['j37', 0], ['j38', 0], ['j39', 0], ['j40', 0], ['j41', 0],
    ['j42', 0], ['j43', 0], ['j44', 0], ['j45', 0], ['j46', 0], ['j47', 0], ['j48', 0], ['j49', 0],
    ['j50', 0], ['j51', 0], ['j52', 0], ['j53', 0], ['j54', 0], ['j55', 0], ['j56', 0], ['j57', 0],
    // 嘴里泡泡 — hidden
    ['paopao', 0], ['paopao2', 0], ['paopao3', 0], ['paopao4', 0], ['paopao5', 0],
    // 花转 — hidden
    ['ParamCheek28', 0], ['ParamCheek36', 0],
  ]


  // symbols alive in the idle loop that must be released on state exit
  const SYMBOL_IDS = [
    'paopao', 'paopao2', 'paopao3', 'paopao4', 'paopao5',
    'chuipaopao', 'chuipaopao1', 'chuipaopao2', 'chuipaopao3',
    'chuipaopao4', 'chuipaopao5', 'chuipaopao6', 'chuipaopao7',
  ]

  // ------------------------------------------------------------- helpers
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-l2d="' + src + '"]')) { resolve(); return }
      const s = document.createElement('script')
      s.src = src
      s.dataset.l2d = src
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('failed to load ' + src))
      document.head.appendChild(s)
    })
  }

  function coreModel() {
    try {
      return model && model.internalModel && model.internalModel.coreModel
    } catch (e) { return null }
  }

  function setParam(id, value) {
    const cm = coreModel()
    if (!cm || typeof cm.setParameterValueById !== 'function') return
    try { cm.setParameterValueById(id, value) } catch (e) { /* unknown param */ }
  }

  /** Merge the three layers into the flat parameter list to write each frame. */
  function computeLook() {
    const merged = new Map() // id -> value (later layers overwrite earlier ones)
    for (const name of [propExpr, handExpr, moodExpr]) {
      if (!name) continue
      const params = exprDefs && exprDefs[name]
      if (!params) continue
      for (const p of params) {
        const rest = paramDefault(p.id)
        let value
        if (p.blend === 'Multiply') value = rest * p.value
        else if (p.blend === 'Overwrite') value = p.value
        else value = rest + p.value // "Add" (the .exp3 default)
        merged.set(p.id, value)
      }
    }
    lookWrites = Array.from(merged, ([id, value]) => ({ id, value }))
    lookOwnedIds = new Set(merged.keys())
  }

  /** Reset the previously written parameters, then rebuild the layer stack. */
  function restyleLook() {
    for (const id of appliedLookIds) setParam(id, paramDefault(id))
    appliedLookIds = []
    computeLook()
    applyLook()
    appliedLookIds = lookWrites.map((w) => w.id)
  }

  /** Re-write the cached layer values (cheap: called every frame), then pin
   *  the model's own idle props/hand poses back to rest so the pet keeps its
   *  plain default look. Anything the layer stack owns is left alone. */
  function applyLook() {
    for (let i = 0; i < lookWrites.length; i++) setParam(lookWrites[i].id, lookWrites[i].value)
    for (let i = 0; i < IDLE_SUPPRESS.length; i++) {
      const entry = IDLE_SUPPRESS[i]
      if (!lookOwnedIds.has(entry[0])) setParam(entry[0], entry[1])
    }
  }

  /** Tell the host what is currently pinned so the menus can show a tick. */
  function reportLook() {
    try {
      if (window.pet && typeof window.pet.reportLook === 'function') {
        window.pet.reportLook({
          mood: manualExpr,
          motion: manualMotionIdx,
          stopped: motionStopped,
          hand: handExpr,
          prop: propExpr,
        })
      }
    } catch (e) { /* non-fatal */ }
  }

  /** Set the mood (temporary performance) layer. */
  function applyExpr(name, force) {
    if (name === moodExpr && !force) return
    moodExpr = name || null
    restyleLook()
  }

  /** Set the hand layer (null clears it). */
  function setHandExpr(name) {
    handExpr = (typeof name === 'string' && name) ? name : null
    restyleLook()
    reportLook()
  }

  /** Set the prop layer (null clears it). */
  function setPropExpr(name) {
    propExpr = (typeof name === 'string' && name) ? name : null
    restyleLook()
    reportLook()
  }

  /** Release the idle-loop props (bubbles / gum) so nothing leaks across states. */
  function clearSymbols() {
    for (const id of SYMBOL_IDS) setParam(id, 0)
  }

  function layout() {
    if (!app || !model) return
    const sw = app.renderer.width / app.renderer.resolution
    const sh = app.renderer.height / app.renderer.resolution
    // The Cubism canvas (4068x4068 here) is much larger than the character
    // inside it, so scaling by the canvas height renders a tiny pet. Measure
    // the model's real content bounds at scale 1 and fit THAT to the stage.
    let contentH = 0
    let contentW = 0
    try {
      model.scale.set(1)
      const b = model.getBounds()
      contentW = b.width
      contentH = b.height
    } catch (e) { /* fall back below */ }
    if (!contentH || !isFinite(contentH) || contentH <= 0) {
      contentH = (model.internalModel && model.internalModel.originalHeight) || 1
      contentW = (model.internalModel && model.internalModel.originalWidth) || 1
    }
    // Fit to ~94% of the stage height; if the model is much wider than tall,
    // also respect the stage width so it never spills sideways.
    let s = (sh * 0.94) / contentH
    if (contentW * s > sw * 1.4) s = (sw * 1.4) / contentW
    model.scale.set(s)
    model.x = sw * 0.5
    model.y = sh - 2
    if (model.anchor && typeof model.anchor.set === 'function') model.anchor.set(0.5, 1)
  }

  function playMotion(idx) {
    if (!model || idx === null || idx === undefined) return
    try { model.motion('Tap', idx, 3) } catch (e) { /* motion may be missing */ }
  }

  function scheduleIdleShow(from) {
    const gap = IDLE_SHOW_MIN_WAIT_MS + Math.random() * (IDLE_SHOW_MAX_WAIT_MS - IDLE_SHOW_MIN_WAIT_MS)
    idleShowNextAt = from + gap
  }

  function startIdleShow(now) {
    // Never override a look the user chose by hand.
    if (manualExpr !== null || manualMotionIdx !== null || motionStopped) {
      scheduleIdleShow(now)
      return
    }
    const pick = (list) => {
      const pool = list.filter((n) => exprDefs && exprDefs[n])
      return pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : null
    }
    const expr = pick(IDLE_SHOW_EXPRESSIONS)
    const hand = pick(IDLE_SHOW_HANDS)
    const prop = pick(IDLE_SHOW_PROPS)
    const motionCount = motionDurations.length || 0
    const motionIdx = motionCount > 0 ? Math.floor(Math.random() * motionCount) : null
    idleShowActive = true
    lastIdleShowMotion = motionIdx
    idleShowUntil = now + IDLE_SHOW_MIN_MS + Math.random() * (IDLE_SHOW_MAX_MS - IDLE_SHOW_MIN_MS)
    // Hand and prop are PERSISTENT layers: whatever she picks up now, she keeps
    // after the performance ends. Only the mood face is temporary.
    handExpr = hand
    propExpr = prop
    applyExpr(expr, true)
    console.log(`[pet-live2d] idle show layers: mood=${expr} hand=${hand} prop=${prop}`)
    if (motionIdx !== null) playMotion(motionIdx)
    motionDueAt = now + 900
    console.log(`[pet-live2d] idle show: expr=${expr} motion=${motionIdx}`)
  }

  function endIdleShow(now) {
    idleShowActive = false
    // Everything returns to the default look: mood, hand pose AND prop. Nothing
    // picked during a performance is kept, so the pet never accumulates
    // leftovers (no permanent phone, bunny-ears pose or omelette rice).
    handExpr = null
    propExpr = null
    applyExpr(null, true) // restyles all three layers back to neutral
    try { model.motion('Idle') } catch (e) { /* ignore */ }
    scheduleIdleShow(now)
    console.log('[pet-live2d] idle show ended -> full reset (mood/hand/prop cleared)')
  }

  function tickIdleShow(now) {
    if (!ready || !model) return
    if (idleShowActive) {
      // Abort early if work starts or the user takes over.
      if (curState !== 'idle' || manualExpr !== null || manualMotionIdx !== null || motionStopped) {
        endIdleShow(now)
        return
      }
      if (now >= idleShowUntil) endIdleShow(now)
      return
    }
    // Only while genuinely idle (not sleeping, not busy, not interacting).
    if (curState !== 'idle') { scheduleIdleShow(now); return }
    if (idleShowNextAt === 0) { scheduleIdleShow(now); return }
    if (now >= idleShowNextAt) startIdleShow(now)
  }

  function tickMotion(now) {
    if (!ready || !model) return
    // A user-picked motion keeps looping until they pick another or press
    // stop: several clips are very short (喷水 0.5s, 开盖 1s) and a one-shot
    // play reads as "nothing happened".
    if (manualMotionIdx !== null && !motionStopped) {
      if (now >= motionDueAt) {
        playMotion(manualMotionIdx)
        const dur = motionDurations[manualMotionIdx]
        motionDueAt = now + ((dur ? dur + 0.7 : motionInterval) * 1000)
      }
      return
    }
    if (motionPool === null || motionPool.length === 0) return
    if (now < motionDueAt) return
    playMotion(motionPool[motionIdx % motionPool.length])
    motionIdx++
    motionDueAt = now + motionInterval * 1000
  }

  /** Replay the idle-show's chosen motion using its real clip length. */
  function tickIdleShowMotion(now) {
    if (!idleShowActive) return
    if (manualMotionIdx !== null) return
    if (now < motionDueAt) return
    const idx = lastIdleShowMotion
    if (idx === null) return
    playMotion(idx)
    const dur = motionDurations[idx]
    motionDueAt = now + ((dur ? dur + 0.4 : 3) * 1000)
  }

  // ---------------------------------------------------------------- API
  async function init(modelUrl) {
    if (initPromise) return initPromise
    initPromise = (async () => {
      try {
        // 1. engine scripts — ORDER MATTERS: pixi first, then the Cubism Core
        //    runtime, and only then the cubism4 display bundle (it checks for
        //    Live2DCubismCore at load time and refuses to install PIXI.live2d
        //    otherwise).
        await loadScript('../live2d/vendor/pixi.min.js')
        await loadScript('../live2d/vendor/live2dcubismcore.min.js')
        await loadScript('../live2d/vendor/cubism4.min.js')
        if (!window.PIXI || !PIXI.live2d) throw new Error('PIXI.live2d missing after vendor load')
        if (!window.Live2DCubismCore) throw new Error('Live2DCubismCore missing')

        // 2. stage canvas — size it from the sprite canvas (#pet), which
        //    renderer.js already sized via applyStage. Reading the intended
        //    stage size here avoids a zero-sized canvas (invisible model).
        let stage = document.getElementById('live2d-stage')
        let sw = 0, sh = 0
        const petCanvas = document.getElementById('pet')
        if (petCanvas) {
          const cs = window.getComputedStyle(petCanvas)
          sw = parseFloat(cs.width) || petCanvas.clientWidth || 0
          sh = parseFloat(cs.height) || petCanvas.clientHeight || 0
        }
        if (!sw || !sh) {
          sw = Math.max(200, window.innerWidth)
          sh = Math.max(200, window.innerHeight)
        }
        if (!stage) {
          stage = document.createElement('canvas')
          stage.id = 'live2d-stage'
          document.body.appendChild(stage)
        }
        stage.style.width = `${sw}px`
        stage.style.height = `${sh}px`
        app = new PIXI.Application({
          view: stage,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: false,
          resolution: Math.max(2, window.devicePixelRatio || 1),
          width: Math.max(1, Math.round(sw)),
          height: Math.max(1, Math.round(sh)),
          preserveDrawingBuffer: true,
        })

        // 3. model
        const m = await PIXI.live2d.Live2DModel.from(modelUrl, {
          autoInteract: false,
          autoUpdate: true,
          eyeBlink: false,
        })
        model = m
        app.stage.addChild(m)
        // Load every expression the model declares (needs the model directory).
        const modelDir = String(modelUrl).replace(/\/[^/]*$/, '')
        exprDefs = await loadExpressionDefs(modelDir)
        motionDurations = await loadMotionDurations(modelDir)
        console.log('[pet-live2d] motion durations:', JSON.stringify(motionDurations))
        layout()
        console.log('[pet-live2d] model ready (source %sx%s, %s expressions)',
          m.internalModel.originalWidth, m.internalModel.originalHeight, Object.keys(exprDefs).length)

        // 4. re-assert the face every frame AFTER the model writes its own
        //    parameters (motion curves would otherwise overwrite us).
        const IM = m.internalModel
        const origUpdate = IM.update
        IM.update = function () {
          const r = origUpdate.apply(this, arguments)
          applyLook() // cached layer values, cheap enough for every frame
          applyGaze() // after the motion curves, so the look always wins
          return r
        }

        // 5. idle breathing + gentle sway + motion scheduler
        try { m.motion('Idle') } catch (e) { /* ignore */ }
        const t0 = performance.now()
        app.ticker.add(() => {
          tickCount++
          try {
            const t = (performance.now() - t0) / 1000
            if (model) {
              const sh = app.renderer.height / app.renderer.resolution
              model.rotation = Math.sin(t * 0.9) * 0.012
              model.y = sh - 2 + Math.sin(t * 1.4) * 2.5
            }
            const tickNow = performance.now()
            tickGaze()
            tickMotion(tickNow)
            tickIdleShowMotion(tickNow)
            tickIdleShow(tickNow)
          } catch (err) {
            // Never let one bad tick stop the whole render loop.
            if (tickErrors < 5) {
              tickErrors++
              console.error('[pet-live2d] tick error:', err && err.message, err && err.stack)
            }
          }
        })
        window.addEventListener('resize', layout)

        ready = true
        document.body.classList.add('live2d-active')
        return true
      } catch (e) {
        failed = true
        console.error('[pet-live2d] init failed:', e && e.message)
        return false
      }
    })()
    return initPromise
  }

  /** States that a feed / play / wake interaction drives. While one of these
   *  is active the interaction's own motion pool plays, and a user-pinned
   *  motion is suspended until the interaction ends (resumeManualLook). */
  const INTERACTION_STATES = { eat: true, play: true, wake: true }

  function setState(name) {
    const key = (typeof name === 'string' && name) ? name : 'idle'
    const entry = STATE_MAP[key] || STATE_MAP.idle
    const changed = key !== curState
    curState = key

    // Feed / play / wake: suspend a pinned motion so the interaction's own
    // clip plays; resumeManualLook puts it back when the interaction ends.
    if (changed) {
      if (INTERACTION_STATES[key] && manualMotionIdx !== null && suspendedMotionIdx === null) {
        suspendedMotionIdx = manualMotionIdx
        manualMotionIdx = null
        console.log(`[pet-live2d] suspended pinned motion ${suspendedMotionIdx} for interaction state ${key}`)
      } else if (!INTERACTION_STATES[key] && suspendedMotionIdx !== null) {
        manualMotionIdx = suspendedMotionIdx
        suspendedMotionIdx = null
        console.log(`[pet-live2d] restored pinned motion ${manualMotionIdx} on state ${key}`)
      }
    }

    // A user-pinned face outranks the state's own expression, so picking an
    // expression from the menu keeps it on screen through state changes.
    applyExpr(manualExpr !== null ? manualExpr : entry.expr, true)
    clearSymbols()
    if (changed) {
      if (motionStopped) {
        // The user explicitly stopped motions: keep the idle loop, do not
        // re-arm a pool just because the state changed.
        motionPool = null
      } else {
        motionPool = Array.isArray(entry.motion) ? entry.motion : (entry.motion === null ? null : [entry.motion])
        motionIdx = 0
        motionInterval = entry.interval || 3.2
        motionDueAt = performance.now() + 600 // small beat before the first action
        if (motionPool !== null) playMotion(motionPool[0])
      }
    }
  }

  /** Pin a face manually. Pass null to release the pin and let the state
   *  machine drive expressions again. */
  function setExpression(name) {
    manualExpr = (typeof name === 'string' && name) ? name : null
    const fallback = (STATE_MAP[curState] || STATE_MAP.idle).expr
    applyExpr(manualExpr !== null ? manualExpr : fallback, true)
    reportLook()
  }

  /** Play one Tap motion immediately. Pass null to stop and return to Idle. */
  function playMotionOnce(index) {
    if (!model) return
    if (index === null || index === undefined) {
      manualMotionIdx = null
      motionStopped = true // keep the state machine from re-arming a pool
      motionPool = null
      try { model.motion('Idle') } catch (e) { /* ignore */ }
      reportLook()
      return
    }
    // Remember the choice so a transient interaction (feed/play) can restore
    // the user's look when it ends. The clip then loops (see tickMotion).
    manualMotionIdx = index
    motionStopped = false
    reportLook()
    playMotion(index)
    // Replay cadence = clip length + a short gap, so a 0.47s clip is actually
    // visible instead of flashing once every few seconds.
    const dur = motionDurations[index]
    motionDueAt = performance.now() + ((dur ? dur + 0.7 : motionInterval) * 1000)
  }

  /** Re-assert the user's pinned expression + motion. Called when a transient
   *  interaction (feed/play/wake) finishes, so the pet returns to whatever the
   *  menu was set to — or to the plain state look when nothing was picked. */
  function resumeManualLook() {
    console.log(`[pet-live2d] resumeManualLook: ready=${ready} manualExpr=${manualExpr} suspendedMotion=${suspendedMotionIdx} manualMotion=${manualMotionIdx} curState=${curState}`)
    if (!ready || !model) return
    // Bring back a motion that was parked for the interaction.
    if (suspendedMotionIdx !== null) {
      manualMotionIdx = suspendedMotionIdx
      suspendedMotionIdx = null
    }
    const fallback = (STATE_MAP[curState] || STATE_MAP.idle).expr
    applyExpr(manualExpr !== null ? manualExpr : fallback, true)
    if (manualMotionIdx !== null && !motionStopped) {
      playMotion(manualMotionIdx)
      const dur = motionDurations[manualMotionIdx]
      motionDueAt = performance.now() + ((dur ? dur + 0.7 : motionInterval) * 1000)
    }
  }

  function destroy() {
    try { if (app) app.destroy(true, { children: true }) } catch (e) { /* ignore */ }
    app = null
    model = null
    ready = false
  }

  /** Stage size changed (pet scale preset): resize the renderer and re-fit. */
  function resize(w, h) {
    if (!app) return
    const nw = Math.max(1, Math.round(w || 0))
    const nh = Math.max(1, Math.round(h || 0))
    try {
      const st = document.getElementById('live2d-stage')
      if (st) {
        st.style.width = `${nw}px`
        st.style.height = `${nh}px`
      }
      if (app.renderer && typeof app.renderer.resize === 'function') {
        app.renderer.resize(nw, nh)
      }
      layout()
    } catch (e) { /* ignore */ }
  }

  window.PetLive2D = {
    init,
    setState,
    setExpression,
    playMotionOnce,
    resumeManualLook,
    setCursor,
    setGazeEnabled,
    setHandExpr,
    setPropExpr,
    layout,
    resize,
    destroy,
    isReady: () => ready,
    isFailed: () => failed,
    getState: () => curState,
    getPinnedExpression: () => manualExpr,
    getPinnedMotion: () => manualMotionIdx,
    // Diagnostics (used by the automated expression tests).
    _layers: () => ({ mood: moodExpr, hand: handExpr, prop: propExpr, applied: appliedLookIds.length }),
    _gaze: () => ({
      on: gazeOn,
      target: [gazeTargetX, gazeTargetY],
      current: [gazeCurX, gazeCurY],
      sinceMoveMs: lastCursorMoveAt > 0 ? Math.round(performance.now() - lastCursorMoveAt) : null,
    }),
    _suppressed: () => IDLE_SUPPRESS.length,
    _ticks: () => ({ count: tickCount, errors: tickErrors, active: idleShowActive, now: Math.round(performance.now()), until: Math.round(idleShowUntil) }),
    _idleShow: () => ({ active: idleShowActive, until: idleShowUntil, nextAt: idleShowNextAt, lastMotion: lastIdleShowMotion }),
    _triggerIdleShow: () => { startIdleShow(performance.now()); return idleShowActive },
    _endIdleShow: () => { if (idleShowActive) endIdleShow(performance.now()); return idleShowActive },
    _debug: () => ({
      ready,
      moodExpr,
      handExpr,
      propExpr,
      defCount: exprDefs ? Object.keys(exprDefs).length : 0,
      hasModel: !!model,
      hasCore: !!coreModel(),
      coreMethods: (() => {
        const cm = coreModel()
        if (!cm) return []
        return Object.getOwnPropertyNames(Object.getPrototypeOf(cm)).filter((n) => /Param/i.test(n)).slice(0, 12)
      })(),
      sampleParam: (() => {
        const cm = coreModel()
        if (!cm) return null
        try { return cm.getParameterValueById('ParamCheek71') } catch (e) { return 'ERR ' + e.message }
      })(),
    }),
    _paramInfo: (id) => {
      const cm = coreModel()
      if (!cm) return null
      const info = { id }
      try { info.value = cm.getParameterValueById(id) } catch (e) { info.value = 'ERR' }
      try { info.def = typeof cm.getParameterDefaultValueById === 'function' ? cm.getParameterDefaultValueById(id) : 'n/a' } catch (e) { info.def = 'ERR' }
      try { info.min = typeof cm.getParameterMinimumValueById === 'function' ? cm.getParameterMinimumValueById(id) : 'n/a' } catch (e) { info.min = 'ERR' }
      try { info.max = typeof cm.getParameterMaximumValueById === 'function' ? cm.getParameterMaximumValueById(id) : 'n/a' } catch (e) { info.max = 'ERR' }
      return info
    },
    _paramValue: (id) => {
      const cm = coreModel()
      if (!cm) return null
      try { return cm.getParameterValueById(id) } catch (e) { return 'ERR ' + e.message }
    },
    _exprParams: (name) => (exprDefs && exprDefs[name]) ? exprDefs[name] : null,
  }
})()
