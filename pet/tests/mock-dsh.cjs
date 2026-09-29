// Mock DSH whale-girl endpoints for deterministic desktop-pet testing.
// Serves /whale-girl/state (per ?act=), /whale-girl/sessions (?sessions=N),
// /whale-girl/presence, and proxies /whale-girl/assets/* to the real DSH at
// 127.0.0.1:3080 so sprite sheets still load during mock-state runs.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const PORT = Number(process.argv[2] || 3999)
const FIXED_ACT = process.argv[3] || null // pin ?act= to this when given
const FIXED_SESSIONS = process.argv[4] !== undefined ? Number(process.argv[4]) : null // pin ?sessions=
const REAL = 'http://127.0.0.1:3080'

function stateFor(act) {
  const now = Date.now()
  const base = { apiVersion: 1, pet: {}, configRevision: 1, companionOnline: false }
  switch (act) {
    case 'think':
      return { ...base, activity: { name: 'idle', until: 0, sessionThink: true, sessionWait: false, turnCompleted: false, turnCompletedUntil: 0 } }
    case 'wait':
      return { ...base, activity: { name: 'idle', until: 0, sessionThink: false, sessionWait: true, turnCompleted: false, turnCompletedUntil: 0 } }
    case 'celebrate':
      return { ...base, activity: { name: 'idle', until: 0, sessionThink: false, sessionWait: false, turnCompleted: true, turnCompletedUntil: now + 30000 } }
    case 'sleep': // renderer derives sleep from 60s idle; serve idle
    case 'idle':
    default:
      return { ...base, activity: { name: 'idle', until: 0, sessionThink: false, sessionWait: false, turnCompleted: false, turnCompletedUntil: 0 } }
  }
}

function sessionsFor(n) {
  const out = []
  for (let i = 1; i <= n; i += 1) {
    out.push({
      id: `mock-session-${i}`,
      title: `Mock 会话 ${i}`,
      activity: i === 1 ? 'thinking' : 'tool:bash',
      since: Date.now() - 60000 * i,
    })
  }
  return out
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/whale-girl/state') {
    const act = FIXED_ACT || url.searchParams.get('act') || 'idle'
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(stateFor(act)))
    return
  }
  if (url.pathname === '/whale-girl/interact' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let action = 'feed'
      try { action = JSON.parse(body).action } catch { /* keep default */ }
      const replies = {
        feed: ['「啊呜——谢谢投喂！」', '「好好吃，能量满满！」', '「嘻嘻，投喂成功！」'],
        play: ['「嘿嘿，再来一次！」', '「玩得好开心～」', '「我赢了！再来！」'],
      }
      const pool = replies[action] || replies.feed
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ pet: stateFor('idle'), reply: pool[0] }))
    })
    return
  }
  if (url.pathname === '/whale-girl/sessions') {
    const n = FIXED_SESSIONS !== null ? FIXED_SESSIONS : Number(url.searchParams.get('sessions') || 0)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(sessionsFor(n)))
    return
  }
  if (url.pathname === '/whale-girl/presence') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ online: true }))
    return
  }
  if (url.pathname.startsWith('/whale-girl/assets/')) {
    // proxy real sprite sheets so the pet still renders during mock runs
    http.get(REAL + url.pathname, (up) => {
      res.writeHead(up.statusCode, { 'content-type': up.headers['content-type'], 'cache-control': 'no-cache' })
      up.pipe(res)
    }).on('error', () => {
      res.writeHead(502)
      res.end()
    })
    return
  }
  res.writeHead(404)
  res.end()
}).listen(PORT, () => {
  console.log(`[mock-dsh] listening on ${PORT}; /state?act=idle|think|wait|celebrate, /sessions?sessions=N`)
})
