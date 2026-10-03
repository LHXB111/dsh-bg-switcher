/**
 * dsh-bg-switcher —— 宿主（Node）半区
 *
 * 提供四件事：
 *   ① 图库清单：内置图（包内 assets/backgrounds）+ 用户图库（profile/data/dsh-bg-switcher/backgrounds）
 *   ② 图片与缩略图的字节流（缩略图在 macOS 上用系统自带 sips 懒生成并缓存）
 *   ③ 设置持久化（profile/data/dsh-bg-switcher/settings.json）——选区、遮罩、模糊、悬浮按钮坐标
 *   ④ index.html 注入行：把浏览器半区 lib/widget.js 挂进页面（服务端形态走渲染行，桌面形态走 index-inject 表）
 *
 * 只依赖 node 内置模块，不引入任何运行时依赖。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_NAME = 'dsh-bg-switcher'
const ROUTE_PREFIX = '/dsh-bg'
const WIDGET_SRC = '/dsh-bg/widget.js'
const DATA_DIR_NAME = 'dsh-bg-switcher'

const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_FILE_BYTES = 48 * 1024 * 1024
const THUMB_MAX_EDGE = 480

/** 支持的图片扩展名 → MIME。 */
const IMAGE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp']
])

/** data URL / 上传声明的 MIME → 落盘扩展名。 */
const UPLOAD_MIME_EXT = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif'],
  ['image/bmp', '.bmp']
])

const BOOLEAN_KEYS = ['split', 'immersive', 'hidden', 'rotateOn', 'parallax']
const NUMBER_RANGES = {
  dim: [0, 100],
  blur: [0, 24],
  btnX: [-8000, 8000],
  btnY: [-8000, 8000],
  // 轮播间隔：1 分钟 ~ 12 小时
  rotateMinutes: [1, 720]
}
const MODES = ['cover', 'contain', 'tile']
const ROTATE_ORDERS = ['random', 'inOrder']
const ID_PATTERN = /^(?:builtin|user):[^\u0000/\\]{1,200}$/

const DEFAULT_SETTINGS = {
  activeId: null,
  lightId: null,
  darkId: null,
  split: false,
  immersive: true,
  hidden: false,
  mode: 'cover',
  dim: 45,
  blur: 0,
  btnX: 0,
  btnY: 0,
  rotateOn: false,
  rotateMinutes: 30,
  rotateOrder: 'random',
  parallax: true
}

// ── 路径 ────────────────────────────────────────────────────────────────────

/**
 * 排障用痕迹：只有设了 DSH_BG_TRACE=<文件路径> 才会写，平时完全是空操作。
 * 排查"插件到底加载到哪一步"时：DSH_BG_TRACE=/tmp/bg.log dsh web ...
 */
function trace(message) {
  const target = process.env.DSH_BG_TRACE
  if (!target) return
  try {
    appendFileSync(target, `${new Date().toISOString()} [pid ${process.pid}] [${PLUGIN_NAME}] ${message}\n`)
  } catch {
    /* 忽略 */
  }
}

function profileName() {
  const profile = process.env.DSH_DESKTOP_PROFILE
  return profile && /^[A-Za-z0-9_-]+$/.test(profile) ? profile : 'web'
}

function profileDir() {
  // 官方桌面端不会设 DSH_DESKTOP_PROFILE（那是社区版的环境变量），profile 名是 desktop，
  // 光靠环境变量会算到 profiles/web 去。所以优先按插件自身位置反推：
  //   <DSH_HOME>/profiles/<profile>/{.local-plugins,node_modules}/<name>/lib
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidate = join(here, '..', '..', '..')
    if (basename(dirname(candidate)) === 'profiles') return candidate
  } catch {
    /* 探测失败则回落环境变量 */
  }
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', profileName())
}

function pluginDir() {
  return join(profileDir(), 'data', DATA_DIR_NAME)
}

function userDir() {
  return join(pluginDir(), 'backgrounds')
}

function thumbDir() {
  return join(pluginDir(), 'thumbs')
}

function settingsPath() {
  return join(pluginDir(), 'settings.json')
}

function builtinDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'backgrounds')
}

function widgetPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'widget.js')
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length)
  })
  res.end(body)
}

function sendText(res, status, text) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length)
  })
  res.end(body)
}

function sendBytes(res, status, bytes, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': String(bytes.length),
    ...extraHeaders
  })
  res.end(bytes)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        req.destroy()
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function query(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').searchParams
  } catch {
    return new URLSearchParams()
  }
}

