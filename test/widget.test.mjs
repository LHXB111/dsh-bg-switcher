/**
 * 浏览器半区冒烟测试：把 lib/widget.js 真的跑起来（跑在 test/dom-stub.mjs 的最小 DOM 里），
 * 验证引导、贴图、面板、快捷键、选择/清除、亮暗切换、删除、保存这些链路真的能跑通。
 * 不断言 CSS 视觉效果。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, it } from 'node:test'

import { MutationObserverStub, runInDom } from './dom-stub.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'widget.js'), 'utf8')

const ITEMS = [
  {
    id: 'builtin:教室自习.jpg',
    file: '教室自习.jpg',
    name: '教室自习',
    source: 'builtin',
    bytes: 130526,
    mtime: 1,
    width: 1072,
    height: 758
  },
  {
    id: 'builtin:校舍走廊.png',
    file: '校舍走廊.png',
    name: '校舍走廊',
    source: 'builtin',
    bytes: 3349508,
    mtime: 2,
    width: 1735,
    height: 1227
  },
  {
    id: 'user:我的图.webp',
    file: '我的图.webp',
    name: '我的图',
    source: 'user',
    bytes: 100,
    mtime: 3,
    width: 100,
    height: 100
  }
]

const DEFAULT_SETTINGS = {
  activeId: 'builtin:教室自习.jpg',
  lightId: null,
  darkId: null,
  split: false,
  immersive: true,
  hidden: false,
  mode: 'cover',
  dim: 45,
  blur: 0,
  btnX: 0,
  btnY: 0
}

/** 起一次完整的引导：list/settings 由桩提供，settings 写回会存到 serverSettings。 */
async function boot({ settings = DEFAULT_SETTINGS, items = ITEMS, initial = settings } = {}) {
  MutationObserverStub.reset()
  const serverSettings = { ...settings }
  const dom = runInDom(source, {
    routes: {
      '/dsh-bg/list': () => ({ ok: true, items, settings: serverSettings, dirs: { user: '/tmp/gallery' } }),
      '/dsh-bg/settings': (body, url, method) => {
        if (method === 'PUT') Object.assign(serverSettings, body.settings)
        return { ok: true, settings: serverSettings }
      },
      '/dsh-bg/delete': (body) => ({ ok: true, items: [], settings: { ...serverSettings, activeId: null } }),
      '/dsh-bg/reveal': () => ({ ok: true, dir: '/tmp/gallery' })
    }
  })
  dom.sandbox.__DSH_BG_INITIAL__ = initial
  dom.run()
  await settle()
  return { ...dom, serverSettings }
}

const settle = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** 等过 260ms 的保存防抖，再把 PUT 的回包处理完。 */
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  await settle()
}

const byAttr = (root, name) => root.querySelectorAll(`[${name}]`)

/** 舞台根节点（壁纸两层的容器）。 */
const stageRoot = (ctx) => ctx.document.body.querySelector('[data-dsh-bg-stage]')

/** 当前贴在屏幕上的那层（有背景图且 opacity=1；淡入过程中取新进来的那层）。 */
function visibleSlide(ctx) {
  const slides = ctx.document.body.querySelectorAll('[data-dsh-bg-slide]')
  const painted = slides.filter((slide) => String(slide.style.backgroundImage || '').includes('/dsh-bg/img'))
  return painted.filter((slide) => slide.style.opacity === '1')[0] || painted[painted.length - 1] || null
}

/** 当前壁纸 URL。 */
const currentImage = (ctx) => String((visibleSlide(ctx) || { style: {} }).style.backgroundImage || '')

