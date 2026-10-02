/**
 * Control-panel UI for the whale-girl pet.
 *
 * Layout: title bar → always-visible quick actions → two tabs → footer.
 * Tabs are 系统 (first) and 表情 & 动作 (merged). Everything that used to live
 * in its own tab (interactions, appearance) is folded in here.
 *
 * Selecting an option always toggles: clicking the current choice again clears
 * it. The tick is drawn by CSS (.item.on::before) and never repeated in the
 * label, so a selected item shows exactly one ✓.
 */
const api = window.menuAPI

let DATA = null
let STATE = { mood: null, motion: null, stopped: false, hand: null, prop: null, gaze: true, scale: 1 }
let activeTab = 'system'

const TABS = [
  { id: 'system', label: '⚙️ 系统' },
  { id: 'look', label: '😊 表情 & 动作' },
  { id: 'clock', label: '⏱️ 计时器' },
]

// 计时器状态由主进程持有，这里只缓存一份用于渲染
let CLOCK = null
// 记录内容区当前是按哪个模式渲染的：模式一变就必须整体重绘
let renderedClockMode = null
// 表单里正在编辑但尚未提交的输入（避免被每秒推送覆盖）
const clockDraft = { timerH: 0, timerM: 5, timerS: 0, slots: [], loops: 1 }

const QUICK = [
  { icon: '🍗', label: '喂食', cmd: { type: 'feed' } },
  { icon: '🎾', label: '玩耍', cmd: { type: 'play' } },
  { icon: '👋', label: '摸摸头', cmd: { type: 'pet' } },
  { icon: '🎭', label: '随机表演', cmd: { type: 'idleShow' } },
]

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/* ------------------------------------------------------------ quick bar */
function renderQuick() {
  const box = document.getElementById('quick')
  box.replaceChildren()
  for (const q of QUICK) {
    const b = el('button')
    b.append(el('span', 'ico', q.icon))
    b.append(el('span', '', q.label))
    b.onclick = () => api.cmd(q.cmd)
    box.append(b)
  }
}

/* ----------------------------------------------------------------- tabs */
function renderTabs() {
  const tabs = document.getElementById('tabs')
  tabs.replaceChildren()
  for (const t of TABS) {
    const b = el('button', 'tab' + (t.id === activeTab ? ' active' : ''), t.label)
    b.onclick = () => {
      activeTab = t.id
      renderTabs()
      renderContent()
    }
    tabs.append(b)
  }
}

/* -------------------------------------------------------------- helpers */
function group(title, nodes) {
  const g = el('div', 'group')
  if (title) g.append(el('div', 'group-title', title))
  const grid = el('div', 'grid')
  for (const n of nodes) grid.append(n)
  g.append(grid)
  return g
}

/** A selectable chip. Clicking the current selection clears it (null). */
function chip(label, selected, onPick, onClear) {
  const b = el('button', 'item' + (selected ? ' on' : ''), label)
  b.onclick = () => {
    if (selected && onClear) onClear()
    else onPick()
  }
  return b
}

/** A settings row (optional clickable, with a right-hand value). */
function row(label, value, onClick, on) {
  const r = el('div', 'row' + (onClick ? ' click' : '') + (on ? ' on' : ''))
  r.append(el('div', 'label', label))
  if (value !== undefined) r.append(el('div', 'value', value))
  if (onClick) r.onclick = onClick
  return r
}

/* -------------------------------------------------------------- panels */
function renderContent() {
  const c = document.getElementById('content')
  c.replaceChildren()
  if (activeTab === 'system') renderSystem(c)
  else if (activeTab === 'clock') renderClock(c)
  else renderLook(c)
}