// ── 本机信任栅栏 ────────────────────────────────────────────────────────────
// 与 dsh-whale-widget 同一套思路：插件自校验（回环 Host / 非跨站 / Origin 同源），
// 宿主 provided 的 connection.requestRejection 可用时再委托一次，任何时候失败都按拒绝处理。

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return false
  if (Number(match[1]) !== 127) return false
  return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

function trustedAuthorities() {
  return String(process.env.DSHW_TRUSTED_HOSTS || process.env.DSH_TRUSTED_HOSTS || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

/**
 * 允许跨源访问插件接口的来源：
 *   · 官方桌面端页面 `dsh-app://app`（页面走自定义协议，对 http 宿主就是跨源）；
 *   · 本机回环 http(s) 来源（社区版、浏览器直开）；
 *   · DSH_BG_TRUSTED_ORIGINS 里显式声明过的来源（逗号分隔）。
 * @returns {string|null} 允许的来源，null 表示不是跨源白名单来源。
 */
function corsOrigin(req) {
  const headers = (req && req.headers) || {}
  const origin = typeof headers.origin === 'string' ? headers.origin : ''
  if (origin === '' || origin === 'null') return null
  let parsed = null
  try {
    parsed = new URL(origin)
  } catch {
    return null
  }
  if (parsed.protocol === 'dsh-app:') return origin
  const host = parsed.hostname.toLowerCase()
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return origin
  const listed = String(process.env.DSH_BG_TRUSTED_ORIGINS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return listed.includes(origin) ? origin : null
}

/** 跨源响应该带的头（含预检）。 */
function corsHeaders(origin, req) {
  if (origin === null) return null
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  }
  const wantsPrivate = String(((req && req.headers) || {})['access-control-request-private-network'] || '')
  if (wantsPrivate.toLowerCase() === 'true') headers['Access-Control-Allow-Private-Network'] = 'true'
  return headers
}

/** @returns {number|null} 需要拒绝时的状态码，放行时 null。 */
function fenceRejection(req, ctx) {
  try {
    const headers = (req && req.headers) || {}
    let hostUrl = null
    try {
      hostUrl = new URL('http://' + String(headers.host || ''))
    } catch {
      return 403
    }
    if (!isLoopbackHostname(hostUrl.hostname)) {
      const authority = hostUrl.host.toLowerCase()
      const listed = trustedAuthorities().some((entry) =>
        entry.includes(':') ? entry === authority : entry === hostUrl.hostname.toLowerCase()
      )
      if (!listed) {
        let delegated = null
        try {
          const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
          if (connection && typeof connection.requestRejection === 'function') {
            delegated = connection.requestRejection(req)
          }
        } catch {
          return 403
        }
        if (!delegated) return 403
        return typeof delegated === 'number' ? delegated : 403
      }
    }
    const site = String(headers['sec-fetch-site'] || '').toLowerCase()
    // 白名单来源（官方桌面端壳 / 回环）本身就是跨站标记，不能按 cross-site 拒
    const allowedOrigin = corsOrigin(req)
    if (site === 'cross-site' && allowedOrigin === null) return 403
    const origin = headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null' && allowedOrigin === null) {
      let originUrl = null
      try {
        originUrl = new URL(origin)
      } catch {
        return 403
      }
      if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
    }
    return null
  } catch {
    return 403
  }
}

// ── 图片尺寸（只读文件头，不依赖任何图像库） ─────────────────────────────────

function readImageSize(path, ext) {
  let fd
  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(256 * 1024)
    const read = readSync(fd, head, 0, head.length, 0)
    const buf = head.subarray(0, read)
    if (buf.length < 16) return null
    if (ext === '.png') {
      if (buf.readUInt32BE(0) !== 0x89504e47) return null
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (ext === '.gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (ext === '.bmp') {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) }
    }
    if (ext === '.webp') {
      const fourcc = buf.toString('latin1', 12, 16)
      if (fourcc === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      }
      if (fourcc === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      }
      if (fourcc === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      return null
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      let at = 2
      while (at + 9 < buf.length) {
        if (buf[at] !== 0xff) {
          at += 1
          continue
        }
        const marker = buf[at + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          at += 2
          continue
        }
        const length = buf.readUInt16BE(at + 2)
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        if (isSof) {
          return { height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) }
        }
        if (length < 2) return null
        at += 2 + length
      }
      return null
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略 */
      }
    }
  }
}

