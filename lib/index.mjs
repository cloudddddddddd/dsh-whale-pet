// dsh-whale-pet · Node half
//
// 职责：
//   1. 监听 DSH 会话事件 + 任务快照，推导出桌宠要显示的状态
//   2. 在 /dsh-whale-pet/* 下提供服务端端点，供 Electron 桌宠轮询
//   3. 按需拉起 / 停止 Electron 桌宠进程
//
// 端点契约（Electron 桌宠是唯一消费者）：
//   GET  /dsh-whale-pet/state       -> { online, state: { activity: {...} } }
//   GET  /dsh-whale-pet/sessions    -> { sessions: [{ id, title, action, ... }] }
//   POST /dsh-whale-pet/presence    -> { ok }  （心跳；桌宠在线标记）
//   POST /dsh-whale-pet/interact    -> { reply }（喂食 / 玩耍）
//   GET  /dsh-whale-pet/web-url     -> { url }（带鉴权 token 的 Web GUI 地址；dsh 0.2+）
//   GET  /dsh-whale-pet/runtime-info-> { nodeExe, dshBin, dshHome, webUrl, ... }
//                                      （让桌宠不必硬编码 dsh 运行时路径）
//
// 状态推导与 whale-girl 插件（MIT, © Sam Gao (vlln)）的实现思路一致：
//   - 任务快照 running -> completed/failed 的翻转派生 celebrate / error burst
//   - 会话 turn/start 与 turn/end(blocked) 派生 sessionThink / sessionWait
// 本插件不复制其代码，只按同样的数据源重写了一份精简实现。

import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PET_DIR = join(HERE, '..', 'pet')
const ROUTE = '/dsh-whale-pet'

// ---- 时间窗口 -------------------------------------------------------------
const BURST_MS = 6000      // 庆祝 / 出错的停留时间
const ERROR_MS = 4000      // 失败窗口（与请求错误共用）
const TURN_MS = 120000     // 思考 / 等待状态的保持上限
const PRESENCE_TTL_MS = 45000

// ---- 互动回复池 -----------------------------------------------------------
const FEED_REPLIES = [
  '好吃！还要！', '呜哇——是小鱼干！', '谢谢你～', '这个我最喜欢了！',
  '吃饱了有力气干活了', '唔…好甜', '再来一份也可以哦',
]
const PLAY_REPLIES = [
  '再玩一会儿嘛～', '接住啦！', '嘿嘿，好开心', '飞起来咯——', '陪我玩最好了',
  '球球给我！', '转一圈给你看',
]
const PET_REPLIES = [
  '唔…好舒服', '再摸摸嘛', '嘿嘿…', '这里这里！', '被摸头会变强的',
]

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

export const name = 'dsh-whale-pet'

export const inject = ['jobs', 'sessions', 'webServer']

export const Config = z.object({
  /** 插件加载时自动拉起桌面桌宠 */
  autoStart: z.boolean().default(true),
  /** 桌宠轮询 DSH 状态的间隔（毫秒） */
  pollMs: z.number().default(1000),
  /** 额外传给 Electron 的命令行参数 */
  extraArgs: z.array(z.string()).default([]),
})