function renderSystem(c) {
  // --- size (single choice; always one active, so no clearing) ---
  const sizeGroup = el('div', 'group')
  sizeGroup.append(el('div', 'group-title', '桌宠大小'))
  const inline = el('div', 'inline')
  for (const s of DATA.scales || []) {
    const b = el('button', 'item' + (Math.abs(STATE.scale - s) < 1e-9 ? ' on' : ''), Math.round(s * 100) + '%')
    b.onclick = () => api.cmd({ type: 'scale', value: s })
    inline.append(b)
  }
  sizeGroup.append(inline)
  c.append(sizeGroup)

  // --- toggles ---
  c.append(group('选项', [
    chip(STATE.gaze ? '眼睛跟随鼠标' : '眼睛跟随鼠标', STATE.gaze,
      () => api.cmd({ type: 'gaze', value: true }),
      () => api.cmd({ type: 'gaze', value: false })),
  ]))

  // --- window / plugins ---
  const sys = el('div', 'group')
  sys.append(el('div', 'group-title', '窗口与插件'))
  sys.append(row('打开 DSH 网页窗口', '›', () => api.cmd({ type: 'openWeb' })))
  sys.append(row('系统浏览器打开 DSH', '›', () => api.cmd({ type: 'openBrowser' })))
  sys.append(row('DSH 插件市场', '›', () => api.cmd({ type: 'marketplace' })))
  sys.append(row('插件目录（本地）', '›', () => api.cmd({ type: 'pluginsDir' })))
  sys.append(row('插件目录（GitHub）', '›', () => api.cmd({ type: 'pluginsRepo' })))
  c.append(sys)

  const maint = el('div', 'group')
  maint.append(el('div', 'group-title', '维护'))
  maint.append(row('重启 DSH', '›', () => api.cmd({ type: 'restartDsh' })))
  maint.append(row('显示 / 隐藏桌宠', '›', () => api.cmd({ type: 'togglePet' })))
  c.append(maint)
}

function renderLook(c) {
  // --- expressions (toggle) ---
  const noneChip = chip('无（跟随状态）', STATE.mood === null,
    () => api.cmd({ type: 'expression', name: null }))
  c.append(group('表情 · 默认', [noneChip]))
  for (const g of DATA.expressionGroups || []) {
    const nodes = g.names.map((n) =>
      chip(n, STATE.mood === n,
        () => api.cmd({ type: 'expression', name: n }),
        () => api.cmd({ type: 'expression', name: null })))
    c.append(group('表情 · ' + g.label, nodes))
  }

  // --- motions (toggle) ---
  // "停止" is an ACTION, not a selection, so it never shows a tick.
  const stopBtn = el('button', 'item', '停止（回到待机）')
  stopBtn.onclick = () => api.cmd({ type: 'motion', index: null })
  const mNodes = [stopBtn]
  for (const m of DATA.motions || []) {
    mNodes.push(chip(m.name, STATE.motion === m.index,
      () => api.cmd({ type: 'motion', index: m.index }),
      () => api.cmd({ type: 'motion', index: null })))
  }
  c.append(group('动作', mNodes))

  // --- hand poses (toggle) ---
  if (DATA.handExpressions && DATA.handExpressions.length) {
    const nodes = [chip('无', STATE.hand === null, () => api.cmd({ type: 'hand', name: null }))]
    for (const n of DATA.handExpressions) {
      nodes.push(chip(n, STATE.hand === n,
        () => api.cmd({ type: 'hand', name: n }),
        () => api.cmd({ type: 'hand', name: null })))
    }
    c.append(group('手部', nodes))
  }

  // --- props (toggle) ---
  if (DATA.propExpressions && DATA.propExpressions.length) {
    const nodes = [chip('无', STATE.prop === null, () => api.cmd({ type: 'prop', name: null }))]
    for (const n of DATA.propExpressions) {
      nodes.push(chip(n, STATE.prop === n,
        () => api.cmd({ type: 'prop', name: n }),
        () => api.cmd({ type: 'prop', name: null })))
    }
    c.append(group('道具', nodes))
  }
}

/* -------------------------------------------------------------- 计时器 */
function fmt(ms) {
  let t = Math.floor(Math.max(0, ms) / 1000)
  if (t > 359999) t = 359999 // 99:59:59
  const p = (n) => String(n).padStart(2, '0')
  return p(Math.floor(t / 3600)) + ':' + p(Math.floor((t % 3600) / 60)) + ':' + p(t % 60)
}

/** 秒表格式：分:秒:厘秒（精度 1/100 秒），与主进程 formatStopwatch 保持一致 */
function fmtStopwatch(ms) {
  let totalCs = Math.floor(Math.max(0, ms) / 10)
  if (totalCs > 359999 * 100) totalCs = 359999 * 100
  const cs = totalCs % 100
  const secs = Math.floor(totalCs / 100)
  const s = secs % 60
  const m = Math.floor(secs / 60)
  const p = (n) => String(n).padStart(2, '0')
  return String(m).padStart(2, '0') + ':' + p(s) + ':' + p(cs)
}