// ── 图库 ────────────────────────────────────────────────────────────────────

function displayName(file) {
  const ext = extname(file)
  return ext === '' ? file : file.slice(0, -ext.length)
}

function listDir(dir, source) {
  if (!existsSync(dir)) return []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const items = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (!IMAGE_TYPES.has(ext)) continue
    const path = join(dir, entry.name)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    const size = readImageSize(path, ext)
    items.push({
      id: `${source}:${entry.name}`,
      file: entry.name,
      name: displayName(entry.name),
      source,
      bytes: stats.size,
      mtime: Math.round(stats.mtimeMs),
      width: size === null ? null : size.width,
      height: size === null ? null : size.height
    })
  }
  items.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true }))
  return items
}

function listGallery() {
  return [...listDir(builtinDir(), 'builtin'), ...listDir(userDir(), 'user')]
}

/** id → 磁盘上的条目；任何越界/非法 id 都返回 null。 */
function resolveItem(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null
  const at = id.indexOf(':')
  const source = id.slice(0, at)
  const file = id.slice(at + 1)
  // 只认"纯文件名"：basename 相等 ⇒ 不可能带目录分隔符；'.' / '..' 再单独挡掉。
  if (file === '' || file === '.' || file === '..' || file !== basename(file)) return null
  const ext = extname(file).toLowerCase()
  if (!IMAGE_TYPES.has(ext)) return null
  const dir = source === 'builtin' ? builtinDir() : userDir()
  const path = join(dir, file)
  try {
    if (!statSync(path).isFile()) return null
  } catch {
    return null
  }
  return { id, source, file, path, ext, mime: IMAGE_TYPES.get(ext) }
}

/** macOS 上用系统 sips 懒生成缩略图；其他平台（或失败）回落到原图。 */
/**
 * 缩略图引擎：都是系统自带的工具，不引入任何 npm 依赖。
 *   · macOS  → sips
 *   · Windows→ PowerShell + System.Drawing（Win10/11 自带）
 *   · Linux  → magick / convert / ffmpeg（有哪个用哪个）
 * 一个都用不了时返回 null，此时 /thumb 直接回原图（面板仍可用，只是大图会慢些）。
 * 可用 DSH_BG_THUMB_ENGINE=sips|powershell|magick|convert|ffmpeg|none 强制指定或关掉。
 */
const THUMB_ENGINES = new Set(['sips', 'powershell', 'magick', 'convert', 'ffmpeg'])
let thumbEngineCache = { key: null, value: null }

function whichCommand(command) {
  try {
    return spawnSync('which', [command], { stdio: 'ignore', timeout: 5000 }).status === 0
  } catch {
    return false
  }
}

function thumbEngine() {
  const forced = String(process.env.DSH_BG_THUMB_ENGINE || '').trim().toLowerCase()
  if (thumbEngineCache.key === forced) return thumbEngineCache.value
  let engine = null
  if (forced === 'none' || forced === 'off' || forced === '0') {
    engine = null
  } else if (THUMB_ENGINES.has(forced)) {
    engine = forced
  } else if (process.platform === 'darwin') {
    engine = 'sips'
  } else if (process.platform === 'win32') {
    engine = 'powershell'
  } else {
    engine = ['magick', 'convert', 'ffmpeg'].find((candidate) => whichCommand(candidate)) ?? null
  }
  thumbEngineCache = { key: forced, value: engine }
  trace(`thumbnail engine: ${engine === null ? 'none' : engine}`)
  return engine
}