export function apply(ctx, config) {
  const log = ctx.logger ? ctx.logger('dsh-whale-pet') : null
  const say = (msg) => { try { log && log.info(msg) } catch { /* 无 logger 时静默 */ } }
  const warn = (msg) => { try { log && log.warn(msg) } catch { /* 同上 */ } }

  // ---- 状态账本 -----------------------------------------------------------
  let working = false
  let celebrateUntil = 0
  let errorUntil = 0
  let thinkUntil = 0
  let waitUntil = 0
  let welcomeUntil = 0
  let lastPresenceAt = 0
  let lastSessionId = null
  let currentTool = null // 最近一次工具调用名，用于气泡文案
  // ---- dsh-emoji 设置桥接 -------------------------------------------------
  // 让桌宠控制面板也能改表情包设置，不必再进 Web GUI 的插件页。
  // dsh 的 settings 服务（0.2.0）用法来自 dsh-emoji 自己的服务端代码：
  //   settings.describe({ redactSecrets: true }) 读，settings.replace(ns, value, revision) 写
  const EMOJI_NS = 'dsh-emoji'
  // 允许被外部修改的字段。packRevision 不在其中：它由 dsh-emoji 自己维护，
  // 这里只在写回时透传/兜底，不能由调用方随意指定。
  const EMOJI_FIELDS = ['mode', 'displaySize', 'activePack', 'customPrompt']
  let lastSessionCount = -1
  const known = new Map() // taskId -> 上次状态

  /** 收集任务快照：既收 agent 名下的，也收全局的（与 whale-girl 同源）。 */
  function collectTasks() {
    const out = []
    const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined
    if (!jobs || typeof jobs.list !== 'function') return out
    const push = (snap) => {
      if (snap && typeof snap === 'object' && typeof snap.id === 'string') {
        out.push({ id: snap.id, status: typeof snap.status === 'string' ? snap.status : 'unknown' })
      }
    }
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      if (agents && typeof agents.list === 'function') {
        for (const agent of agents.list()) {
          try { for (const snap of jobs.list(agent)) push(snap) } catch { /* 单个 agent 失败不影响整体 */ }
        }
      }
    } catch { /* agents 服务缺席 */ }
    try { for (const snap of jobs.list()) push(snap) } catch { /* 无全局 job */ }
    return out
  }

  /** 任务快照翻转 -> working / celebrate / error。 */
  function deriveActivity(now) {
    const tasks = collectTasks()
    if (tasks.length === 0) known.clear()
    const running = tasks.filter((t) => t.status === 'running' || t.status === 'stopping')
    const wasWorking = working
    working = running.length > 0
    let sawKill = false
    for (const t of tasks) {
      const prev = known.get(t.id)
      if (prev === 'running' && t.status === 'completed') celebrateUntil = Math.max(celebrateUntil, now + BURST_MS)
      else if (prev === 'running' && t.status === 'failed') errorUntil = Math.max(errorUntil, now + ERROR_MS)
      else if (prev === 'running' && t.status === 'killed') sawKill = true
      known.set(t.id, t.status)
    }
    // 从"有任务"掉回"没任务"也算完成（任务可能直接从列表消失）
    if (wasWorking && !working && !sawKill) celebrateUntil = Math.max(celebrateUntil, now + BURST_MS)
    // 收缩记账，避免长会话内存增长
    if (tasks.length > 0) {
      const ids = new Set(tasks.map((t) => t.id))
      for (const key of known.keys()) if (!ids.has(key)) known.delete(key)
    }
  }

  /** 会话级的 activity 名（桌宠的 renderer 用 stateOf() 分类，用 actionLabel() 显示）。 */
  function activityName(now) {
    if (waitUntil > now) return 'waiting'
    if (errorUntil > now) return 'error'
    if (thinkUntil > now) return 'thinking'
    if (working) return currentTool ? `tool:${currentTool}` : 'tool:running'
    if (celebrateUntil > now) return 'done'
    return ''
  }

  /** 桌宠最外层活动：status('waiting'|'thinking'|...) + 时间窗口。
   *  注意契约：桌宠把本端点的响应整体放进 payload.state，
   *  所以这里返回的必须是 state 对象本身，而不是 { online, state }。 */
  function currentActivity(now) {
    const waiting = waitUntil > now
    const thinking = thinkUntil > now
    let status = 'idle'
    let label = ''
    let until = 0
    if (waiting) { status = 'wait'; label = '等待你的批准'; until = waitUntil }
    else if (errorUntil > now) { status = 'error'; label = '出错了…'; until = errorUntil }
    else if (celebrateUntil > now) { status = 'celebrate'; label = '完成啦！'; until = celebrateUntil }
    else if (thinking) { status = 'think'; label = '深度思考中'; until = thinkUntil }
    else if (working) { status = 'working'; label = currentTool ? `执行 ${currentTool} 中` : '正在干活…'; until = now + 3000 }
    else if (welcomeUntil > now) { status = 'welcome'; label = '我回来啦～'; until = welcomeUntil }
    return {
      activity: {
        name: status,
        label,
        until,
        sessionThink: thinking,
        sessionWait: waiting,
        presence: lastPresenceAt > 0,
      },
    }
  }

  // ---- 会话账本（气泡的唯一数据源）--------------------------------------
  // 为什么不直接信 sessions.list()：它会把【全部】会话都给出来（含历史/已结束的）。
  // 早先盲信它 → 每个会话各分一颗气泡（上限 3 颗，于是"永远三个气泡"）；
  // 而更早那版去猜字段过滤 → 又把气泡全滤光了。两次都错在"猜"。
  //
  // 正解是照上游 whale-girl 的语义，用 session/event 自己记每会话活动：
  //   turn/start            -> thinking
  //   tool/call             -> tool:<name>
  //   turn/end(blocked)     -> waiting
  //   turn/end(其它)        -> done   ← 活动为 done 的会话不出气泡
  const sessionLedger = new Map() // id -> { id, title, activity, since, at }
  const LEDGER_MAX = 24 // 最多同时记账的会话数
  const LEDGER_TTL = 30 * 60e3 // 半小时没动静就从账本里删掉
  // 事件"新鲜"窗口：超过这么久没再收到该会话的任何事件，就不再当作在跑。
  // 真正的运行中回合会持续产生事件（turn/start、tool/call、流式输出），
  // 静默这么久基本就是已经结束了。
  const LIVE_FRESH_MS = 120000
  // 重放判定：DSH 在恢复会话时会把【历史事件】也走一遍 session/event。
  // 事件自带 time（epoch ms），比现在早很多的直接当历史丢掉。
  // 否则一个几个月前的老会话会被记成"正在跑 pwsh"，头顶凭空多出一颗气泡。
  const REPLAY_AGE_MS = 120000

  const replayWarned = new Set() // 每个会话只提示一次"收到重放事件"

  function touchSession(id, patch) {
    if (!id) return undefined
    const now = Date.now()
    let v = sessionLedger.get(id)
    if (!v) {
      if (sessionLedger.size >= LEDGER_MAX) {
        // 优先淘汰"已结束且最久没动"的；全是活跃的才退而淘汰最久没动的
        let victim = null
        for (const [k, val] of sessionLedger) {
          if (val.activity === 'done' && (!victim || val.at < victim[1].at)) victim = [k, val]
        }
        if (!victim) {
          for (const [k, val] of sessionLedger) if (!victim || val.at < victim[1].at) victim = [k, val]
        }
        if (victim) sessionLedger.delete(victim[0])
      }
      v = { id, title: null, activity: 'done', since: now, at: now }
      sessionLedger.set(id, v)
    }
    if (patch && patch.title) v.title = patch.title
    if (patch && patch.activity !== undefined) v.activity = patch.activity
    v.at = now
    return v
  }

  /** 把一条会话事件落到账本（语义与上游 whale-girl 的 parseSessionEvent 一致） */
  function recordSessionEvent(id, event) {
    // 先过重放：历史事件不参与账本（见 REPLAY_AGE_MS 的说明）
    const t = Number(event.time)
    if (Number.isFinite(t) && t > 0 && Date.now() - t > REPLAY_AGE_MS) {
      if (id && !replayWarned.has(id)) {
        replayWarned.add(id)
        console.log('[dsh-whale-pet] ignored replayed events for ' + id.slice(0, 20) + ' (age ' + Math.round((Date.now() - t) / 1000) + 's)')
      }
      return
    }
    if (event.type === 'turn/start') { touchSession(id, { activity: 'thinking' }); return }
    if (event.type === 'tool/call') {
      const d = event.data && typeof event.data === 'object' ? event.data : null
      const nm = d && typeof d.name === 'string' ? d.name : null
      if (nm) touchSession(id, { activity: 'tool:' + nm })
      return
    }
    if (event.type === 'turn/end') {
      const reason = event.data && typeof event.data === 'object' ? event.data.reason : null
      const blocked = reason && typeof reason === 'object' && reason.kind === 'blocked'
      touchSession(id, { activity: blocked ? 'waiting' : 'done' })
      return
    }
    if (event.type === 'session/title') {
      const d = event.data && typeof event.data === 'object' ? event.data : null
      const t = d && typeof d.title === 'string' ? d.title : null
      if (t) touchSession(id, { title: t })
    }
  }

  /** 会话列表（气泡用）。契约：返回**数组**，每项 { id, title, activity }；
   *  activity 为 'done' 时桌宠把那颗气泡移掉。
   *
   *  只报"账本里还没结束"的会话，最多 3 个（窗口也只放得下 3 颗气泡）。
   *  回合一 end，对应活动就变 done，气泡自然消失 —— 不需要猜任何字段。 */
  function currentSessions() {
    const out = []
    const now = Date.now()
    for (const [k, v] of sessionLedger) {
      if (now - v.at > LEDGER_TTL) sessionLedger.delete(k)
    }
    for (const v of sessionLedger.values()) {
      if (v.activity === 'done') continue // 回合已结束 -> 不出气泡
      // 太久没动静也不当作在跑（兜底：万一没拿到 event.time，重放事件
      // 会以"刚刚收到"的姿态混进账本，靠这条在 LIVE_FRESH_MS 后自动消掉）
      if (now - v.at > LIVE_FRESH_MS) continue
      out.push({ id: v.id, title: v.title || '会话', activity: v.activity })
      if (out.length >= 3) break
    }
    if (out.length !== lastSessionCount) {
      lastSessionCount = out.length
      console.log('[dsh-whale-pet] bubbles=' + out.length + ' tracked=' + sessionLedger.size)
    }
    return out
  }

  // ---- 会话事件 -----------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const now = Date.now()
    if (session && session.id && session.id !== lastSessionId) {
      lastSessionId = session.id
      welcomeUntil = now + 2500 // 新会话出场打招呼
    }
    if (!event || typeof event !== 'object') return
    // 先落账本：这是气泡的唯一数据源（与下面的全局状态各管各的）
    recordSessionEvent(session && session.id ? String(session.id) : null, event)
    // 注意：事件类型字段是 `type`，不是 `kind`
    // 工具调用：记下工具名，气泡才能显示"执行 pwsh 工具"这类具体文案
    if (event.type === 'tool/call') {
      const d = event.data && typeof event.data === 'object' ? event.data : null
      const nm = d && typeof d.name === 'string' ? d.name : null
      if (nm) currentTool = nm
      return
    }
    if (event.type === 'turn/start') {
      thinkUntil = now + TURN_MS
      return
    }
    if (event.type === 'turn/end') {
      thinkUntil = 0
      currentTool = null // 回合结束，清掉工具名
      const reason = event.data && typeof event.data === 'object' ? event.data.reason : null
      const blocked = reason && typeof reason === 'object' && reason.kind === 'blocked'
      if (blocked) waitUntil = now + TURN_MS
      else celebrateUntil = Math.max(celebrateUntil, now + BURST_MS)
    }
  })

  ctx.on('agent/request-error', () => { errorUntil = Date.now() + ERROR_MS })

  ctx.on('agent/session-start', () => { welcomeUntil = Date.now() + 2500 })

  // ---- 轮询任务快照 -------------------------------------------------------
  const pollMs = Number.isFinite(config.pollMs) && config.pollMs >= 200 ? config.pollMs : 1000
  const timer = setInterval(() => {
    try { deriveActivity(Date.now()) } catch (err) { warn('derive failed: ' + (err && err.message)) }
  }, pollMs)
  if (typeof timer.unref === 'function') timer.unref()

  // ---- HTTP 端点 ----------------------------------------------------------
  /** 取 dsh 的 settings 服务（拿不到返回 undefined，不抛） */
  function settingsService() {
    try { return typeof ctx.get === 'function' ? ctx.get('settings') : undefined } catch { return undefined }
  }

  /** 读 dsh-emoji 的设置 -> { settings, revision }；读不到返回 null。
   *  API 用法取自 dsh-emoji 自己的服务端代码：
   *    settings.describe({ redactSecrets: true }) 读，settings.replace(ns, value, revision) 写 */
  function readEmojiSettings() {
    const svc = settingsService()
    if (!svc || typeof svc.describe !== 'function') return null
    try {
      const list = svc.describe({ redactSecrets: true })
      const entry = Array.isArray(list) ? list.find((e) => e && e.ns === EMOJI_NS) : null
      if (!entry) return null
      // SettingsDescriptor 的字段是 value（不是 settings）：
      //   interface SettingsDescriptor { ns, value, revision, schema, ... }
      // dsh-emoji 自己的服务端也是这样取的：parseEmojiSettings(descriptor.value)
      // 必须原样保留【全部】字段：服务端 parseEmojiSettings() 要求
      // mode / displaySize / customPrompt / activePack / packRevision 一个不少，
      // 早先这里只留了 4 个（漏掉 packRevision），写回时被 Host 判为
      // "无效的设置请求"。所以读回来是什么就存什么。
      const s = entry.value && typeof entry.value === 'object' ? { ...entry.value } : {}
      return { settings: s, revision: entry.revision }
    } catch (err) {
      warn('read emoji settings failed: ' + (err && err.message))
      return null
    }
  }

  /** 浅合并后整体 replace。
   *  注意：这里每次都重新读一次拿最新 revision（读-改-写），所以不会因为
   *  revision 过期而写失败；代价是不做乐观锁 —— 极端并发下后者会覆盖前者。
   *  对「单用户偶尔改表情包设置」这个场景，可用性优先于乐观锁。 */
  async function writeEmojiSettings(patch) {
    const svc = settingsService()
    if (!svc || typeof svc.replace !== 'function') throw new Error('settings service unavailable')
    const cur = readEmojiSettings()
    if (!cur) throw new Error('dsh-emoji settings not found')
    const next = { ...cur.settings }
    // 只允许改白名单字段，避免调用方塞入未定义键把整份文档写脏
    for (const k of EMOJI_FIELDS) {
      if (patch && k in patch && patch[k] !== undefined) next[k] = patch[k]
    }
    // 兜底：缺少这两个必填字段时补默认值，否则服务端校验会整份拒绝
    if (typeof next.customPrompt !== 'string') next.customPrompt = ''
    if (typeof next.packRevision !== 'number' || !Number.isSafeInteger(next.packRevision) || next.packRevision < 0) {
      next.packRevision = 0
    }
    await svc.replace(EMOJI_NS, next, cur.revision)
    return readEmojiSettings()
  }

  function sendJson(res, code, body) {
    const text = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(text)
  }

  function readBody(req, limit = 1024) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) { req.destroy(); resolve(null); return }
        chunks.push(c)
      })
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
        catch { resolve(null) }
      })
      req.on('error', () => resolve(null))
    })
  }

  /** 桌宠要打开的 Web GUI 地址。
   *  dsh 0.2+ 的 Web 服务带鉴权栅栏：根路径必须是带一次性 ?token= 的地址
   *  （换取 cookie 后重定向到干净地址）；rc.6 没有这道栅栏，返回普通地址即可。 */
  function resolveWebUrl() {
    const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    const port = ws && typeof ws.port === 'number' ? ws.port : Number(process.env.DSH_WEB_PORT)
    if (!Number.isFinite(port) || port <= 0) return null
    const host = ws && typeof ws.host === 'string' && ws.host && ws.host !== '0.0.0.0' ? ws.host : '127.0.0.1'
    const base = 'http://' + host + ':' + String(port)
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection && typeof connection.authenticatedUrl === 'function') {
      try { return connection.authenticatedUrl(base) } catch { /* 退回无鉴权地址 */ }
    }
    return base
  }

  /** 运行时事实：桌宠用它来重启 / 定位 dsh，而不是在 main.cjs 里写死路径。 */
  function runtimeInfo() {
    const home = typeof ctx.get === 'function' && typeof ctx.get('dshHomePath') === 'string'
      ? ctx.get('dshHomePath')
      : (process.env.DSH_HOME || null)
    return {
      nodeExe: process.execPath,
      dshBin: process.argv[1] || null,
      dshArgs: process.argv.slice(2),
      dshHome: home,
      cwd: process.cwd(),
      pid: process.pid,
      webUrl: resolveWebUrl(),
    }
  }

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/web-url`,
    handler: (_req, res) => { sendJson(res, 200, { url: resolveWebUrl() }) },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/runtime-info`,
    handler: (_req, res) => { sendJson(res, 200, runtimeInfo()) },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/state`,
    handler: (_req, res) => { sendJson(res, 200, currentActivity(Date.now())) },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/sessions`,
    handler: (_req, res) => { sendJson(res, 200, currentSessions(Date.now())) },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/presence`,
    handler: async (req, res) => {
      lastPresenceAt = Date.now()
      sendJson(res, 200, { ok: true })
    },
  })

  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/interact`,
    handler: async (req, res) => {
      const body = await readBody(req)
      if (body === null) { sendJson(res, 400, { error: 'bad body' }); return }
      const action = typeof body.action === 'string' ? body.action : 'feed'
      const reply = action === 'play' ? pick(PLAY_REPLIES)
        : action === 'pet' ? pick(PET_REPLIES)
          : pick(FEED_REPLIES)
      celebrateUntil = Math.max(celebrateUntil, Date.now() + 3000)
      sendJson(res, 200, { action, reply })
    },
  })

  // ---- 桌宠进程 -----------------------------------------------------------
  let petProc = null

  function electronBinary() {
    // pet/node_modules/electron 里装好后，二进制路径可由其 index.js 解析；
    // 这里直接找 dist 目录，避免依赖它的运行时导出。
    const base = join(PET_DIR, 'node_modules', 'electron', 'dist')
    const candidates = process.platform === 'win32'
      ? [join(base, 'electron.exe')]
      : [join(base, 'Electron'), join(base, 'electron')]
    for (const c of candidates) if (existsSync(c)) return c
    return null
  }

  function startPet() {
    if (petProc && !petProc.killed) { say('桌宠已在运行'); return { started: false, reason: 'already-running' } }
    const bin = electronBinary()
    if (!bin) {
      warn('未找到 Electron 运行时，请先执行: node scripts/ensure-runtime.mjs')
      return { started: false, reason: 'electron-missing' }
    }
    if (!existsSync(PET_DIR)) {
      warn('未找到 pet/ 目录: ' + PET_DIR)
      return { started: false, reason: 'pet-missing' }
    }
    try {
      // ELECTRON_RUN_AS_NODE turns electron.exe into plain Node (the DSH desktop
      // app's own terminal exports it); inherited, the pet window dies instantly
      // with "Cannot read properties of undefined (reading 'requestSingleInstanceLock')".
      const petEnv = { ...process.env }
      delete petEnv.ELECTRON_RUN_AS_NODE
      petProc = spawn(bin, [PET_DIR, ...(Array.isArray(config.extraArgs) ? config.extraArgs : [])], {
        cwd: PET_DIR,
        env: petEnv,
        // detached: true —— 让桌宠成为独立进程，不再是本后端的子进程。
        // 否则"重启后端"时会连带影响桌宠（它去杀父进程，自己也跟着没），
        // 这正是重启按钮表现为"整个退出"的根本原因。
        detached: true,
        stdio: 'ignore',
        windowsHide: true, // 避免弹出控制台黑窗
      })
      petProc.on('exit', (code) => { say('桌宠进程退出 code=' + code); petProc = null })
      petProc.on('error', (err) => { warn('桌宠启动失败: ' + (err && err.message)); petProc = null })
      say('桌宠已启动 pid=' + (petProc.pid || '?'))
      return { started: true, pid: petProc.pid }
    } catch (err) {
      warn('spawn 异常: ' + (err && err.message))
      return { started: false, reason: 'spawn-failed' }
    }
  }

  function stopPet() {
    if (!petProc || petProc.killed) return { stopped: false, reason: 'not-running' }
    try { petProc.kill() } catch { /* 进程可能已退出 */ }
    petProc = null
    say('桌宠已停止')
    return { stopped: true }
  }

  // 表情包设置：让桌宠控制面板直接改 dsh-emoji 的配置，不必进 Web GUI 的插件页
  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/emoji-settings`,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        const cur = readEmojiSettings()
        sendJson(res, cur ? 200 : 503, cur
          ? { ok: true, ...cur }
          : { ok: false, error: 'dsh-emoji 设置不可用（插件未加载或服务未就绪）' })
        return
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req, 8192)
          const next = await writeEmojiSettings(body || {})
          sendJson(res, next ? 200 : 500, next ? { ok: true, ...next } : { ok: false, error: '写入后读取失败' })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
        }
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    },
  })

  // 控制端点：让用户从 DSH 侧启停桌宠
  ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/control`,
    handler: async (req, res) => {
      const body = await readBody(req)
      const action = body && typeof body.action === 'string' ? body.action : 'status'
      if (action === 'start') { sendJson(res, 200, startPet()); return }
      if (action === 'stop') { sendJson(res, 200, stopPet()); return }
      sendJson(res, 200, {
        running: !!(petProc && !petProc.killed),
        pid: petProc ? petProc.pid : null,
        electronReady: !!electronBinary(),
      })
    },
  })

  // ---- 自动启动 -----------------------------------------------------------
  if (config.autoStart) {
    // 等一轮事件循环再拉起来，避免与宿主启动争抢资源
    const kick = setTimeout(() => {
      try { startPet() } catch (err) { warn('autoStart 失败: ' + (err && err.message)) }
    }, 1200)
    if (typeof kick.unref === 'function') kick.unref()
  }

  // ---- 生命周期 -----------------------------------------------------------
  return () => {
    try { clearInterval(timer) } catch { /* 忽略 */ }
    try { stopPet() } catch { /* 忽略 */ }
    say('已卸载')
  }
}