// ---- 秒表的本地插值：主进程只给 base/accumulated，厘秒在本地算 ----
let swLocalTimer = null
let swAnchor = null   // { running, base, accumulated, at } at = 收到推送的本地时刻

function swSyncAnchor(st) {
  if (!st || !st.stopwatch) return
  const s = st.stopwatch
  swAnchor = { running: !!s.running, base: Number(s.base) || 0, accumulated: Number(s.accumulated) || 0, at: Date.now() }
}

function swLocalElapsed() {
  if (!swAnchor) return 0
  if (!swAnchor.running) return swAnchor.accumulated
  // 用绝对时间推进，和主进程算法一致
  return swAnchor.accumulated + (Date.now() - swAnchor.base)
}

function startSwLocalTicker() {
  if (swLocalTimer) return
  swLocalTimer = setInterval(() => {
    if (!CLOCK || CLOCK.mode !== 'stopwatch' || activeTab !== 'clock') return
    const big = document.querySelector('.clock-display')
    if (!big) return
    const text = fmtStopwatch(swLocalElapsed())
    if (big.textContent !== text) big.textContent = text
  }, 50) // 50ms ≈ 20fps，厘秒看起来是连续的
}

function clockBig(text, running, done) {
  const box = el('div', 'clock-display' + (done ? ' done' : (running ? ' running' : '')), text)
  return box
}

function actionBtn(label, cls, onClick) {
  const b = el('button', cls || '', label)
  b.onclick = onClick
  return b
}

function renderClock(c) {
  const st = CLOCK
  renderedClockMode = st ? st.mode : 'stopwatch'
  lastClockSignature = clockUiSignature(st)
  // ---- 模式切换 ----
  const modeBox = el('div', 'clock-mode')
  for (const m of [['stopwatch', '⏱ 秒表'], ['timer', '⏳ 计时器'], ['session', '📋 会话']]) {
    const b = el('button', (st && st.mode) === m[0] ? 'active' : '', m[1])
    b.onclick = () => api.clockCmd({ type: 'mode', mode: m[0] })
    modeBox.append(b)
  }
  c.append(modeBox)

  const mode = st ? st.mode : 'stopwatch'
  if (mode === 'stopwatch') renderStopwatch(c, st)
  else if (mode === 'timer') renderTimer(c, st)
  else renderSession(c, st)
}

function renderStopwatch(c, st) {
  const sw = st ? st.stopwatch : { running: false, text: '0:00:00', elapsed: 0, laps: [] }
  c.append(clockBig(sw.text || fmtStopwatch(sw.elapsed || 0), sw.running))
  c.append(el('div', 'clock-sub', sw.running ? '计时中' : (sw.elapsed > 0 ? '已暂停' : '就绪')))

  const acts = el('div', 'clock-actions')
  if (!sw.running) {
    acts.append(actionBtn(sw.elapsed > 0 ? '继续' : '开始', 'primary', () => api.clockCmd({ type: 'sw-start' })))
  } else {
    acts.append(actionBtn('暂停', '', () => api.clockCmd({ type: 'sw-pause' })))
  }
  acts.append(actionBtn('取时', '', () => api.clockCmd({ type: 'sw-lap' })))
  acts.append(actionBtn('重置', 'danger', () => api.clockCmd({ type: 'sw-reset' })))
  c.append(acts)

  if (sw.laps && sw.laps.length) {
    const g = el('div', 'group')
    const head = el('div', 'group-title', '取时记录（共 ' + sw.laps.length + ' 次）')
    const bar = el('div', 'clock-actions')
    bar.append(actionBtn('清空记录', '', () => api.clockCmd({ type: 'sw-clear-laps' })))
    const list = el('div', 'clock-laps')
    for (const l of sw.laps) {
      const row = el('div', 'clock-lap')
      row.append(el('span', 'n', '#' + l.index))
      row.append(el('span', '', fmtStopwatch(l.total)))
      row.append(el('span', 'lap', '+' + fmtStopwatch(l.lap)))
      list.append(row)
    }
    g.append(head, bar, list)
    c.append(g)
  }
}