/** PowerShell 版缩略图：脚本写成带 BOM 的 UTF-8，否则 PS 5.1 会把中文路径读成乱码。 */
function makeThumbWithPowershell(source, target) {
  const scriptPath = join(thumbDir(), 'make-thumb.ps1')
  const psQuote = (value) => "'" + String(value).replaceAll("'", "''") + "'"
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$src = ${psQuote(source)}`,
    `$dst = ${psQuote(target)}`,
    '$img = [System.Drawing.Image]::FromFile($src)',
    'try {',
    `  $max = ${String(THUMB_MAX_EDGE)}`,
    '  $scale = [Math]::Min(1.0, $max / [Math]::Max($img.Width, $img.Height))',
    '  $w = [Math]::Max(1, [int][Math]::Round($img.Width * $scale))',
    '  $h = [Math]::Max(1, [int][Math]::Round($img.Height * $scale))',
    '  $bmp = New-Object System.Drawing.Bitmap($w, $h)',
    '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
    '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '  $g.DrawImage($img, 0, 0, $w, $h)',
    '  $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Jpeg)',
    '  $g.Dispose()',
    '  $bmp.Dispose()',
    '} finally { $img.Dispose() }'
  ].join('\r\n')
  try {
    mkdirSync(thumbDir(), { recursive: true })
    writeFileSync(scriptPath, '\ufeff' + script, 'utf8')
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { stdio: 'ignore', timeout: 25_000 }
    )
    return result.status === 0
  } catch {
    return false
  } finally {
    try {
      rmSync(scriptPath, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

function runThumbCommand(command, args) {
  try {
    return spawnSync(command, args, { stdio: 'ignore', timeout: 25_000 }).status === 0
  } catch {
    return false
  }
}

/** 按引擎生成一张 480px 的 JPEG 缩略图；失败返回 false。 */
function makeThumbnail(engine, source, target) {
  const edge = String(THUMB_MAX_EDGE)
  if (engine === 'sips') {
    return runThumbCommand('sips', ['-Z', edge, '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', source, '--out', target])
  }
  if (engine === 'magick') {
    return runThumbCommand('magick', [source, '-resize', `${edge}x${edge}>`, '-quality', '72', target])
  }
  if (engine === 'convert') {
    return runThumbCommand('convert', [source, '-resize', `${edge}x${edge}>`, '-quality', '72', target])
  }
  if (engine === 'ffmpeg') {
    return runThumbCommand('ffmpeg', ['-y', '-loglevel', 'error', '-i', source, '-vf', `scale=${edge}:-1`, '-frames:v', '1', '-q:v', '4', target])
  }
  if (engine === 'powershell') {
    return makeThumbWithPowershell(source, target)
  }
  return false
}

/** 缩略图缓存路径（内容变过就换名字）；不可用时返回 null。 */
function thumbnailFor(item) {
  const engine = thumbEngine()
  if (engine === null) return null
  let stats
  try {
    stats = statSync(item.path)
  } catch {
    return null
  }
  const hash = createHash('sha1')
    .update(`${item.source}:${item.file}:${String(stats.size)}:${String(Math.round(stats.mtimeMs))}`)
    .digest('hex')
    .slice(0, 20)
  const target = join(thumbDir(), hash + '.jpg')
  if (existsSync(target)) return target
  try {
    mkdirSync(thumbDir(), { recursive: true })
  } catch {
    return null
  }
  if (makeThumbnail(engine, item.path, target)) {
    try {
      if (statSync(target).size > 0) return target
    } catch {
      /* 落到下面的清理 */
    }
  }
  try {
    rmSync(target, { force: true })
  } catch {
    /* 忽略 */
  }
  return null
}

function safeStem(raw) {
  const base = displayName(String(raw || '')).trim()
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.slice(0, 80)
}

function uniqueTargetPath(stem, ext) {
  const dir = userDir()
  mkdirSync(dir, { recursive: true })
  const safeStemValue = stem === '' ? `bg-${Date.now().toString(36)}` : stem
  let candidate = join(dir, safeStemValue + ext)
  let counter = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${safeStemValue}-${String(counter)}${ext}`)
    counter += 1
    if (counter > 999) throw new Error('图库同名文件过多')
  }
  return candidate
}

function itemForPath(path, source) {
  const ext = extname(path).toLowerCase()
  let stats
  try {
    stats = statSync(path)
  } catch {
    return null
  }
  const size = readImageSize(path, ext)
  const file = basename(path)
  return {
    id: `${source}:${file}`,
    file,
    name: displayName(file),
    source,
    bytes: stats.size,
    mtime: Math.round(stats.mtimeMs),
    width: size === null ? null : size.width,
    height: size === null ? null : size.height
  }
}

// ── 设置 ────────────────────────────────────────────────────────────────────

function sanitizeSettings(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const clean = {}
  for (const key of BOOLEAN_KEYS) {
    if (typeof value[key] === 'boolean') clean[key] = value[key]
  }
  for (const [key, range] of Object.entries(NUMBER_RANGES)) {
    const raw = value[key]
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    clean[key] = Math.min(range[1], Math.max(range[0], Math.round(raw)))
  }
  if (typeof value.mode === 'string' && MODES.includes(value.mode)) clean.mode = value.mode
  if (typeof value.rotateOrder === 'string' && ROTATE_ORDERS.includes(value.rotateOrder)) {
    clean.rotateOrder = value.rotateOrder
  }
  for (const key of ['activeId', 'lightId', 'darkId']) {
    if (value[key] === null) clean[key] = null
    else if (typeof value[key] === 'string' && ID_PATTERN.test(value[key])) clean[key] = value[key]
  }
  return clean
}