/** 按 label 文本找面板里的开关。 */
const flushFrame = async () => {
  // 视差走 requestAnimationFrame（桩里是 setTimeout 0）：等它落地
  await settle(2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await settle(2)
}

const flushFade = async () => {
  // 交叉淡入：先等图片预加载（桩里是 setTimeout 0），再等收尾
  await settle(4)
  await new Promise((resolve) => setTimeout(resolve, 40))
  await settle(4)
}

const toggleByText = (ctx, text) =>
  [...ctx.document.querySelectorAll('.dsh-bg-toggle')].find((label) => label.textContent.includes(text))?.querySelector('input') || null

describe('浏览器半区引导', () => {
  let ctx
  beforeEach(async () => {
    ctx = await boot()
  })

  it('脚本自己在 body 上建了悬浮按钮与面板', () => {
    const { document } = ctx
    assert.equal(byAttr(document.body, 'data-dsh-bg-btn').length, 1)
    assert.equal(byAttr(document.body, 'data-dsh-bg-panel').length, 1)
    assert.equal(document.getElementById('dsh-bg-switcher-style') !== null, true)
    assert.match(document.getElementById('dsh-bg-switcher-style').textContent, /body\[data-dsh-bg\]/)
    assert.match(document.getElementById('dsh-bg-switcher-style').textContent, /data-dsh-bg-immersive/)
  })

  it('底色声明带 !important，且壁纸在舞台两层里', () => {
    const css = ctx.document.getElementById('dsh-bg-switcher-style').textContent
    const rule = /body\[data-dsh-bg\]\{([^}]*)\}/.exec(css)
    assert.ok(rule, '样式里应有 body[data-dsh-bg] 规则')
    assert.match(rule[1], /background-color:[^;]*!important/, '底色需要 !important（压过官方 darwin 规则）')
    assert.match(css, /\[data-dsh-bg-stage\]\{[^}]*z-index:-1/, '舞台要在内容之下')
    assert.match(css, /\[data-dsh-bg-slide\]\{[^}]*transition:opacity/, '层要有 opacity 过渡')
    assert.equal(ctx.document.body.querySelectorAll('[data-dsh-bg-slide]').length, 2, '舞台要有两层')
  })

  it('首帧就用注入的快照贴上了背景（不等 /list 往返）', () => {
    const { document, sandbox } = ctx
    assert.equal(document.body.hasAttribute('data-dsh-bg'), true)
    assert.equal(document.body.hasAttribute('data-dsh-bg-immersive'), true)
    assert.match(currentImage(ctx), /^url\("\/dsh-bg\/img\?id=builtin%3A/)
    assert.equal(document.body.style.getPropertyValue('--dsh-bg-scrim'), 'rgba(252,252,253,0.45)')
    assert.equal(sandbox.__dshBgSwitcher.ready, true)
  })

  it('/list 回来后渲染出全部缩略图，并高亮当前选中项', () => {
    const grid = ctx.document.querySelector('.dsh-bg-grid')
    const cards = byAttr(grid, 'data-id')
    assert.equal(cards.length, 3)
    assert.deepEqual(
      cards.map((card) => card.dataset.id),
      ITEMS.map((item) => item.id)
    )
    assert.equal(cards[0].dataset.active, 'true')
    assert.equal(cards[1].dataset.active, 'false')
    const thumb = cards[1].querySelector('img')
    assert.match(thumb.getAttribute('src'), /^\/dsh-bg\/thumb\?id=builtin%3A/)
    assert.equal(thumb.getAttribute('loading'), 'lazy')
    assert.equal(ctx.sandbox.__dshBgSwitcher.state.items.length, 3)
  })

  it('只有用户图带删除按钮', () => {
    const cards = byAttr(ctx.document.querySelector('.dsh-bg-grid'), 'data-id')
    assert.equal(byAttr(cards[0], 'data-dsh-bg-nothing').length, 0)
    assert.equal(cards[0].querySelector('.dsh-bg-del'), null)
    assert.notEqual(cards[2].querySelector('.dsh-bg-del'), null)
  })

  it('点缩略图切换背景并落盘到服务端', async () => {
    const cards = byAttr(ctx.document.querySelector('.dsh-bg-grid'), 'data-id')
    cards[1].dispatch('click')
    await flushFade()
    assert.match(currentImage(ctx), /builtin%3A%E6%A0%A1%E8%88%8D%E8%B5%B0%E5%BB%8A\.png/)
    assert.equal(byAttr(ctx.document.querySelector('.dsh-bg-grid'), 'data-id')[1].dataset.active, 'true')
    await flush()
    assert.equal(ctx.serverSettings.activeId, 'builtin:校舍走廊.png')
    assert.ok(ctx.requests.some((entry) => entry.url === '/dsh-bg/settings' && entry.method === 'PUT'))
  })
})

describe('面板与快捷键', () => {
  it('Ctrl+Shift+B 开关面板，Esc 关闭，数字键直选', async () => {
    const ctx = await boot()
    const panel = byAttr(ctx.document.body, 'data-dsh-bg-panel')[0]
    assert.equal(panel.dataset.open, 'false')

    ctx.document.dispatch('keydown', { key: 'b', ctrlKey: true, shiftKey: true, target: ctx.document.body })
    assert.equal(panel.dataset.open, 'true')

    ctx.document.dispatch('keydown', { key: '2', target: ctx.document.body })
    await flushFade()
    assert.match(currentImage(ctx), /%E6%A0%A1%E8%88%8D/)
    await flush()
    assert.equal(ctx.serverSettings.activeId, 'builtin:校舍走廊.png')

    ctx.document.dispatch('keydown', { key: 'Escape', target: ctx.document.body })
    assert.equal(panel.dataset.open, 'false')
  })

  it('输入框里打字不会触发数字直选', async () => {
    const ctx = await boot()
    ctx.sandbox.__dshBgSwitcher.open()
    const input = ctx.document.querySelector('.dsh-bg-pathrow input')
    assert.notEqual(input, null)
    ctx.document.dispatch('keydown', { key: '3', target: input })
    await flush()
    assert.equal(ctx.serverSettings.activeId, 'builtin:教室自习.jpg')
  })

  it('滑块改遮罩 / 模糊会即时改写 CSS 变量', async () => {
    const ctx = await boot()
    const slider = ctx.document.querySelectorAll('input[type="range"]')[0]
    slider.value = '10'
    slider.dispatch('input')
    assert.equal(ctx.document.body.style.getPropertyValue('--dsh-bg-scrim'), 'rgba(252,252,253,0.1)')

    const blur = ctx.document.querySelectorAll('input[type="range"]')[1]
    blur.value = '8'
    blur.dispatch('input')
    assert.equal(ctx.document.body.style.getPropertyValue('--dsh-bg-blurpx'), '8px')
    assert.equal(ctx.document.body.hasAttribute('data-dsh-bg-blur'), true)
  })

  it('适配模式按钮切换 background-size', async () => {
    const ctx = await boot()
    const pills = ctx.document.querySelectorAll('.dsh-bg-pill')
    pills[2].dispatch('click') // tile
    await flush()
    assert.equal(visibleSlide(ctx).style.backgroundSize, 'auto')
    assert.equal(visibleSlide(ctx).style.backgroundRepeat, 'repeat')
    pills[1].dispatch('click') // contain
    await flush()
    assert.equal(visibleSlide(ctx).style.backgroundSize, 'contain')
    assert.equal(visibleSlide(ctx).style.backgroundRepeat, 'no-repeat')
  })

  it('勾选"隐藏悬浮按钮"会给 body 加标记位', async () => {
    const ctx = await boot()
    const toggles = ctx.document.querySelectorAll('.dsh-bg-toggle input')
    const hiddenToggle = toggleByText(ctx, '隐藏悬浮按钮')
    assert.notEqual(hiddenToggle, null)
    hiddenToggle.checked = true
    hiddenToggle.dispatch('change')
    await flush()
    assert.equal(ctx.document.body.hasAttribute('data-dsh-bg-hiddenbtn'), true)
    assert.equal(ctx.serverSettings.hidden, true)
  })

  it('沉浸模式可关闭与重新开启，保留壁纸选择并持久化', async () => {
    const ctx = await boot()
    const toggle = toggleByText(ctx, '沉浸模式')
    const image = currentImage(ctx)
    toggle.checked = false
    toggle.dispatch('change')
    await flush()
    assert.equal(ctx.document.body.hasAttribute('data-dsh-bg-immersive'), false)
    assert.equal(ctx.serverSettings.immersive, false)
    assert.equal(currentImage(ctx), image)
    toggle.checked = true
    toggle.dispatch('change')
    await flush()
    assert.equal(ctx.document.body.hasAttribute('data-dsh-bg-immersive'), true)
    assert.equal(ctx.serverSettings.immersive, true)
    assert.equal(currentImage(ctx), image)
  })
})

describe('亮暗分开 / 清除 / 删除', () => {
  it('分开模式下按当前明暗写入对应槽位，主题翻转会换图', async () => {
    const ctx = await boot({
      settings: { ...DEFAULT_SETTINGS, split: true, lightId: 'builtin:教室自习.jpg', darkId: 'builtin:校舍走廊.png' }
    })
    assert.match(currentImage(ctx), /%E6%95%99%E5%AE%A4%E8%87%AA%E4%B9%A0/)

    ctx.document.body.setAttribute('data-ds-dark-theme', '')
    MutationObserverStub.fire()
    assert.match(currentImage(ctx), /%E6%A0%A1%E8%88%8D%E8%B5%B0%E5%BB%8A/)
    assert.equal(ctx.document.body.style.getPropertyValue('--dsh-bg-scrim'), 'rgba(14,15,20,0.45)')

    // 暗色下点第一张 → 写 darkId
    const cards = byAttr(ctx.document.querySelector('.dsh-bg-grid'), 'data-id')
    cards[0].dispatch('click')
    await flush()
    assert.equal(ctx.serverSettings.darkId, 'builtin:教室自习.jpg')
    assert.equal(ctx.serverSettings.lightId, 'builtin:教室自习.jpg')
  })

  it('清除背景会摘掉全部标记位与变量', async () => {
    const ctx = await boot()
    ctx.sandbox.__dshBgSwitcher.clear()
    await flush()
    assert.equal(ctx.document.body.hasAttribute('data-dsh-bg'), false)
    assert.equal(currentImage(ctx), '')
    assert.equal(ctx.serverSettings.activeId, null)
  })

  it('删除用户图会调 /delete 并重绘', async () => {
    const ctx = await boot()
    const cards = byAttr(ctx.document.querySelector('.dsh-bg-grid'), 'data-id')
    cards[2].querySelector('.dsh-bg-del').dispatch('click')
    await flush()
    const call = ctx.requests.find((entry) => entry.url === '/dsh-bg/delete')
    assert.equal(call.method, 'POST')
    assert.deepEqual(call.body, { id: 'user:我的图.webp' })
  })

  it('选中的图片从图库里消失后不再贴图（避免 404 挂着一块透明）', async () => {
    const ctx = await boot({
      settings: { ...DEFAULT_SETTINGS, activeId: 'user:已删除.webp' },
      initial: { ...DEFAULT_SETTINGS, activeId: 'user:已删除.webp' }
    })
    assert.equal(ctx.document.body.hasAttribute('data-dsh-bg'), false)
  })

  it('遮罩被拉到 100% 时自动纠偏到 45% 并落盘', async () => {
    const ctx = await boot({ settings: { ...DEFAULT_SETTINGS, dim: 100 }, initial: { ...DEFAULT_SETTINGS, dim: 100 } })
    assert.equal(ctx.document.body.style.getPropertyValue('--dsh-bg-scrim'), 'rgba(252,252,253,0.45)')
    assert.match(ctx.document.querySelector('.dsh-bg-status').textContent, /遮罩原本是 100%/)
    await flush()
    assert.equal(ctx.serverSettings.dim, 45)
  })

  it('遮罩没拉满时不改动用户设置', async () => {
    const ctx = await boot({ settings: { ...DEFAULT_SETTINGS, dim: 88 }, initial: { ...DEFAULT_SETTINGS, dim: 88 } })
    assert.equal(ctx.document.body.style.getPropertyValue('--dsh-bg-scrim'), 'rgba(252,252,253,0.88)')
    assert.equal(ctx.document.querySelector('.dsh-bg-hint-line').dataset.warn, 'false')
  })

  it('自定义协议页面优先用同源相对路径（避免跨源 CORS）', async () => {
    MutationObserverStub.reset()
    const dom = runInDom(source, {
      location: { href: 'dsh-app://app/', origin: 'dsh-app://app', protocol: 'dsh-app:', host: 'app' },
      routes: {
        '/dsh-bg/list': () => ({ ok: true, items: ITEMS, settings: DEFAULT_SETTINGS, dirs: {} }),
        '/dsh-bg/settings': () => ({ ok: true, settings: DEFAULT_SETTINGS })
      }
    })
    dom.sandbox.__DSH_BG_INITIAL__ = DEFAULT_SETTINGS
    dom.sandbox.__DSH_BG_API__ = 'http://127.0.0.1:56037'
    dom.run()
    await settle()
    const listCall = dom.requests.find((entry) => entry.url.includes('/dsh-bg/list'))
    assert.equal(listCall.raw, '/dsh-bg/list', '首次请求必须是同源相对路径')
    assert.match(currentImage(dom), /^url\("\/dsh-bg\/img/)
  })

  it('相对路径网络层失败时才回落到注入的绝对基址', async () => {
    MutationObserverStub.reset()
    const dom = runInDom(source, {
      location: { href: 'dsh-app://app/', origin: 'dsh-app://app', protocol: 'dsh-app:', host: 'app' },
      routes: {
        '/dsh-bg/list': (body, url, method, raw) => {
          // 相对路径假装"没被协议处理器代理"⇒ 网络层直接抛错；绝对地址才成功
          if (!/^https?:/i.test(raw)) throw new Error('Failed to fetch')
          return { ok: true, items: ITEMS, settings: DEFAULT_SETTINGS, dirs: {} }
        }
      }
    })
    dom.sandbox.__DSH_BG_INITIAL__ = DEFAULT_SETTINGS
    dom.sandbox.__DSH_BG_API__ = 'http://127.0.0.1:56037'
    dom.run()
    await settle(10)
    const attempts = dom.requests.filter((entry) => entry.url.includes('/dsh-bg/list'))
    assert.equal(attempts.length, 2, '应该先试相对再试绝对')
    assert.equal(attempts[0].raw, '/dsh-bg/list')
    assert.match(attempts[1].raw, /^http:\/\/127\.0\.0\.1:56037\/dsh-bg\/list/)
    assert.equal(dom.sandbox.__dshBgSwitcher.state.items.length, ITEMS.length)
    assert.match(currentImage(dom), /^url\("http:\/\/127\.0\.0\.1:56037/)
  })

  it('服务器答复 4xx 时不切基址（404 不是基址不通）', async () => {
    MutationObserverStub.reset()
    const dom = runInDom(source, {
      routes: {
        '/dsh-bg/list': () => ({ __status: 500, ok: false, message: 'boom' }),
        '/dsh-bg/settings': () => ({ ok: true, settings: DEFAULT_SETTINGS })
      }
    })
    dom.sandbox.__DSH_BG_INITIAL__ = DEFAULT_SETTINGS
    dom.sandbox.__DSH_BG_API__ = 'http://127.0.0.1:56037'
    dom.run()
    await settle(10)
    const attempts = dom.requests.filter((entry) => entry.url.includes('/dsh-bg/list'))
    assert.equal(attempts.length, 1, '服务器答复了就不该换基址重试')
    assert.equal(attempts[0].raw, '/dsh-bg/list')
  })

  it('引导后会回报一次页面自检（POST /dsh-bg/diag）', async () => {
    const ctx = await boot()
    await flush()
    const call = ctx.requests.find((entry) => entry.url === '/dsh-bg/diag')
    assert.ok(call, `应该请求过 /dsh-bg/diag，实际请求：${ctx.requests.map((r) => r.method + ' ' + r.url).join(', ')}`)
    assert.equal(call.method, 'POST')
    assert.equal(call.body.reason, 'boot')
    assert.equal(call.body.settings.activeId, 'builtin:教室自习.jpg')
    assert.ok(Array.isArray(call.body.stack))
    assert.equal(call.body.imageProbe.bytes[0], 10, '图片探针应报回真实尺寸')
  })

describe('轮播 / 淡入淡出 / 视差', () => {
  const rotating = () => boot({ settings: { ...DEFAULT_SETTINGS, rotateOn: true, rotateMinutes: 1 } })

  it('轮播：打开后注册 1 秒心跳，并显示下一次倒计时', async () => {
    const ctx = await rotating()
    assert.ok(ctx.intervals.some((entry) => entry.ms === 1000), '应该有 1 秒心跳')
    const countdown = ctx.document.querySelector('.dsh-bg-rotate-count').textContent
    assert.match(countdown, /^下一张 (00:5\d|01:00)$/)
  })

  it('轮播：到点换到另一张（随机模式下不会原地不动）', async () => {
    const ctx = await rotating()
    const before = currentImage(ctx)
    const next = ctx.sandbox.__dshBgSwitcher.rotateNow()
    await flushFade()
    assert.notEqual(next, null)
    assert.notEqual(currentImage(ctx), before)
    assert.equal(ctx.sandbox.__dshBgSwitcher.state.settings.activeId, next, '状态里的选区应该跟着换')
  })

  it('轮播：按顺序模式换到列表里的下一张', async () => {
    const ctx = await boot({
      settings: { ...DEFAULT_SETTINGS, rotateOn: true, rotateMinutes: 1, rotateOrder: 'inOrder', activeId: ITEMS[0].id }
    })
    ctx.sandbox.__dshBgSwitcher.rotateNow()
    await flushFade()
    assert.match(currentImage(ctx), new RegExp(encodeURIComponent(ITEMS[1].id).replace(/%/g, '%')))
  })

  it('轮播：手动选图会把倒计时重新起算', async () => {
    const ctx = await rotating()
    const before = ctx.sandbox.__dshBgSwitcher.rotateInfo().nextIn
    ctx.document.querySelectorAll('.dsh-bg-grid [data-id]')[2].dispatch('click')
    await flushFade()
    const after = ctx.sandbox.__dshBgSwitcher.rotateInfo().nextIn
    assert.ok(after >= before - 1, `手动换图后倒计时应重置（${before} → ${after}）`)
  })

  it('轮播：关掉开关会停掉心跳与倒计时', async () => {
    const ctx = await rotating()
    const box = toggleByText(ctx, '轮播')
    assert.notEqual(box, null)
    box.checked = false
    box.dispatch('change')
    await flushFade()
    assert.equal(ctx.sandbox.__dshBgSwitcher.rotateInfo().armed, false)
    assert.equal(ctx.document.querySelector('.dsh-bg-rotate-count').textContent, '')
  })

  it('淡入淡出：换图走双层交叉淡入，旧层随后被清空', async () => {
    const ctx = await boot()
    const firstVisible = visibleSlide(ctx)
    assert.equal(firstVisible.style.opacity, '1')
    const beforeIndex = ctx.sandbox.__dshBgSwitcher.stageInfo().index

    ctx.document.querySelectorAll('.dsh-bg-grid [data-id]')[1].dispatch('click')
    await flushFade()
    const info = ctx.sandbox.__dshBgSwitcher.stageInfo()
    assert.notEqual(info.index, beforeIndex, '两层的角色应该互换')
    assert.equal(currentImage(ctx).includes('/dsh-bg/img'), true)
    assert.equal(firstVisible.style.opacity, '0', '旧层应该淡出')

    // 等收尾（fadeMs + 80ms）后旧层不再挂着图
    await new Promise((resolve) => setTimeout(resolve, 620))
    assert.equal(firstVisible.style.backgroundImage, 'none')
  })

  it('视差：鼠标移动让舞台位移，离开窗口回中', async () => {
    const ctx = await boot()
    assert.ok(ctx.windowListeners.get('mousemove'), '视差应挂上 mousemove')
    ctx.sandbox.dispatchWindow('mousemove', { clientX: 1440, clientY: 900 })
    await flushFrame()
    assert.match(stageRoot(ctx).style.transform, /^translate3d\(1[0-9.]+px, 1[0-9.]+px, 0\)$/)
    ctx.sandbox.dispatchWindow('mouseleave', {})
    await flushFrame()
    assert.equal(stageRoot(ctx).style.transform, 'translate3d(0.00px, 0.00px, 0)')
  })

  it('视差：关掉开关后不再跟随鼠标', async () => {
    const ctx = await boot()
    const box = toggleByText(ctx, '视差')
    assert.notEqual(box, null)
    box.checked = false
    box.dispatch('change')
    await flushFade()
    ctx.sandbox.dispatchWindow('mousemove', { clientX: 10, clientY: 10 })
    await flushFrame()
    assert.equal(stageRoot(ctx).style.transform, 'translate3d(0.00px, 0.00px, 0)')
    assert.equal(ctx.windowListeners.get('mousemove').size, 0, '监听应被摘掉')
  })

  it('视差：系统开启"减少动态效果"时自动禁用，淡入也变瞬时', async () => {
    MutationObserverStub.reset()
    const dom = runInDom(source, {
      reducedMotion: true,
      routes: {
        '/dsh-bg/list': () => ({ ok: true, items: ITEMS, settings: DEFAULT_SETTINGS, dirs: {} }),
        '/dsh-bg/settings': () => ({ ok: true, settings: DEFAULT_SETTINGS })
      }
    })
    dom.sandbox.__DSH_BG_INITIAL__ = DEFAULT_SETTINGS
    dom.run()
    await settle(6)
    assert.equal(dom.document.body.style.getPropertyValue('--dsh-bg-fade'), '0ms')
    dom.sandbox.dispatchWindow('mousemove', { clientX: 1440, clientY: 900 })
    await flushFrame()
    assert.equal(stageRoot(dom).style.transform, 'translate3d(0.00px, 0.00px, 0)')
    assert.equal(dom.sandbox.__dshBgSwitcher.rotateInfo().minutes, 30)
  })
})

  it('公开 API 暴露在 window 上', async () => {
    const ctx = await boot()
    const api = ctx.sandbox.__dshBgSwitcher
    for (const key of ['open', 'close', 'toggle', 'apply', 'random', 'clear', 'reload', 'state']) {
      assert.ok(key in api, `缺少 ${key}`)
    }
  })

  it('重复引导只建一套 UI（幂等）', async () => {
    const ctx = await boot()
    ctx.run()
    await settle()
    assert.equal(byAttr(ctx.document.body, 'data-dsh-bg-btn').length, 1)
    assert.equal(byAttr(ctx.document.body, 'data-dsh-bg-panel').length, 1)
  })

  it('fetch 失败时不炸掉页面，只在状态栏提示', async () => {
    MutationObserverStub.reset()
    const dom = runInDom(source, {
      routes: {
        '/dsh-bg/list': () => ({ __status: 500, ok: false, message: 'boom' })
      }
    })
    dom.sandbox.__DSH_BG_INITIAL__ = DEFAULT_SETTINGS
    dom.run()
    await settle()
    assert.equal(byAttr(dom.document.body, 'data-dsh-bg-btn').length, 1)
    assert.match(dom.document.querySelector('.dsh-bg-status').textContent, /读取图库失败/)
  })
})