function renderTimer(c, st) {
  const tm = st ? st.timer : { running: false, text: '00:00:00', duration: 0, durationText: '00:00:00' }
  c.append(clockBig(tm.text, tm.running, !tm.running && !tm.paused && tm.duration > 0 && tm.text === '00:00:00'))
  c.append(el('div', 'clock-sub', tm.running ? '倒计时中 · 设定 ' + tm.durationText : (tm.paused ? '已暂停 · 设定 ' + tm.durationText : '设定时间后开始')))

  // 时/分/秒 输入
  const row = el('div', 'clock-inputs')
  const mk = (val, key, max) => {
    const i = el('input')
    i.type = 'text'
    i.inputMode = 'numeric'
    i.value = String(val).padStart(2, '0')
    i.oninput = () => {
      let v = parseInt(i.value.replace(/[^0-9]/g, ''), 10)
      if (!Number.isFinite(v)) v = 0
      if (v > max) v = max
      clockDraft[key] = v
    }
    i.onblur = () => { i.value = String(clockDraft[key]).padStart(2, '0') }
    return i
  }
  row.append(mk(clockDraft.timerH, 'timerH', 99))
  row.append(el('span', '', '时'))
  row.append(mk(clockDraft.timerM, 'timerM', 59))
  row.append(el('span', '', '分'))
  row.append(mk(clockDraft.timerS, 'timerS', 59))
  row.append(el('span', '', '秒'))
  c.append(row)

  const draftSec = () => clockDraft.timerH * 3600 + clockDraft.timerM * 60 + clockDraft.timerS

  // 快捷预设
  const pre = el('div', 'clock-presets')
  for (const p of [[1, '1分'], [3, '3分'], [5, '5分'], [10, '10分'], [15, '15分'], [25, '25分'], [30, '30分'], [60, '60分']]) {
    const b = el('button', '', p[1])
    b.onclick = () => {
      clockDraft.timerH = Math.floor(p[0] / 60)
      clockDraft.timerM = p[0] % 60
      clockDraft.timerS = 0
      renderContent()
    }
    pre.append(b)
  }
  c.append(pre)

  const acts = el('div', 'clock-actions')
  if (tm.running) {
    acts.append(actionBtn('暂停', '', () => api.clockCmd({ type: 'tm-pause' })))
  } else if (tm.paused) {
    acts.append(actionBtn('继续', 'primary', () => api.clockCmd({ type: 'tm-resume' })))
  } else {
    acts.append(actionBtn('开始', 'primary', () => api.clockCmd({ type: 'tm-start', seconds: draftSec() })))
  }
  acts.append(actionBtn('重置', 'danger', () => api.clockCmd({ type: 'tm-reset' })))
  c.append(acts)
  c.append(el('div', 'clock-hint', '上限 99 小时 59 分 59 秒；到点会在桌宠气泡里提醒你'))
}