function readSettings() {
  const path = settingsPath()
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = sanitizeSettings(JSON.parse(readFileSync(path, 'utf8')))
    return { ...DEFAULT_SETTINGS, ...(parsed || {}) }
  } catch (error) {
    // 设置文件坏了（手改坏了、写了一半断电…）：把坏文件挪到一边并留痕，
    // 否则"选区悄悄没了 → 壁纸不显示"这种问题根本查不出来。
    trace(`settings.json unreadable (${String((error && error.message) || error)}); moving it aside`)
    try {
      renameSync(path, `${path}.bad-${Date.now().toString(36)}`)
    } catch {
      /* 挪不动就算了 */
    }
    return { ...DEFAULT_SETTINGS }
  }
}

function writeSettings(settings) {
  const clean = sanitizeSettings(settings)
  if (clean === null) throw new Error('设置格式不合法')
  const merged = { ...DEFAULT_SETTINGS, ...clean }
  mkdirSync(pluginDir(), { recursive: true })
  const path = settingsPath()
  const temporary = path + '.tmp'
  writeFileSync(temporary, JSON.stringify(merged, null, '\t'), 'utf8')
  try {
    renameSync(temporary, path)
  } catch {
    rmSync(path, { force: true })
    renameSync(temporary, path)
  }
  return merged
}

// ── widget.js（浏览器半区）──────────────────────────────────────────────────

let widgetCache = null

/** 服务就绪后指向 webServer，用来算页面要用的绝对地址（官方桌面端 dsh-app:// 页面需要）。 */
let webServerRef = null

function loadWidgetSource() {
  const path = widgetPath()
  try {
    const stats = statSync(path)
    if (widgetCache !== null && widgetCache.mtimeMs === stats.mtimeMs) return widgetCache.text
    const text = readFileSync(path, 'utf8')
    widgetCache = { text, mtimeMs: stats.mtimeMs }
    return text
  } catch {
    return widgetCache === null ? '' : widgetCache.text
  }
}

/**
 * 宿主绝对地址：官方桌面端的页面跑在 `dsh-app://app/` 这种自定义协议下，
 * 相对路径要靠 Electron 的协议处理器转发才到得了宿主；直接给绝对地址更稳。
 * 端口只有等服务就绪后才知道，所以延迟读取。
 */
function apiBaseUrl() {
  try {
    const port = webServerRef === null || webServerRef === undefined ? undefined : webServerRef.port
    if (typeof port === 'number' && port > 0) return `http://127.0.0.1:${String(port)}`
  } catch {
    /* 服务还没起来 */
  }
  return ''
}

/**
 * 桌面壳（Electron）只吃结构化注入行，而且这张表是宿主启动时一次性收集的：
 * 所以行必须在 apply() 一进来就注册，且必须是**内联 script 行**——
 * 页面侧解释器对 `script-src` 行的加载失败会 reject 掉整个 boot（见 dsh-whale-widget issue #154）。
 * 这里自己建 <script> 并吞掉 onerror：路由在就正常加载，路由不在就静默失败。
 *
 * 内联文本里顺带塞两样东西：
 *   · __DSH_BG_INITIAL__ —— 设置快照，首帧就能贴上背景，不必等一次往返；
 *   · __DSH_BG_API__     —— 宿主绝对地址，页面在自定义协议下时用它发 API / 贴图请求。
 */
function inlineBootText() {
  let snapshot = 'null'
  try {
    snapshot = JSON.stringify(readSettings()).replaceAll('<', '\\u003c')
  } catch {
    /* 快照失败不影响引导 */
  }
  const base = apiBaseUrl()
  return (
    'window.__DSH_BG_INITIAL__=' + snapshot + ';' +
    (base === '' ? '' : 'window.__DSH_BG_API__=' + JSON.stringify(base).replaceAll('<', '\\u003c') + ';') +
    '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
    'if(window.__dshBgSwitcher)return;var s=document.createElement("script");s.src="' + WIDGET_SRC + '";' +
    's.onerror=function(){};d.appendChild(s)}catch(e){}})()'
  )
}

function injectionRowTextPresent(table) {
  for (const row of table) {
    if (row === null || typeof row !== 'object') continue
    if (row.kind === 'script-src' && row.src === WIDGET_SRC) return true
    if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(WIDGET_SRC)) return true
  }
  return false
}

