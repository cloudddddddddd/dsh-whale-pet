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

  /** 判定一个会话是否"正在跑"。
   *  保守策略：只有拿到明确的活跃证据才认为它在跑 —— 否则历史会话会一直挂在
   *  桌宠头顶（那是会话列表接口把已结束的会话也一起返回了）。 */
  function isActiveSession(s) {
    if (!s || typeof s !== 'object') return false
    // 明确的结束标记优先
    const status = typeof s.status === 'string' ? s.status.toLowerCase() : ''
    if (status === 'done' || status === 'completed' || status === 'closed' ||
        status === 'ended' || status === 'aborted' || status === 'error') return false
    if (s.endedAt || s.finishedAt || s.completedAt) return false
    // 明确的活跃标记
    if (s.running === true || s.active === true) return true
    if (status === 'running' || status === 'active' || status === 'busy') return true
    if (typeof s.activity === 'string' && s.activity && s.activity !== 'done' && s.activity !== 'idle') return true
    // 没有任何线索 -> 不显示（宁可不显示，也不要一片气泡堆在头顶）
    return false
  }

  /** 会话列表（气泡用）。契约：返回**数组**，每项 { id, title, activity }；
   *  activity 为 'done' 时桌宠把那颗气泡移掉。
   *
   *  两个额外约束（避免"头顶一直挂着气泡"）：
   *    1. 插件自己没有任何活动时返回空数组 —— 空闲时桌宠头顶应该是干净的
   *    2. 只保留判定为"正在跑"的会话，并最多 3 个（窗口尺寸也只放得下 3 个） */
  function currentSessions(now) {
    const out = []
    const act = activityName(now)
    if (!act) return out // 空闲：不要气泡
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    if (!sessions || typeof sessions.list !== 'function') return out
    try {
      for (const s of sessions.list()) {
        if (!isActiveSession(s)) continue
        out.push({
          id: String(s.id || ''),
          title: typeof s.title === 'string' && s.title ? s.title : '会话',
          activity: act,
        })
        if (out.length >= 3) break
      }
    } catch { /* 服务异常时返回空表 */ }
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
    // 注意：事件类型字段是 `type`，不是 `kind`
    if (event.type === 'turn/start') {
      thinkUntil = now + TURN_MS
      return
    }
    if (event.type === 'turn/end') {
      thinkUntil = 0
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
      petProc = spawn(bin, [PET_DIR, ...(Array.isArray(config.extraArgs) ? config.extraArgs : [])], {
        cwd: PET_DIR,
        detached: false,
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
