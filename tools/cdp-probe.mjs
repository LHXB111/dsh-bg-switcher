/**
 * CDP 渲染探针：连上 headless Chrome，打开官方 harness 的页面，
 * 等 widget 起来后把页面真实状态（计算样式、层级、插件 DOM、控制台报错）抓回来，
 * 再存一张截图。
 *
 *   node tools/cdp-probe.mjs <url> <outdir> [port] [waitMs]
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const [url, outDir, portArg = '9223', waitArg = '9000'] = process.argv.slice(2)
if (!url || !outDir) {
  console.error('usage: node cdp-probe.mjs <url> <outdir> [port] [waitMs]')
  process.exit(2)
}
const port = Number(portArg)
const waitMs = Number(waitArg)
mkdirSync(outDir, { recursive: true })

const DIAG = `(async () => {
  const out = { href: location.href, origin: location.origin, readyState: document.readyState, ua: navigator.userAgent.slice(0, 90) };
  try {
    const body = document.body;
    const cs = getComputedStyle(body);
    out.body = {
      attrs: [...body.attributes].map((a) => a.name),
      computed: { bgImage: cs.backgroundImage, bgColor: cs.backgroundColor, bgSize: cs.backgroundSize, bgAttach: cs.backgroundAttachment, isolation: cs.isolation },
      vars: {
        image: body.style.getPropertyValue('--dsh-bg-image').slice(0, 120),
        scrim: body.style.getPropertyValue('--dsh-bg-scrim'),
        blur: body.style.getPropertyValue('--dsh-bg-blurpx'),
        base: body.style.getPropertyValue('--dsh-bg-base')
      },
      tokens: { base: cs.getPropertyValue('--dsw-alias-bg-base').trim(), sidebar: cs.getPropertyValue('--dsw-specific-sidebar-fill').trim() }
    };
    const root = document.getElementById('root');
    const rcs = root ? getComputedStyle(root) : null;
    out.root = root ? {
      rect: [Math.round(root.getBoundingClientRect().width), Math.round(root.getBoundingClientRect().height)],
      computed: { bg: rcs.backgroundColor, bgImage: rcs.backgroundImage.slice(0, 120), backdrop: rcs.backdropFilter, tokenBase: rcs.getPropertyValue('--dsw-alias-bg-base').trim() }
    } : null;
    out.stack = [];
    let el = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    for (let i = 0; i < 7 && el; i++) {
      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.stack.push({
        tag: el.tagName, id: el.id || '', cls: String(el.className || '').slice(0, 70),
        size: [Math.round(r.width), Math.round(r.height)],
        bg: c.backgroundColor, bgImage: c.backgroundImage.slice(0, 70),
        opacity: c.opacity, z: c.zIndex, pos: c.position, filter: c.filter, backdrop: c.backdropFilter
      });
      el = el.parentElement;
    }
    const api = window.__dshBgSwitcher;
    out.widget = {
      button: !!document.querySelector('[data-dsh-bg-btn]'),
      panel: !!document.querySelector('[data-dsh-bg-panel]'),
      style: !!document.getElementById('dsh-bg-switcher-style'),
      styleLen: (document.getElementById('dsh-bg-switcher-style') || {}).textContent ? document.getElementById('dsh-bg-switcher-style').textContent.length : 0,
      cards: document.querySelectorAll('[data-dsh-bg-panel] [data-id]').length,
      thumbsLoaded: [...document.querySelectorAll('[data-dsh-bg-panel] img')].map((i) => ({ src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight })),
      status: (document.querySelector('.dsh-bg-status') || {}).textContent || '',
      ready: !!(api && api.ready),
      items: (api && api.state && api.state.items.length) || 0,
      activeId: (api && api.state && api.state.settings && api.state.settings.activeId) || null
    };
    out.stageInfo = api && api.stageInfo ? api.stageInfo() : null;
    // 真解码一次背景图（异步），确认它确实取得到
    const activeId = (api && api.state && api.state.settings && api.state.settings.activeId) || null;
    if (activeId !== null) {
      const url = '/dsh-bg/img?id=' + encodeURIComponent(activeId);
      const started = Date.now();
      out.imageProbe = await new Promise((resolve) => {
        const img = new Image();
        let done = false;
        const finish = (ok, note) => {
          if (done) return;
          done = true;
          resolve({ src: url, ok, bytes: [img.naturalWidth, img.naturalHeight], ms: Date.now() - started, note: note || '' });
        };
        img.onload = () => finish(true);
        img.onerror = () => finish(false, 'onerror');
        setTimeout(() => finish(false, 'timeout'), 8000);
        img.src = url;
      });
    }
    out.rotateInfo = api && api.rotateInfo ? api.rotateInfo() : null;
    out.stage = [...document.querySelectorAll('[data-dsh-bg-slide]')].map((node) => {
      const cs = getComputedStyle(node);
      return { opacity: cs.opacity, hasImage: cs.backgroundImage.includes('/dsh-bg/img'), size: cs.backgroundSize };
    });
    out.parallax = api && api.rotateInfo ? { on: !!(api.state && api.state.settings && api.state.settings.parallax) } : null;
    out.settings = api && api.state ? api.state.settings : null;
    out.stageTransform = (document.querySelector('[data-dsh-bg-stage]') || {}).style ? document.querySelector('[data-dsh-bg-stage]').style.transform : null;
  } catch (error) {
    out.error = String((error && error.stack) || error);
  }
  return JSON.stringify(out);
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function targets() {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
  return response.json()
}

// 等 Chrome 的调试端口起来
let page = null
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    const list = await targets()
    page = list.find((entry) => entry.type === 'page')
    if (page) break
  } catch {
    /* 还没起来 */
  }
  await sleep(500)
}
if (!page) {
  console.error('✖ 连不上 Chrome 调试端口')
  process.exit(3)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
const console_ = []
const exceptions = []
let nextId = 1

function send(method, params) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params: params || {} }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
    return
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    console_.push(`${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300)}`)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    exceptions.push(String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).slice(0, 500))
  }
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