function renderSession(c, st) {
  const ss = st ? st.session : { running: false, slots: [], loops: 1, loop: 0, slot: 0, label: '', text: '00:00:00' }
  // 未运行时用车表单草稿渲染
  if (!ss.running && clockDraft.slots.length === 0 && ss.slots && ss.slots.length) {
    clockDraft.slots = ss.slots.map((x) => ({ label: x.label, seconds: x.seconds }))
    clockDraft.loops = ss.loops
  }

  if (ss.running) {
    c.append(clockBig(ss.text, true))
    c.append(el('div', 'clock-sub', '第 ' + (ss.loop + 1) + ' / ' + ss.totalLoopsText + ' 轮 · ' +
      (ss.label || ('第 ' + (ss.slot + 1) + ' 段'))))
    const acts = el('div', 'clock-actions')
    acts.append(actionBtn('暂停', '', () => api.clockCmd({ type: 'ss-pause' })))
    acts.append(actionBtn('重置', 'danger', () => api.clockCmd({ type: 'ss-reset' })))
    c.append(acts)
    return
  }

  if (ss.paused) {
    c.append(clockBig(ss.text, false))
    c.append(el('div', 'clock-sub', '已暂停 · ' + (ss.label || ('第 ' + (ss.slot + 1) + ' 段'))))
    const acts = el('div', 'clock-actions')
    acts.append(actionBtn('继续', 'primary', () => api.clockCmd({ type: 'ss-resume' })))
    acts.append(actionBtn('重置', 'danger', () => api.clockCmd({ type: 'ss-reset' })))
    c.append(acts)
    return
  }

  // ---- 编辑态 ----
  c.append(el('div', 'clock-sub', '设置若干时间段，每段到点都提醒；可设循环轮数'))
  const slots = clockDraft.slots
  // 每段支持 时 / 分 / 秒 三级输入，总时长上限 99:59:59
  const HOUR_MAX = 99
  const clampAll = (h, m, s) => {
    let total = h * 3600 + m * 60 + s
    if (total > 359999) total = 359999 // 99:59:59
    return total
  }
  const numInput = (value, max, onVal) => {
    const inp = el('input', 'num')
    inp.type = 'text'
    inp.inputMode = 'numeric'
    inp.value = String(value)
    const commit = () => {
      let v = parseInt(inp.value.replace(/[^0-9]/g, ''), 10)
      if (!Number.isFinite(v)) v = 0
      if (v > max) v = max
      onVal(v)
      inp.value = String(v)
    }
    inp.oninput = commit
    inp.onblur = commit
    return inp
  }
  slots.forEach((slot, i) => {
    const row = el('div', 'clock-slot')
    const name = el('input', 'label')
    name.type = 'text'
    name.placeholder = '第 ' + (i + 1) + ' 段'
    name.value = slot.label || ''
    name.oninput = () => { slot.label = name.value }

    const hh = Math.floor(slot.seconds / 3600)
    const mm = Math.floor((slot.seconds % 3600) / 60)
    const ss = slot.seconds % 60
    const setH = (v) => { slot.seconds = clampAll(v, mm, ss) }
    const setM = (v) => { slot.seconds = clampAll(Math.floor(slot.seconds / 3600), v, slot.seconds % 60) }
    const setS = (v) => { slot.seconds = clampAll(Math.floor(slot.seconds / 3600), Math.floor((slot.seconds % 3600) / 60), v) }

    const del = el('button', 'del', '✕')
    del.onclick = () => { clockDraft.slots.splice(i, 1); renderContent() }
    row.append(name,
      numInput(hh, HOUR_MAX, setH), el('span', '', '时'),
      numInput(mm, 59, setM), el('span', '', '分'),
      numInput(ss, 59, setS), el('span', '', '秒'),
      del)
    c.append(row)
  })

  const addRow = el('div', 'clock-actions')
  addRow.append(actionBtn('+ 添加时间段', '', () => {
    if (clockDraft.slots.length >= 20) return
    clockDraft.slots.push({ label: '', seconds: 300 })
    renderContent()
  }))
  c.append(addRow)

  // 循环次数
  const loopRow = el('div', 'clock-inputs')
  loopRow.append(el('span', '', '循环轮数'))
  const li = el('input')
  li.type = 'text'
  li.inputMode = 'numeric'
  li.value = String(clockDraft.loops)
  li.oninput = () => {
    let v = parseInt(li.value.replace(/[^0-9]/g, ''), 10)
    if (!Number.isFinite(v)) v = 0
    if (v > 999) v = 999
    clockDraft.loops = v
  }
  loopRow.append(li)
  loopRow.append(el('span', '', '轮（0 = 无限循环）'))
  c.append(loopRow)

  const acts = el('div', 'clock-actions')
  acts.append(actionBtn('保存并开始', 'primary', () => {
    api.clockCmd({ type: 'ss-set-slots', slots: clockDraft.slots })
    api.clockCmd({ type: 'ss-set-loops', loops: clockDraft.loops })
    setTimeout(() => api.clockCmd({ type: 'ss-start' }), 60)
  }))
  acts.append(actionBtn('重置', 'danger', () => api.clockCmd({ type: 'ss-reset' })))
  c.append(acts)
  c.append(el('div', 'clock-hint', '每段可设 时/分/秒，上限 99:59:59；每段结束时都会在桌宠气泡里提醒，一轮跑完自动进入下一轮'))
}

/* -------------------------------------------------------------- status */
function updateStatus() {
  const parts = []
  parts.push('表情 <b>' + (STATE.mood || '自动') + '</b>')
  parts.push('动作 <b>' + (STATE.motion === null ? '待机' : '#' + STATE.motion) + '</b>')
  parts.push('尺寸 <b>' + Math.round((STATE.scale || 1) * 100) + '%</b>')
  parts.push('跟随 <b>' + (STATE.gaze ? '开' : '关') + '</b>')
  if (CLOCK) {
    if (CLOCK.mode === 'stopwatch' && CLOCK.stopwatch.elapsed > 0) parts.push('秒表 <b>' + fmtStopwatch(swLocalElapsed()) + '</b>')
    else if (CLOCK.mode === 'timer' && (CLOCK.timer.running || CLOCK.timer.remaining > 0)) parts.push('倒计时 <b>' + CLOCK.timer.text + '</b>')
    else if (CLOCK.mode === 'session' && CLOCK.session.slots.length > 0) parts.push('会话 <b>' + CLOCK.session.text + '</b>')
  }
  document.getElementById('status').innerHTML = '当前 · ' + parts.join(' · ')
}

