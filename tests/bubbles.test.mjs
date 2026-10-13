/**
 * 会话气泡语义的回归测试（不需要启动 dsh，也不需要 Electron）。
 *
 * 用一个最小 mock ctx 加载 lib/index.mjs，然后像宿主那样向
 * `session/event` 投递事件、再调用 /dsh-whale-pet/sessions 检查输出。
 *
 * 运行：node tests/bubbles.test.mjs
 *
 * 覆盖了两类曾经真实发生过的故障：
 *   1) 盲信 sessions.list() —— 它会把【全部】会话（含历史）给出来，
 *      于是每个会话各分一颗气泡，撞上 3 颗上限就成了"永远三个气泡"。
 *   2) DSH 恢复会话时会【重放】历史事件 —— 被当成实时活动，
 *      几个月前的老会话也会凭空顶出一颗气泡。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..', 'lib', 'index.mjs')

// ---- mock 宿主 ----------------------------------------------------------
const handlers = {}
const routes = new Map()

const ctx = {
  get(name) {
    if (name === 'jobs') return { list: () => [] }
    // 故意返回 3 个会话（含一个几个月前的），验证我们【不】盲信它
    if (name === 'sessions') {
      return {
        list: () => [
          { id: 'mine', title: '当前会话', activity: 'done' },
          { id: 'sibling', title: '另一个会话', activity: 'done' },
          { id: 'old-0909', title: '几个月前的老会话', activity: 'done' },
        ],
      }
    }
    return undefined
  },
  on(evt, fn) { (handlers[evt] ||= []).push(fn) },
  effect() { return () => {} },
  logger: () => ({ info() {}, warn() {}, error() {} }),
  webServer: { register(opts) { routes.set(opts.path, opts.handler) } },
}

const mod = await import(pathToFileURL(PLUGIN).href)
mod.apply(ctx, {})

const callSessions = () => {
  const res = {}
  res.writeHead = () => {}
  res.end = (text) => { res.body = JSON.parse(text) }
  routes.get('/dsh-whale-pet/sessions')({ method: 'GET', on() {}, destroy() {} }, res)
  return res.body
}
/** 投递一条会话事件；ageMs 有值则模拟"重放的历史事件"（带 time 字段） */
const fire = (id, type, data, ageMs) => {
  const ev = { type, data }
  if (ageMs !== undefined) ev.time = Date.now() - ageMs
  for (const fn of handlers['session/event'] || []) fn({ id }, ev)
}
const ids = (list) => list.map((x) => x.id).sort()

// ---- 断言 --------------------------------------------------------------
let pass = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log('  ✓ ' + name); return }
  failures.push(name)
  console.log('  ✗ ' + name)
  console.log('      got  = ' + a)
  console.log('      want = ' + e)
}

console.log('\n[1] 账本：只报真正在跑的会话')
check('无事件 -> 无气泡', callSessions(), [])
fire('mine', 'turn/start')
check('列表给 3 个会话、只有 1 个在跑 -> 只出 1 颗', ids(callSessions()), ['mine'])
fire('mine', 'tool/call', { name: 'pwsh' })
check('工具名写进气泡', callSessions()[0].activity, 'tool:pwsh')
fire('mine', 'session/title', { title: '修气泡' })
check('标题写进气泡', callSessions()[0].title, '修气泡')

console.log('\n[2] 回合生命周期')
fire('sibling', 'turn/start')
fire('mine', 'turn/end', { reason: { kind: 'stop' } })
check('回合结束 -> 该会话气泡消失', ids(callSessions()), ['sibling'])
fire('sibling', 'turn/end', { reason: { kind: 'blocked' } })
check('blocked -> 转 waiting 且保留气泡', callSessions().map((x) => x.activity), ['waiting'])
fire('sibling', 'turn/end', { reason: { kind: 'stop' } })
check('正常结束 -> 清空', callSessions(), [])

console.log('\n[3] 重放的历史事件不得产生气泡')
fire('old-0909', 'tool/call', { name: 'pwsh' }, 90 * 24 * 3600 * 1000)
check('重放 90 天前的事件 -> 不出现老会话', callSessions().some((x) => x.id === 'old-0909'), false)

console.log('\n[4] 缺 time 的实时事件必须照常接受')
fire('live-no-time', 'turn/start')
check('无 time 字段 -> 仍记为在跑', ids(callSessions()), ['live-no-time'])
fire('live-no-time', 'turn/end', { reason: { kind: 'stop' } })

console.log('\n[5] 并发上限（放在最后，因为它会留下多个活跃会话）')
for (const id of ['s1', 's2', 's3', 's4', 's5']) fire(id, 'turn/start')
check('5 个并发 -> 最多 3 颗', callSessions().length, 3)

// ---- 汇总 --------------------------------------------------------------
console.log('\n' + '-'.repeat(46))
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`)
  process.exit(0)
}
console.log(`通过 ${pass} 项，失败 ${failures.length} 项：`)
for (const f of failures) console.log('  - ' + f)
process.exit(1)