// ── 路由 ────────────────────────────────────────────────────────────────────

function routeGuard(ctx, req, res) {
  // 先挂 CORS 头（错误响应也要带，否则浏览器只会报一个没有细节的 TypeError）
  const cors = corsHeaders(corsOrigin(req), req)
  if (cors !== null) {
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status, headers) => writeHead(status, { ...(headers || {}), ...cors })
  }
  const rejection = fenceRejection(req, ctx)
  if (rejection !== null) trace(`guard denied ${String(req.url)} → ${String(rejection)}`)
  if (rejection !== null) {
    sendText(res, rejection, rejection === 403 ? 'forbidden' : 'rejected')
    return false
  }
  if (req.method === 'OPTIONS') {
    // 预检：实际请求不再重复校验
    res.writeHead(204)
    res.end()
    return false
  }
  return true
}

function handleList(ctx, req, res) {
  const settings = readSettings()
  trace(`hit /dsh-bg/list → ${settingsPath()} activeId=${String(settings.activeId)} dim=${String(settings.dim)}`)
  sendJson(res, 200, {
    ok: true,
    items: listGallery(),
    settings,
    dirs: { user: userDir(), builtin: builtinDir(), data: pluginDir() },
    thumbnails: thumbEngine() !== null
  })
}

function handleImage(ctx, req, res) {
  const item = resolveItem(query(req).get('id'))
  trace(`hit /dsh-bg/img ${item === null ? '(miss)' : item.id}`)
  if (item === null) {
    sendText(res, 404, '图片不存在')
    return
  }
  try {
    sendBytes(res, 200, readFileSync(item.path), item.mime)
  } catch (error) {
    sendText(res, 500, '读取图片失败：' + String((error && error.message) || error))
  }
}

function handleThumb(ctx, req, res) {
  const id = query(req).get('id')
  const item = resolveItem(id)
  if (item === null) {
    sendText(res, 404, '图片不存在')
    return
  }
  const thumb = thumbnailFor(item)
  const path = thumb === null ? item.path : thumb
  try {
    sendBytes(res, 200, readFileSync(path), thumb === null ? item.mime : 'image/jpeg')
  } catch (error) {
    sendText(res, 500, '读取缩略图失败：' + String((error && error.message) || error))
  }
}

async function handleSettings(ctx, req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, settings: readSettings() })
    return
  }
  if (req.method !== 'PUT' && req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, PUT, POST' })
    res.end()
    return
  }
  try {
    const parsed = await readJsonBody(req)
    const incoming = parsed && typeof parsed === 'object' && parsed.settings !== undefined ? parsed.settings : parsed
    const clean = sanitizeSettings(incoming)
    if (clean === null) throw new Error('设置格式不合法')
    const settings = writeSettings({ ...readSettings(), ...clean })
    sendJson(res, 200, { ok: true, settings })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: String((error && error.message) || error) })
  }
}

async function handleUpload(ctx, req, res) {
  try {
    const body = await readJsonBody(req)
    const dataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : ''
    const match = /^data:([a-z0-9.+/-]+);base64,([\s\S]+)$/i.exec(dataUrl)
    if (match === null) throw new Error('dataUrl 不是 base64 图片')
    const ext = UPLOAD_MIME_EXT.get(match[1].toLowerCase())
    if (ext === undefined) throw new Error('不支持的图片格式：' + match[1])
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.length === 0) throw new Error('图片内容为空')
    if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('图片超过 16MB，请先压缩或改用「添加到图库」')
    const target = uniqueTargetPath(safeStem(body.name), ext)
    writeFileSync(target, bytes)
    sendJson(res, 200, { ok: true, item: itemForPath(target, 'user'), items: listGallery() })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: String((error && error.message) || error) })
  }
}

async function handleAddPath(ctx, req, res) {
  try {
    const body = await readJsonBody(req)
    let raw = typeof body.path === 'string' ? body.path.trim() : ''
    if (raw === '') throw new Error('路径为空')
    if (raw.startsWith('~')) raw = join(homedir(), raw.slice(1))
    if (raw.startsWith('file://')) raw = fileURLToPath(raw)
    const ext = extname(raw).toLowerCase()
    if (!IMAGE_TYPES.has(ext)) throw new Error('不是受支持的图片：' + (ext === '' ? '(无扩展名)' : ext))
    let stats
    try {
      stats = statSync(raw)
    } catch {
      throw new Error('路径不存在：' + raw)
    }
    if (!stats.isFile()) throw new Error('不是文件：' + raw)
    if (stats.size > MAX_SOURCE_FILE_BYTES) throw new Error('图片超过 48MB')
    const target = uniqueTargetPath(safeStem(basename(raw)), ext)
    copyFileSync(raw, target)
    sendJson(res, 200, { ok: true, item: itemForPath(target, 'user'), items: listGallery() })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: String((error && error.message) || error) })
  }
}