/* ---------------------------------------------------------------- wire */
// ✕ closes just the panel; 退出程序 quits the pet entirely.
document.getElementById('closeBtn').onclick = () => api.close()
document.getElementById('quitBtn').onclick = () => api.quit()

// 计时状态：主进程每 200ms 检查、变化时推送
api.onClock((state) => {
  CLOCK = state
  if (state && state.mode === 'stopwatch') swSyncAnchor(state)
  if (activeTab !== 'clock') { updateStatus(); return }
  // 用一个"界面状态签名"判断要不要整体重绘。
  // 之前只看"运行态是否变化"，于是「会话跑完 → 点重置」两边都是 running=false，
  // 签名没变就不重绘，界面卡在完成态回不到设置页。现在把 loop/slot/段数/
  // 是否暂停/取时条数都算进签名，任何结构性变化都会触发重绘。
  const sig = clockUiSignature(CLOCK)
  if (sig !== lastClockSignature) {
    lastClockSignature = sig
    renderContent()
    updateStatus()
    return
  }
  updateClockView()
  updateStatus()
})

/** 界面状态签名：只要这些量里有任何一个变了，内容区就必须重建 */
function clockUiSignature(st) {
  if (!st) return 'none'
  if (st.mode === 'stopwatch') {
    return 'sw|' + (st.stopwatch.running ? 1 : 0) + '|' + (st.stopwatch.laps || []).length + '|' + (st.stopwatch.elapsed > 0 ? 1 : 0)
  }
  if (st.mode === 'timer') {
    return 'tm|' + (st.timer.running ? 1 : 0) + '|' + (st.timer.paused ? 1 : 0) + '|' + (st.timer.duration || 0)
  }
  const ss = st.session
  return 'ss|' + (ss.running ? 1 : 0) + '|' + (ss.paused ? 1 : 0) + '|' +
    (ss.slots || []).length + '|' + ss.loop + '|' + ss.slot
}
let lastClockSignature = null

api.onState((state) => {
  STATE = Object.assign({}, STATE, state)
  updateStatus()
  renderContent()
})

/** 只刷新大字与副标题，不重建输入框（否则输入会被打断） */
function updateClockView() {
  const st = CLOCK
  if (!st) return
  const big = document.querySelector('.clock-display')
  const sub = document.querySelector('.clock-sub')
  const mode = st.mode
  if (!big) { renderContent(); return }
  let text = '00:00:00'
  let running = false
  let subText = ''
  if (mode === 'stopwatch') {
    // 大字交给本地插值 ticker，这里只同步运行态与副标题
    text = fmtStopwatch(swLocalElapsed())
    running = st.stopwatch.running
    subText = running ? '计时中' : (st.stopwatch.elapsed > 0 ? '已暂停' : '就绪')
  }
  else if (mode === 'timer') { text = st.timer.text; running = st.timer.running; subText = running ? '倒计时中 · 设定 ' + st.timer.durationText : '设定时间后开始' }
  else {
    text = st.session.text
    running = st.session.running
    subText = st.session.running
      ? '第 ' + (st.session.loop + 1) + ' / ' + st.session.totalLoopsText + ' 轮 · ' + (st.session.label || '')
      : (st.session.paused ? '已暂停 · ' + (st.session.label || '') : '就绪')
  }
  big.textContent = text
  big.className = 'clock-display' + (running ? ' running' : '')
  if (sub && subText) sub.textContent = subText
  // 秒表取时记录条数变化时才整体重绘
  if (mode === 'stopwatch' && (st.stopwatch.laps || []).length !== (document.querySelectorAll('.clock-lap').length)) renderContent()
}

;(async () => {
  DATA = await api.data()
  STATE = Object.assign(STATE, DATA.state || {})
  CLOCK = DATA.clock || await api.clockState()
  swSyncAnchor(CLOCK)
  startSwLocalTicker()
  renderQuick()
  renderTabs()
  renderContent()
  updateStatus()
})()
