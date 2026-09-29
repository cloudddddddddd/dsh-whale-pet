#!/usr/bin/env node
// 首次运行准备：确保桌宠能跑起来。
//
//   1. Electron 运行时（约 200 MB，不进仓库）—— 缺失时用 npm 装到 pet/node_modules
//   2. Live2D Cubism Core —— 版权归 Live2D Inc.，**不随本仓库分发**，
//      这里在需要时从 Live2D 官方 CDN 取一份并缓存到 pet/live2d/vendor/
//
// 用法：
//   node scripts/ensure-runtime.mjs          # 需要时才装
//   node scripts/ensure-runtime.mjs --force  # 强制重装 Electron
//
// 国内网络下 Electron 二进制下载可能卡住，可用镜像：
//   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

import { existsSync, writeFileSync, mkdirSync, statSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { get } from 'node:https'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const PET = join(ROOT, 'pet')
const VENDOR = join(PET, 'live2d', 'vendor')
const CORE = join(VENDOR, 'live2dcubismcore.min.js')
const CORE_URL = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'
const CORE_MIN_BYTES = 150 * 1024 // 正常约 200 KB；明显偏小说明下到了错误页面

const force = process.argv.includes('--force')
let problems = 0

function say(msg) { console.log('[ensure-runtime] ' + msg) }
function fail(msg) { problems++; console.error('[ensure-runtime] ✗ ' + msg) }

// ---------------------------------------------------------------- Electron
function electronBinary() {
  const base = join(PET, 'node_modules', 'electron', 'dist')
  const candidates = process.platform === 'win32'
    ? [join(base, 'electron.exe')]
    : [join(base, 'Electron'), join(base, 'electron')]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts })
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

async function ensureElectron() {
  const found = electronBinary()
  if (found && !force) { say('Electron 已就绪: ' + found); return }
  say(force ? '强制重装 Electron…' : '未找到 Electron，开始安装（约 200 MB，请耐心等待）…')
  if (!process.env.ELECTRON_MIRROR && process.platform === 'win32') {
    say('提示：若下载卡住，可先执行  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/')
  }
  const ok = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: PET })
  if (!ok) { fail('npm install 失败，请手动在 pet/ 目录执行 npm install'); return }
  const after = electronBinary()
  if (after) say('Electron 安装完成: ' + after)
  else fail('npm install 完成但仍未找到 Electron 二进制')
}

// ------------------------------------------------------------- Cubism Core
function download(url, dest) {
  return new Promise((resolve) => {
    const req = get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: 'HTTP ' + res.statusCode }); return }
      mkdirSync(dirname(dest), { recursive: true })
      const out = createWriteStream(dest)
      res.pipe(out)
      out.on('finish', () => { out.close(); resolve({ ok: true }) })
      out.on('error', (e) => resolve({ ok: false, reason: e.message }))
    })
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }) })
    req.on('error', (e) => resolve({ ok: false, reason: e.message }))
  })
}

async function ensureCubismCore() {
  if (existsSync(CORE) && !force) {
    const size = statSync(CORE).size
    if (size >= CORE_MIN_BYTES) { say('Cubism Core 已就绪: ' + Math.round(size / 1024) + ' KB'); return }
    say('现有 Cubism Core 偏小（' + size + ' 字节），重新获取…')
  }
  say('从 Live2D 官方 CDN 获取 Cubism Core …')
  const r = await download(CORE_URL, CORE)
  if (!r.ok) {
    fail('Cubism Core 下载失败（' + r.reason + '）')
    say('可手动下载后放到: ' + CORE)
    say('地址: ' + CORE_URL)
    return
  }
  const size = existsSync(CORE) ? statSync(CORE).size : 0
  if (size < CORE_MIN_BYTES) {
    fail('下载到的 Cubism Core 只有 ' + size + ' 字节，可能不是预期的文件')
    return
  }
  say('Cubism Core 就绪: ' + Math.round(size / 1024) + ' KB')
}

// --------------------------------------------------------------------- main
say('检查桌宠运行时…')
say('pet 目录: ' + PET)
await ensureElectron()
await ensureCubismCore()

// 第三方 JS 运行时（随仓库分发，MIT）
for (const f of ['pixi.min.js', 'cubism4.min.js']) {
  const p = join(VENDOR, f)
  if (existsSync(p)) say('已就绪: ' + f)
  else fail('缺少第三方运行时 ' + f + '（应随仓库分发，请检查安装是否完整）')
}

if (problems > 0) {
  console.error('\n[ensure-runtime] 有 ' + problems + ' 项需要处理，见上面的提示。')
  process.exit(1)
}
console.log('\n[ensure-runtime] ✅ 全部就绪，桌宠可以启动了。')
