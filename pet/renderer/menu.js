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
]

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

/* -------------------------------------------------------------- status */
function updateStatus() {
  const parts = []
  parts.push('表情 <b>' + (STATE.mood || '自动') + '</b>')
  parts.push('动作 <b>' + (STATE.motion === null ? '待机' : '#' + STATE.motion) + '</b>')
  parts.push('尺寸 <b>' + Math.round((STATE.scale || 1) * 100) + '%</b>')
  parts.push('跟随 <b>' + (STATE.gaze ? '开' : '关') + '</b>')
  document.getElementById('status').innerHTML = '当前 · ' + parts.join(' · ')
}

/* ---------------------------------------------------------------- wire */
// ✕ closes just the panel; 退出程序 quits the pet entirely.
document.getElementById('closeBtn').onclick = () => api.close()
document.getElementById('quitBtn').onclick = () => api.quit()

api.onState((state) => {
  STATE = Object.assign({}, STATE, state)
  updateStatus()
  renderContent()
})

;(async () => {
  DATA = await api.data()
  STATE = Object.assign(STATE, DATA.state || {})
  renderQuick()
  renderTabs()
  renderContent()
  updateStatus()
})()