await send('Page.enable')
await send('Runtime.enable')
// 复刻官方 macOS 端的"抢权重"规则：html[data-platform=darwin] body{background:transparent}
// （权重 (0,1,2) > body[data-dsh-bg] (0,1,1)，正是真实环境里壁纸不显示的元凶）
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const apply = () => {
      document.documentElement.setAttribute('data-platform', 'darwin')
      const style = document.createElement('style')
      style.textContent = 'html[data-platform=darwin],html[data-platform=darwin] body{background:transparent}'
      ;(document.head || document.documentElement).append(style)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true })
    else apply()
  })()`
})
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url })
await sleep(waitMs)

// 打开面板，顺便让缩略图真的加载起来
try {
  await send('Runtime.evaluate', { expression: "window.__dshBgSwitcher && window.__dshBgSwitcher.open()", returnByValue: true })
  await sleep(1500)
} catch {
  /* 面板打不开就照原样截图 */
}

// 真跑一次"换图"，验证交叉淡入这条链路（截图会落在换完之后）
try {
  const switched = await send('Runtime.evaluate', {
    expression: "window.__dshBgSwitcher && window.__dshBgSwitcher.rotateNow()",
    returnByValue: true
  })
  await sleep(2800)
  console.log('rotateNow →', JSON.stringify(switched.result.value))
} catch (error) {
  console.error('换图失败：', error.message)
}

let diag = null
try {
  const result = await send('Runtime.evaluate', { expression: DIAG, returnByValue: true, awaitPromise: true })
  diag = JSON.parse(result.result.value)
} catch (error) {
  diag = { error: String(error.message || error) }
}

try {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, 'shot.png'), Buffer.from(shot.data, 'base64'))
} catch (error) {
  console.error('截图失败：', error.message)
}

writeFileSync(join(outDir, 'diag.json'), JSON.stringify({ diag, console: console_, exceptions }, null, 2))
console.log(JSON.stringify({ diag, exceptions, consoleTail: console_.slice(-8) }, null, 2))
socket.close()