async function handleDelete(ctx, req, res) {
  try {
    const body = await readJsonBody(req)
    const item = resolveItem(body.id)
    if (item === null) throw new Error('图片不存在')
    if (item.source !== 'user') throw new Error('内置图片不可删除')
    unlinkSync(item.path)
    const settings = readSettings()
    const patch = {}
    for (const key of ['activeId', 'lightId', 'darkId']) {
      if (settings[key] === item.id) patch[key] = null
    }
    if (Object.keys(patch).length > 0) writeSettings({ ...settings, ...patch })
    sendJson(res, 200, { ok: true, items: listGallery(), settings: readSettings() })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: String((error && error.message) || error) })
  }
}

function handleReveal(ctx, req, res) {
  try {
    mkdirSync(userDir(), { recursive: true })
  } catch {
    /* 忽略 */
  }
  const target = userDir()
  const commands = { darwin: ['open', [target]], win32: ['explorer', [target]], linux: ['xdg-open', [target]] }
  const command = commands[process.platform]
  if (command === undefined) {
    sendJson(res, 200, { ok: false, message: '当前平台不支持自动打开，图库路径：' + target, dir: target })
    return
  }
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
    child.unref()
    sendJson(res, 200, { ok: true, dir: target })
  } catch (error) {
    sendJson(res, 200, { ok: false, message: String((error && error.message) || error), dir: target })
  }
}

function handleWidget(ctx, req, res) {
  trace('hit /dsh-bg/widget.js')
  const text = loadWidgetSource()
  if (text === '') {
    sendText(res, 500, 'widget.js 缺失')
    return
  }
  sendBytes(res, 200, Buffer.from(text, 'utf8'), 'application/javascript; charset=utf-8')
}

/**
 * 页面自检回执：浏览器半区把页面里真正看到的东西（计算样式、盖在中心的元素栈、
 * 图片是否加载成功、控件状态）POST 回来，落盘成 diag.json，方便排查
 * "插件在跑但壁纸不显示" 这类只能在页面里看清的问题。
 */
async function handleDiag(ctx, req, res) {
  try {
    const body = await readJsonBody(req)
    const dir = pluginDir()
    mkdirSync(dir, { recursive: true })
    const record = { at: new Date().toISOString(), from: req.headers?.host ?? '', payload: body }
    const json = JSON.stringify(record, null, '\t')
    writeFileSync(join(dir, 'diag.json'), json, 'utf8')
    try {
      appendFileSync(join(dir, 'diag.log'), JSON.stringify(record) + '\n', 'utf8')
    } catch {
      /* 忽略 */
    }
    trace(`diag received (${json.length} bytes)`)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    sendJson(res, 400, { ok: false, message: String((error && error.message) || error) })
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export const name = PLUGIN_NAME

export function apply(root) {
  const disposers = []
  trace(`apply() enter; rootKeys=${root === null || root === undefined ? 'none' : typeof root.inject}`)

  // ① 结构化注入行：桌面壳唯一生效的通道，必须在 apply() 最前面注册。
  try {
    disposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          if (injectionRowTextPresent(table)) return
          table.push({ kind: 'script', placement: 'body', text: inlineBootText() })
          trace(`index-inject row pushed (table=${table.length})`)
        } catch (error) {
          trace(`index-inject failed: ${String((error && error.message) || error)}`)
        }
      })
    )
    trace('index-inject listener registered')
  } catch (error) {
    trace(`index-inject listener failed: ${String((error && error.message) || error)}`)
  }

  // ② 其余逻辑等服务就绪后再挂。
  try {
    root.inject(['webServer'], (ctx) => {
      trace('webServer inject fired')
      try {
        webServerRef = ctx.webServer ?? null
      } catch {
        webServerRef = null
      }
      registerRoutes(ctx, disposers)
    })
  } catch (error) {
    trace(`root.inject failed: ${String((error && error.message) || error)}`)
  }

  root.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 忽略 */
      }
    }
    disposers.length = 0
    trace('disposed')
  }, `${PLUGIN_NAME}: routes + index injection`)
}

/** 全部 HTTP 路由定义（每次巡检时按需补齐）。 */
function routeTable(ctx) {
  return [
    { kind: 'exact', path: `${ROUTE_PREFIX}/list`, handler: (req, res) => routeGuard(ctx, req, res) && handleList(ctx, req, res) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/img`, handler: (req, res) => routeGuard(ctx, req, res) && handleImage(ctx, req, res) },
    { kind: 'exact', path: `${ROUTE_PREFIX}/thumb`, handler: (req, res) => routeGuard(ctx, req, res) && handleThumb(ctx, req, res) },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/settings`,
      handler: (req, res) => {
        if (!routeGuard(ctx, req, res)) return
        return handleSettings(ctx, req, res)
      }
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/upload`,
      handler: (req, res) => {
        if (!routeGuard(ctx, req, res)) return
        return handleUpload(ctx, req, res)
      }
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/add-path`,
      handler: (req, res) => {
        if (!routeGuard(ctx, req, res)) return
        return handleAddPath(ctx, req, res)
      }
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete`,
      handler: (req, res) => {
        if (!routeGuard(ctx, req, res)) return
        return handleDelete(ctx, req, res)
      }
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/reveal`,
      handler: (req, res) => {
        if (!routeGuard(ctx, req, res)) return
        return handleReveal(ctx, req, res)
      }
    },
    { kind: 'exact', path: WIDGET_SRC, handler: (req, res) => routeGuard(ctx, req, res) && handleWidget(ctx, req, res) },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/diag`,
      handler: (req, res) => {
        if (!routeGuard(ctx, req, res)) return
        return handleDiag(ctx, req, res)
      }
    }
  ]
}

/**
 * 注册路由 + tapIndex，并起一个"巡检员"：
 * 宿主里 `webServer` 这个服务名可能被换实例（重新组合 / HMR），换实例后旧表里的路由就没了；
 * 所以每 1.5s 检查一次当前解析到的实例，缺哪条补哪条。前 60s 快巡，之后 30s 慢巡。
 */
function registerRoutes(ctx, disposers) {
  const routes = routeTable(ctx)
  let current = null
  let slowTimer = null

  const ensure = (why) => {
    let server
    try {
      server = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
    } catch {
      server = undefined
    }
    if (!server || typeof server.register !== 'function') return
    if (server !== current) {
      current = server
      trace(`supervisor: webServer 实例变为 port=${String(server.port)}`)
    }
    const added = []
    for (const route of routes) {
      if (typeof server.exact?.has === 'function' && server.exact.has(route.path)) continue
      try {
        disposers.push(server.register(route))
        added.push(route.path)
      } catch (error) {
        // 并发注册/已存在：吞掉即可，下一次巡检会再次核对
        trace(`supervisor: 注册失败 ${route.path}: ${String((error && error.message) || error)}`)
      }
    }
    if (added.length > 0) trace(`supervisor(${why}): 补齐 ${added.join(',')} → port=${String(server.port)}`)
  }

  ensure('initial')

  let ticks = 0
  const fastTimer = setInterval(() => {
    ticks += 1
    ensure('tick')
    if (ticks === 40) {
      clearInterval(fastTimer)
      slowTimer = setInterval(() => ensure('slow'), 30_000)
      slowTimer.unref?.()
    }
  }, 1_500)
  // 定时器不持有进程存活（宿主里进程常驻，测试里进程能正常退出）
  fastTimer.unref?.()
  disposers.push(() => {
    clearInterval(fastTimer)
    if (slowTimer !== null) clearInterval(slowTimer)
  })

  // 浏览器形态（dsh web 直出 index.html）走 tapIndex，与注入行并存、各自去重。
  try {
    const server = typeof ctx.get === 'function' ? ctx.get('webServer') ?? ctx.webServer : ctx.webServer
    disposers.push(
      server.tapIndex((html) => {
        if (html.includes(WIDGET_SRC)) return html
        const tag = `<script defer src="${WIDGET_SRC}"></script>`
        return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
      })
    )
    trace('tapIndex registered')
  } catch (error) {
    trace(`tapIndex failed: ${String((error && error.message) || error)}`)
  }

  try {
    ctx.logger?.info?.(`[${PLUGIN_NAME}] 背景图切换已就绪，图库目录：${userDir()}`)
  } catch {
    /* 忽略 */
  }
}

export default { name, apply }
