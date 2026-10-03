/**
 * dsh-bg-switcher —— 浏览器半区
 *
 * 由宿主半区通过 index 注入行 / tapIndex 以 <script src="/dsh-bg/widget.js"> 挂进页面，
 * 是一段自包含的普通脚本（不参与 DSH 的 client module 图），职责：
 *   ① 把选中的背景图贴到 body 上，并让 DSH 外壳（#root / 各层 token）透出来
 *   ② 右侧悬浮按钮 + 缩略图选择面板（图库、上传、本机路径导入、随机、清除）
 *   ③ 遮罩 / 模糊 / 适配模式 / 亮暗分开 / 沉浸模式
 *   ④ 快捷键：Ctrl(⌘)+Shift+B 开关面板，数字键 1-9 直选，R 随机，Esc 关闭
 *
 * 设置持久化在宿主侧（settings.json）——桌面端每次启动都是随机端口，
 * localStorage 会随 origin 变化而失效，所以以服务端为准、localStorage 只做同页缓存。
 */
(() => {
  'use strict'

  if (window.__dshBgSwitcher) return
  window.__dshBgSwitcher = { version: '0.2.1', ready: false }

  const API = '/dsh-bg'
  const LS_KEY = 'dsh-bg-switcher:settings'
  const DEFAULTS = {
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
  const MODE_LABELS = { cover: '填充', contain: '适应', tile: '平铺' }
  /** 遮罩到这个值就基本把壁纸盖死了：自动纠偏并提示。 */
  const SCRIM_LIMIT = 95
  const SCRIM_FALLBACK = 45

  const initial =
    window.__DSH_BG_INITIAL__ && typeof window.__DSH_BG_INITIAL__ === 'object' ? window.__DSH_BG_INITIAL__ : null
  delete window.__DSH_BG_INITIAL__

  /**
   * API 基址：
   *   · 普通网页（`dsh web` / 社区桌面端）页面就是宿主同源，用相对路径最稳；
   *   · 官方桌面端的页面跑在 `dsh-app://app/` 这种自定义协议下，相对路径要靠 Electron
   *     的协议处理器转发，所以优先用宿主注入的绝对地址；
   *   · 请求失败时自动在两种基址之间回退一次。
   */
  const INJECTED_API = typeof window.__DSH_BG_API__ === 'string' ? window.__DSH_BG_API__.replace(/\/+$/, '') : ''
  delete window.__DSH_BG_API__
  // 一律先用**同源相对路径**：官方桌面端页面虽然是 dsh-app://app/，但 Electron 的协议处理器
  // 会把 /dsh-bg/* 代理给宿主（和 whale 挂件同一套路）。绝对地址是跨源请求，会走 CORS ——
  // 图片不受限（所以壁纸能显示），fetch 会被拦（图库空、上传失败、设置存不上）。
  // 因此绝对地址只当兜底：同源请求失败时才切过去（宿主侧同时配了 CORS + Origin 白名单）。
  let apiBase = ''
  let apiNote = 'relative'

  function apiUrl(path) {
    return (apiBase === '' ? '' : apiBase) + API + path
  }

  const state = {
    settings: Object.assign({}, DEFAULTS, initial || cachedSettings() || {}),
    items: [],
    dirs: {},
    open: false,
    busy: false,
    note: '',
    noteKind: 'info',
    cursor: 0
  }

  let refs = null
  let saveTimer = null
  let noteTimer = null
  let toastTimer = null
  let diagSent = false
  let scrimNotified = false
  /** 引导过程的痕迹，随自检回报一起送出去，方便定位"设置没生效"这类问题。 */
  const bootTrace = { hadInitial: initial !== null, hadCache: cachedSettings() !== null, listCalls: 0, listSettings: null, saves: 0, errors: [] }

  // ── 小工具 ────────────────────────────────────────────────────────────────

  function cachedSettings() {
    try {
      const raw = window.localStorage.getItem(LS_KEY)
      return raw === null ? null : JSON.parse(raw)
    } catch {
      return null
    }
  }

  /**
   * 遮罩拉过头会把壁纸整个盖住（用户就是这么把壁纸"弄没"的），纠偏到还能看见的程度。
   * 服务端返回旧设置时也要再纠一次，所以做成幂等函数；提示只发一次。
   */
  function ensureScrimVisible(announce) {
    if (!Number.isFinite(state.settings.dim) || state.settings.dim < SCRIM_LIMIT) return false
    state.settings.dim = SCRIM_FALLBACK
    if (announce === true && !scrimNotified) {
      scrimNotified = true
      notify(`遮罩原本是 100%（会把壁纸完全盖住），已帮你调到 ${SCRIM_FALLBACK}%`, 'ok')
      showToast(`遮罩 100% 会盖住壁纸，已调回 ${SCRIM_FALLBACK}%`, 'ok')
    }
    return true
  }

  function isDark() {
    return document.body !== null && document.body.hasAttribute('data-ds-dark-theme')
  }

  function effectiveId() {
    const s = state.settings
    const wanted = s.split ? (isDark() ? s.darkId : s.lightId) : s.activeId
    if (!wanted) return null
    // 清单还没拿到（首帧）时先乐观贴图，等 /list 回来再对账，避免白屏一闪。
    if (state.items.length === 0) return wanted
    return state.items.some((item) => item.id === wanted) ? wanted : null
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key === 'html') node.innerHTML = value
        else if (key === 'dataset') Object.assign(node.dataset, value)
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
        else node.setAttribute(key, String(value))
      }
    }
    for (const child of children.flat(2)) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  /** 绝对/相对两种基址之间自动回退一次，避免桌面端自定义协议下相对路径不通就彻底歇菜。 */
  async function request(path, options) {
    const attempt = async (url) => {
      const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}))
      const text = await response.text()
      let payload = null
      try {
        payload = text === '' ? null : JSON.parse(text)
      } catch {
        payload = null
      }
      if (!response.ok) {
        const message = payload && payload.message ? payload.message : `HTTP ${response.status}`
        const error = new Error(message)
        // 服务器答复了（4xx/5xx 也是答复）⇒ 基址本身是通的，不要因此切基址
        error.dshResponded = true
        throw error
      }
      return payload || {}
    }
    try {
      return await attempt(apiUrl(path))
    } catch (error) {
      // 只有"请求根本没到服务器"（网络层失败）才值得换基址
      if (error && error.dshResponded === true) throw error
      const other = apiBase === '' ? INJECTED_API : ''
      if (other === '' || other === apiBase) throw error
      apiBase = other
      apiNote = apiBase === '' ? 'relative(fallback)' : 'absolute(fallback)'
      applyBackground()
      if (refs !== null) renderGrid()
      return await attempt(apiUrl(path))
    }
  }

  function notify(message, kind) {
    state.note = message
    state.noteKind = kind || 'info'
    if (refs && refs.status) {
      refs.status.textContent = message
      refs.status.dataset.kind = state.noteKind
    }
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toastTimer = null
      state.note = ''
      if (refs && refs.status) {
        refs.status.textContent = ''
        refs.status.dataset.kind = 'info'
      }
    }, 6000)
  }

  function showToast(message, kind) {
    let toast = document.querySelector('[data-dsh-bg-toast]')
    if (toast === null) {
      toast = el('div', { 'data-dsh-bg-toast': '', class: 'dsh-bg-toast' })
      document.body.append(toast)
    }
    toast.textContent = message
    toast.dataset.kind = kind || 'info'
    toast.dataset.show = 'true'
    if (noteTimer !== null) clearTimeout(noteTimer)
    noteTimer = setTimeout(() => {
      noteTimer = null
      toast.dataset.show = 'false'
    }, 1800)
  }

  // ── 背景渲染（双层 stage：交叉淡入 + 视差）─────────────────────────────────

  const STYLE_ID = 'dsh-bg-switcher-style'
  const STAGE_ATTR = 'data-dsh-bg-stage'
  const SLIDE_ATTR = 'data-dsh-bg-slide'
  const FADE_MS = 480
  const PARALLAX_RANGE = 14

  /** 两层壁纸的舞台；body 只留底色，图放在这里才能做交叉淡入与位移。 */
  let stage = null
  let currentId = null
  let switchToken = 0
  let parallaxHandler = null
  let parallaxReset = null
  let parallaxFrame = 0

  function prefersReducedMotion() {
    try {
      return window.matchMedia !== undefined && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
    } catch {
      return false
    }
  }

  function fadeMs() {
    return prefersReducedMotion() ? 0 : FADE_MS
  }

  function scrimCss() {
    const alpha = Math.min(1, Math.max(0, state.settings.dim / 100))
    return isDark() ? `rgba(14,15,20,${alpha})` : `rgba(252,252,253,${alpha})`
  }

  function ensureStage() {
    const body = document.body
    if (body === null) return null
    if (stage !== null && stage.root.isConnected === true) return stage
    let root = body.querySelector('[' + STAGE_ATTR + ']')
    if (root === null) {
      root = el('div', { dataset: { dshBgStage: '' }, 'aria-hidden': 'true' })
      root.append(el('div', { dataset: { dshBgSlide: 'a' } }), el('div', { dataset: { dshBgSlide: 'b' } }))
      // 放在 body 最前面：z-index:-1 会落在底色之上、所有内容之下
      body.insertBefore(root, body.firstChild)
    }
    stage = { root, slides: [root.children[0], root.children[1]], index: 0 }
    setParallaxTransform(0, 0)
    return stage
  }

  function slideUrl(id) {
    return apiUrl(`/img?id=${encodeURIComponent(id)}`)
  }

  /** 把某张图贴到某一层上（尺寸/重复跟着适配模式走）。 */
  function paintSlide(node, url) {
    const mode = state.settings.mode === 'tile' ? 'auto' : state.settings.mode
    node.style.backgroundImage = `url("${url}")`
    node.style.backgroundSize = mode
    node.style.backgroundRepeat = state.settings.mode === 'tile' ? 'repeat' : 'no-repeat'
    node.style.backgroundPosition = 'center center'
  }

  /** 先把图取到手再淡入，避免大图淡入到一半还在下载（看到半张白）。 */
  function preloadImage(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const image = new Image()
      let settled = false
      const finish = (ok) => {
        if (settled) return
        settled = true
        if (ok) resolve(url)
        else reject(new Error('image unavailable'))
      }
      image.onload = () => finish(true)
      image.onerror = () => finish(false)
      setTimeout(() => finish(false), timeoutMs)
      image.src = url
    })
  }

  function applyBackground(options) {
    const body = document.body
    if (body === null) return
    const s = state.settings
    const id = effectiveId()
    body.style.setProperty('--dsh-bg-x', `${s.btnX}px`)
    body.style.setProperty('--dsh-bg-y', `${s.btnY}px`)
    body.style.setProperty('--dsh-bg-scrim', scrimCss())
    body.style.setProperty('--dsh-bg-blurpx', `${s.blur}px`)
    body.style.setProperty('--dsh-bg-base', isDark() ? '#0e0f13' : '#f5f6f8')
    body.style.setProperty('--dsh-bg-fade', `${fadeMs()}ms`)
    if (id === null) {
      clearBackground()
      return
    }
    body.setAttribute('data-dsh-bg', '')
    if (s.immersive) body.setAttribute('data-dsh-bg-immersive', '')
    else body.removeAttribute('data-dsh-bg-immersive')
    if (s.blur > 0) body.setAttribute('data-dsh-bg-blur', '')
    else body.removeAttribute('data-dsh-bg-blur')

    const st = ensureStage()
    if (st === null) return
    const url = slideUrl(id)
    const animate = options !== undefined && options.animate === true && currentId !== null && currentId !== id
    if (!animate) {
      const shown = st.slides[st.index]
      const hidden = st.slides[1 - st.index]
      paintSlide(shown, url)
      shown.style.opacity = '1'
      hidden.style.opacity = '0'
      hidden.style.backgroundImage = 'none'
      currentId = id
      syncParallax()
      return
    }
    crossfadeTo(st, url, id)
  }

  /** 交叉淡入：旧层淡出、新层淡入；期间再切图就作废上一次的收尾。 */
  function crossfadeTo(st, url, id) {
    const token = ++switchToken
    const outgoing = st.slides[st.index]
    const incoming = st.slides[1 - st.index]
    const finishSwitch = () => {
      if (token !== switchToken) return
      paintSlide(incoming, url)
      incoming.style.opacity = '1'
      outgoing.style.opacity = '0'
      st.index = 1 - st.index
      currentId = id
      setTimeout(() => {
        if (token !== switchToken) return
        outgoing.style.backgroundImage = 'none'
      }, fadeMs() + 80)
    }
    preloadImage(url, 6000).then(finishSwitch, finishSwitch)
    syncParallax()
  }

  function clearBackground() {
    const body = document.body
    if (body === null) return
    for (const prop of ['--dsh-bg-scrim', '--dsh-bg-blurpx', '--dsh-bg-base', '--dsh-bg-fade']) {
      body.style.removeProperty(prop)
    }
    body.removeAttribute('data-dsh-bg')
    body.removeAttribute('data-dsh-bg-immersive')
    body.removeAttribute('data-dsh-bg-blur')
    currentId = null
    switchToken += 1
    if (stage !== null) {
      for (const node of stage.slides) {
        node.style.opacity = '0'
        node.style.backgroundImage = 'none'
      }
    }
    setParallaxTransform(0, 0)
  }

  // ── 视差：鼠标在窗口里移动时壁纸轻微位移 ──────────────────────────────────

  function setParallaxTransform(dx, dy) {
    if (stage === null) return
    const x = (dx * PARALLAX_RANGE).toFixed(2)
    const y = (dy * PARALLAX_RANGE).toFixed(2)
    stage.root.style.transform = `translate3d(${x}px, ${y}px, 0)`
  }

  function scheduleParallax(clientX, clientY) {
    if (parallaxFrame !== 0) return
    parallaxFrame = requestAnimationFrame(() => {
      parallaxFrame = 0
      const width = window.innerWidth || 1
      const height = window.innerHeight || 1
      setParallaxTransform((clientX / width - 0.5) * 2, (clientY / height - 0.5) * 2)
    })
  }

  /** 按设置与系统偏好挂/摘鼠标监听（reduced-motion 下强制关闭）。 */
  function syncParallax() {
    const want = state.settings.parallax === true && !prefersReducedMotion() && currentId !== null
    if (want && parallaxHandler === null) {
      parallaxHandler = (event) => scheduleParallax(event.clientX, event.clientY)
      parallaxReset = () => setParallaxTransform(0, 0)
      window.addEventListener('mousemove', parallaxHandler, { passive: true })
      window.addEventListener('mouseleave', parallaxReset)
      document.addEventListener('mouseleave', parallaxReset)
    } else if (!want && parallaxHandler !== null) {
      window.removeEventListener('mousemove', parallaxHandler)
      window.removeEventListener('mouseleave', parallaxReset)
      document.removeEventListener('mouseleave', parallaxReset)
      parallaxHandler = null
      parallaxReset = null
      setParallaxTransform(0, 0)
    }
  }

  // ── 轮播：按间隔随机（或按顺序）换图，换的时候交叉淡入 ────────────────────

  let rotateTimer = null
  let rotateNextAt = 0

  function rotateMinutes() {
    const raw = Number(state.settings.rotateMinutes)
    if (!Number.isFinite(raw)) return 30
    return Math.max(1, Math.min(720, Math.round(raw)))
  }

  function rotatePool() {
    return state.items.slice()
  }

  function armRotation() {
    disarmRotation()
    if (state.items.length === 0) return
    rotateNextAt = Date.now() + rotateMinutes() * 60_000
    rotateTimer = setInterval(rotateTick, 1000)
  }

  function disarmRotation() {
    if (rotateTimer !== null) {
      clearInterval(rotateTimer)
      rotateTimer = null
    }
    rotateNextAt = 0
    renderRotateCountdown()
  }

  /** 每秒检查：到点就换图；页面不可见时不推进（省电、也不打扰）。 */
  function rotateTick() {
    renderRotateCountdown()
    if (document.hidden === true) return
    if (rotateNextAt === 0) return
    if (Date.now() < rotateNextAt) return
    rotateNextAt = Date.now() + rotateMinutes() * 60_000
    advanceRotation()
  }

  function advanceRotation() {
    const pool = rotatePool()
    if (pool.length === 0) return null
    const current = effectiveId()
    let next = null
    if (state.settings.rotateOrder === 'inOrder') {
      const index = pool.findIndex((item) => item.id === current)
      next = pool[(index + 1 + pool.length) % pool.length]
    } else {
      const candidates = pool.length > 1 ? pool.filter((item) => item.id !== current) : pool
      next = candidates[Math.floor(Math.random() * candidates.length)]
    }
    if (next === undefined || next === null) return null
    applyPick(next.id, { animate: true })
    return next.id
  }

  /** 轮播开关跟着设置与图库数量走。 */
  function syncRotation() {
    const want = state.settings.rotateOn === true && state.items.length > 1
    if (want) {
      if (rotateTimer === null) armRotation()
      else if (rotateNextAt === 0) rotateNextAt = Date.now() + rotateMinutes() * 60_000
    } else if (rotateTimer !== null) {
      disarmRotation()
    }
    renderRotateCountdown()
  }

  function renderRotateCountdown() {
    if (refs === null || refs.rotateCountdown === undefined || refs.rotateCountdown === null) return
    if (state.settings.rotateOn !== true || rotateNextAt === 0) {
      refs.rotateCountdown.textContent = ''
      return
    }
    const left = Math.max(0, Math.round((rotateNextAt - Date.now()) / 1000))
    const mm = String(Math.floor(left / 60)).padStart(2, '0')
    const ss = String(left % 60).padStart(2, '0')
    refs.rotateCountdown.textContent = `下一张 ${mm}:${ss}`
  }

  function styleText() {
    return `
/* 注意：官方前端在 macOS 上有 html[data-platform=darwin] body{background:transparent}，
   权重 (0,1,2) 比 body[data-dsh-bg] (0,1,1) 高 —— 所以底色这一条必须 !important。
   图片本身不放在 body 上，而是放在下面的 stage 两层里（这样才能交叉淡入 + 视差）。 */
body[data-dsh-bg]{background-color:var(--dsh-bg-base,#f5f6f8)!important}

/* 壁纸舞台：z-index:-1 ⇒ 在 body 底色之上、所有内容之下；inset:-3% 给视差留位移余量 */
[data-dsh-bg-stage]{
  position:fixed;
  inset:-3%;
  z-index:-1;
  overflow:hidden;
  pointer-events:none;
  transform:translate3d(0,0,0);
  transition:transform .35s ease-out;
  will-change:transform;
}
[data-dsh-bg-slide]{
  position:absolute;
  inset:0;
  opacity:0;
  transition:opacity var(--dsh-bg-fade,480ms) ease;
  will-change:opacity;
}
body[data-dsh-bg] #root{background:var(--dsh-bg-scrim,rgba(252,252,253,.45))}
body[data-dsh-bg][data-dsh-bg-blur] #root{
  -webkit-backdrop-filter:blur(var(--dsh-bg-blurpx,0px));
  backdrop-filter:blur(var(--dsh-bg-blurpx,0px));
}
/* 沉浸模式：把外壳各层底色换成半透明，让背景图透上来（与 Denia 皮肤同一套 token） */
body[data-dsh-bg][data-dsh-bg-immersive]{
  --dsw-alias-bg-base:transparent!important;
  --dsw-alias-bg-layer-1:rgba(255,255,255,.84)!important;
  --dsw-alias-bg-layer-2:rgba(250,250,252,.88)!important;
  --dsw-alias-bg-layer-3:rgba(244,245,247,.92)!important;
  --dsw-alias-bg-overlay:rgba(255,255,255,.97)!important;
  /* Windows 的外层 frame、标题栏和侧栏共用这枚 token；叠加底色会遮住壁纸。
     让这些层透出同一张图，文字可读性统一由 #root 的遮罩控制。 */
  --dsw-specific-sidebar-fill:transparent!important;
  --dsw-specific-input-major:rgba(255,255,255,.78)!important;
  --dsw-specific-selector:rgba(245,246,247,.88)!important;
}
body[data-dsh-bg][data-dsh-bg-immersive][data-ds-dark-theme]{
  --dsw-alias-bg-layer-1:rgba(24,24,27,.86)!important;
  --dsw-alias-bg-layer-2:rgba(31,31,35,.9)!important;
  --dsw-alias-bg-layer-3:rgba(38,38,42,.93)!important;
  --dsw-alias-bg-overlay:rgba(18,18,21,.97)!important;
  --dsw-specific-sidebar-fill:transparent!important;
  --dsw-specific-input-major:rgba(30,30,34,.82)!important;
  --dsw-specific-selector:rgba(38,38,42,.9)!important;
}

/* ── 悬浮按钮 ── */
[data-dsh-bg-btn]{
  position:fixed;
  right:calc(10px - var(--dsh-bg-x,0px));
  top:calc(50% + var(--dsh-bg-y,0px));
  transform:translateY(-50%);
  width:34px;height:34px;padding:0;
  display:flex;align-items:center;justify-content:center;
  border-radius:10px;cursor:grab;
  border:1px solid rgba(127,127,127,.35);
  background:rgba(255,255,255,.72);
  color:#3c3c3d;
  box-shadow:0 2px 10px rgba(0,0,0,.14);
  -webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);
  z-index:2147483000;
  opacity:.55;transition:opacity .18s ease,transform .18s ease;
  touch-action:none;user-select:none;
}
[data-dsh-bg-btn]:hover{opacity:1}
[data-dsh-bg-btn][data-dragging="true"]{cursor:grabbing;opacity:1}
[data-dsh-bg-btn][data-active="true"]{opacity:1;border-color:rgba(65,118,230,.6);color:#4176e6}
body[data-ds-dark-theme] [data-dsh-bg-btn]{background:rgba(31,31,35,.75);color:#e6e6e8;border-color:rgba(255,255,255,.18)}
body[data-ds-dark-theme] [data-dsh-bg-btn][data-active="true"]{color:#7aaaff;border-color:rgba(122,170,255,.6)}
body[data-dsh-bg-hiddenbtn] [data-dsh-bg-btn]{display:none}

/* ── 面板 ── */
[data-dsh-bg-panel]{
  position:fixed;
  right:calc(56px - var(--dsh-bg-x,0px));
  top:calc(50% + var(--dsh-bg-y,0px));
  transform:translateY(-50%) scale(.97);
  transform-origin:100% 50%;
  width:344px;max-height:80vh;
  display:none;flex-direction:column;
  border-radius:14px;overflow:hidden;
  border:1px solid rgba(127,127,127,.28);
  background:rgba(252,252,253,.94);
  color:#1f1f22;
  box-shadow:0 14px 44px rgba(0,0,0,.22);
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  z-index:2147483001;
  font-size:12px;line-height:1.5;
  transition:transform .16s ease;
}
[data-dsh-bg-panel][data-open="true"]{display:flex;transform:translateY(-50%) scale(1)}
body[data-ds-dark-theme] [data-dsh-bg-panel]{background:rgba(22,22,26,.95);color:#ececef;border-color:rgba(255,255,255,.14)}
.dsh-bg-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(127,127,127,.2);font-weight:600;font-size:13px}
.dsh-bg-head .dsh-bg-count{margin-left:auto;font-weight:400;opacity:.6;font-size:11px}
.dsh-bg-x{border:0;background:transparent;color:inherit;font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px;opacity:.65}
.dsh-bg-x:hover{opacity:1;background:rgba(127,127,127,.16)}
.dsh-bg-tools{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 6px}
.dsh-bg-tool{
  border:1px solid rgba(127,127,127,.3);background:rgba(127,127,127,.06);color:inherit;
  font-size:11px;padding:4px 9px;border-radius:999px;cursor:pointer;white-space:nowrap;
}
.dsh-bg-tool:hover{background:rgba(65,118,230,.14);border-color:rgba(65,118,230,.45)}
.dsh-bg-tool[disabled]{opacity:.45;cursor:default}
.dsh-bg-pathrow{display:none;gap:6px;padding:2px 10px 8px}
.dsh-bg-pathrow[data-show="true"]{display:flex}
.dsh-bg-pathrow input{
  flex:1;min-width:0;font-size:11px;padding:5px 8px;border-radius:8px;
  border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.07);color:inherit;
}
.dsh-bg-grid{
  flex:1;min-height:90px;overflow-y:auto;
  display:grid;grid-template-columns:repeat(3,1fr);gap:8px;
  padding:4px 10px 8px;
}
.dsh-bg-card{
  position:relative;border-radius:10px;overflow:hidden;aspect-ratio:16/10;cursor:pointer;
  border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.12);
  padding:0;
}
.dsh-bg-card img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.dsh-bg-card:hover{border-color:rgba(65,118,230,.6)}
.dsh-bg-card[data-active="true"]{border-color:#4176e6;box-shadow:0 0 0 2px rgba(65,118,230,.45) inset}
.dsh-bg-card .dsh-bg-cap{
  position:absolute;left:0;right:0;bottom:0;padding:8px 5px 3px;color:#fff;font-size:10px;
  background:linear-gradient(transparent,rgba(0,0,0,.72));
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:left;
}
.dsh-bg-card .dsh-bg-flag{
  position:absolute;top:3px;left:3px;font-size:9px;padding:0 4px;border-radius:5px;
  background:rgba(0,0,0,.5);color:#fff;
}
.dsh-bg-card .dsh-bg-del{
  position:absolute;top:3px;right:3px;width:17px;height:17px;padding:0;border:0;border-radius:50%;
  background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:1;cursor:pointer;display:none;
}
.dsh-bg-card:hover .dsh-bg-del{display:block}
.dsh-bg-empty{grid-column:1/-1;padding:18px 6px;text-align:center;opacity:.65}
.dsh-bg-sect{padding:2px 10px 8px;border-top:1px solid rgba(127,127,127,.16)}
.dsh-bg-row{display:flex;align-items:center;gap:8px;padding:5px 0}
.dsh-bg-row label{flex:0 0 44px;opacity:.75}
.dsh-bg-row input[type=range]{flex:1;min-width:0;accent-color:#4176e6}
.dsh-bg-row .dsh-bg-val{flex:0 0 34px;text-align:right;opacity:.65;font-variant-numeric:tabular-nums}
.dsh-bg-pills{display:flex;gap:6px;flex-wrap:wrap;padding:2px 0}
.dsh-bg-pill{
  border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;
  font-size:11px;padding:3px 10px;border-radius:999px;cursor:pointer;
}
.dsh-bg-pill[data-on="true"]{background:rgba(65,118,230,.18);border-color:rgba(65,118,230,.6);color:inherit;font-weight:600}
.dsh-bg-toggle{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;opacity:.85;padding:3px 0}
.dsh-bg-toggle input{accent-color:#4176e6}
.dsh-bg-hint{font-size:10px;opacity:.55;padding:0 0 2px}
.dsh-bg-hint[data-warn="true"],.dsh-bg-val[data-warn="true"]{color:#e0554d;opacity:1}
.dsh-bg-row .dsh-bg-num{width:52px;flex:0 0 52px;font-size:11px;padding:3px 6px;border-radius:7px;border:1px solid rgba(127,127,127,.32);background:rgba(127,127,127,.07);color:inherit;text-align:right}
.dsh-bg-rotate-count{font-size:10px;opacity:.6;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-bg-row input[type=range][data-warn="true"]{accent-color:#e0554d}
.dsh-bg-status{padding:5px 10px;font-size:11px;min-height:20px;border-top:1px solid rgba(127,127,127,.16);opacity:.8}
.dsh-bg-status[data-kind="error"]{color:#e0554d;opacity:1}
.dsh-bg-status[data-kind="ok"]{color:#22a06b;opacity:1}
.dsh-bg-foot{padding:0 10px 9px;font-size:10px;opacity:.5}
.dsh-bg-toast{
  position:fixed;left:50%;bottom:64px;transform:translate(-50%,10px);
  padding:6px 14px;border-radius:999px;font-size:12px;
  background:rgba(28,28,32,.92);color:#fff;opacity:0;pointer-events:none;
  transition:opacity .18s ease,transform .18s ease;z-index:2147483002;
}
.dsh-bg-toast[data-show="true"]{opacity:1;transform:translate(-50%,0)}
.dsh-bg-toast[data-kind="error"]{background:rgba(180,40,36,.95)}
`
  }

  function mountStyle() {
    let style = document.getElementById(STYLE_ID)
    if (style === null) {
      style = el('style', { id: STYLE_ID })
      document.head.append(style)
    }
    style.textContent = styleText()
  }

  // ── 面板 DOM ──────────────────────────────────────────────────────────────

  const ICON_IMAGE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.6" cy="9.4" r="1.5"/>' +
    '<path d="M4 17.5l4.3-4.2a1.6 1.6 0 0 1 2.24 0L15 17.6"/><path d="M14.4 14.4l1.4-1.3a1.6 1.6 0 0 1 2.2 0l2 1.9"/></svg>'

  function buildUi() {
    if (document.body === null) return false
    if (refs !== null) return true

    const button = el('button', {
      'data-dsh-bg-btn': '',
      type: 'button',
      title: '背景图切换（Ctrl/⌘+Shift+B）',
      html: ICON_IMAGE,
      'aria-label': '背景图切换'
    })

    const status = el('div', { class: 'dsh-bg-status' })
    const grid = el('div', { class: 'dsh-bg-grid' })
    const count = el('span', { class: 'dsh-bg-count' })
    const pathRow = el('div', { class: 'dsh-bg-pathrow' })
    const pathInput = el('input', { type: 'text', placeholder: '粘贴本机图片绝对路径，例如 ~/Pictures/a.png' })
    const pathOk = el('button', { class: 'dsh-bg-tool', type: 'button', text: '导入' })
    pathRow.append(pathInput, pathOk)

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/*',
      multiple: true,
      style: 'display:none'
    })

    const tool = (label, title, onClick) =>
      el('button', { class: 'dsh-bg-tool', type: 'button', text: label, title: title || label, onclick: onClick })

    const buttons = {
      random: tool('随机', '随机换一张（快捷键 R）', () => randomPick()),
      upload: tool('上传', '从本机选择图片并加入图库', () => fileInput.click()),
      path: tool('路径', '把本机某个路径的图片复制进图库', () => {
        const show = pathRow.dataset.show !== 'true'
        pathRow.dataset.show = show ? 'true' : 'false'
        if (show) pathInput.focus()
      }),
      folder: tool('图库', '在文件管理器里打开用户图库目录', () => revealFolder()),
      clear: tool('清除', '取消背景图', () => clearPick()),
      reload: tool('刷新', '重新读取图库与设置', () => reload()),
      diag: tool('诊断', '把当前页面状态回报给宿主（写进 profile 的 data 目录）', () => {
        void diagnose('manual').then(() => {
          if (state.note === '') showToast('诊断已回报给宿主', 'ok')
        })
      })
    }

    const dimSlider = el('input', { type: 'range', min: '0', max: '100', step: '1' })
    const dimValue = el('span', { class: 'dsh-bg-val' })
    const blurSlider = el('input', { type: 'range', min: '0', max: '24', step: '1' })
    const blurValue = el('span', { class: 'dsh-bg-val' })

    const modePills = {}
    const modeRow = el('div', { class: 'dsh-bg-pills' })
    for (const mode of ['cover', 'contain', 'tile']) {
      modePills[mode] = el('button', {
        class: 'dsh-bg-pill',
        type: 'button',
        text: MODE_LABELS[mode],
        onclick: () => update({ mode })
      })
      modeRow.append(modePills[mode])
    }

    const splitBox = el('input', { type: 'checkbox' })
    const immersiveBox = el('input', { type: 'checkbox' })
    const hiddenBox = el('input', { type: 'checkbox' })
    const parallaxBox = el('input', { type: 'checkbox' })
    splitBox.addEventListener('change', () => update({ split: splitBox.checked }))
    immersiveBox.addEventListener('change', () => update({ immersive: immersiveBox.checked }))
    hiddenBox.addEventListener('change', () => update({ hidden: hiddenBox.checked }))
    parallaxBox.addEventListener('change', () => update({ parallax: parallaxBox.checked }))

    // 轮播：开关 + 间隔（分钟）+ 顺序 + 下一次倒计时
    const rotateBox = el('input', { type: 'checkbox' })
    const rotateMinutesInput = el('input', { type: 'number', min: '1', max: '720', step: '1', class: 'dsh-bg-num' })
    const rotateCountdown = el('span', { class: 'dsh-bg-rotate-count' })
    const rotateOrderPills = {}
    const rotateOrderRow = el('div', { class: 'dsh-bg-pills' })
    for (const order of ['random', 'inOrder']) {
      rotateOrderPills[order] = el('button', {
        class: 'dsh-bg-pill',
        type: 'button',
        text: order === 'random' ? '随机' : '按顺序',
        onclick: () => update({ rotateOrder: order })
      })
      rotateOrderRow.append(rotateOrderPills[order])
    }
    rotateBox.addEventListener('change', () => update({ rotateOn: rotateBox.checked }))
    rotateMinutesInput.addEventListener('change', () => {
      const value = Number(rotateMinutesInput.value)
      update({ rotateMinutes: Number.isFinite(value) ? value : 30 })
    })

    const panel = el(
      'div',
      { 'data-dsh-bg-panel': '', 'data-open': 'false', role: 'dialog', 'aria-label': '背景图切换' },
      el(
        'div',
        { class: 'dsh-bg-head' },
        el('span', { text: '背景图' }),
        count,
        el('button', { class: 'dsh-bg-x', type: 'button', text: '✕', title: '关闭（Esc）', onclick: () => setOpen(false) })
      ),
      el('div', { class: 'dsh-bg-tools' }, buttons.random, buttons.upload, buttons.path, buttons.folder, buttons.clear, buttons.reload),
      pathRow,
      fileInput,
      grid,
      el(
        'div',
        { class: 'dsh-bg-sect' },
        el('div', { class: 'dsh-bg-row' }, el('label', { text: '遮罩' }), dimSlider, dimValue),
        el('div', { class: 'dsh-bg-row' }, el('label', { text: '模糊' }), blurSlider, blurValue),
        el('div', { class: 'dsh-bg-pills' }, el('span', { class: 'dsh-bg-hint', text: '适配：' }), modeRow),
        el(
          'div',
          { class: 'dsh-bg-row' },
          el('label', { class: 'dsh-bg-toggle', style: 'flex:0 0 auto' }, rotateBox, el('span', { text: '轮播' })),
          el('span', { class: 'dsh-bg-hint', text: '每' }),
          rotateMinutesInput,
          el('span', { class: 'dsh-bg-hint', text: '分钟' }),
          rotateCountdown
        ),
        el('div', { class: 'dsh-bg-pills' }, el('span', { class: 'dsh-bg-hint', text: '顺序：' }), rotateOrderRow),
        el('label', { class: 'dsh-bg-toggle' }, splitBox, el('span', { text: '亮色 / 暗色分开设置' })),
        el('label', { class: 'dsh-bg-toggle' }, immersiveBox, el('span', { text: '沉浸模式（让界面各层透出背景）' })),
        el('label', { class: 'dsh-bg-toggle' }, parallaxBox, el('span', { text: '视差（鼠标移动时壁纸轻微位移）' })),
        el('label', { class: 'dsh-bg-toggle' }, hiddenBox, el('span', { text: '隐藏悬浮按钮（仅用快捷键）' })),
        el('div', { class: 'dsh-bg-hint dsh-bg-hint-line' })
      ),
      status,
      el('div', { class: 'dsh-bg-foot', text: 'Ctrl/⌘+Shift+B 开关面板 · 数字键 1-9 直选 · R 随机 · Esc 关闭' })
    )

    refs = {
      button,
      panel,
      grid,
      count,
      status,
      pathRow,
      pathInput,
      pathOk,
      fileInput,
      buttons,
      dimSlider,
      dimValue,
      blurSlider,
      blurValue,
      modePills,
      splitBox,
      immersiveBox,
      hiddenBox,
      parallaxBox,
      rotateBox,
      rotateMinutesInput,
      rotateCountdown,
      rotateOrderPills,
      hintLine: panel.querySelector('.dsh-bg-hint-line')
    }

    document.body.append(button, panel)

    // ── 交互 ──
    dimSlider.addEventListener('input', () => {
      refs.dimValue.textContent = `${dimSlider.value}%`
      update({ dim: Number(dimSlider.value) }, { skipControls: true })
    })
    blurSlider.addEventListener('input', () => {
      refs.blurValue.textContent = `${blurSlider.value}px`
      update({ blur: Number(blurSlider.value) }, { skipControls: true })
    })
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || [])
      fileInput.value = ''
      if (files.length > 0) void uploadFiles(files)
    })
    pathOk.addEventListener('click', () => void addPath(pathInput.value))
    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void addPath(pathInput.value)
    })

    button.addEventListener('click', (event) => {
      if (button.dataset.dragged === 'true') {
        button.dataset.dragged = 'false'
        return
      }
      event.preventDefault()
      setOpen(!state.open)
    })
    installDrag(button)

    document.addEventListener(
      'keydown',
      (event) => {
        const target = event.target
        const typing =
          target instanceof HTMLElement &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'b' || event.key === 'B')) {
          event.preventDefault()
          setOpen(!state.open)
          return
        }
        if (!state.open || typing) return
        if (event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
          return
        }
        if (event.key === 'r' || event.key === 'R') {
          event.preventDefault()
          randomPick()
          return
        }
        if (/^[1-9]$/.test(event.key)) {
          const item = state.items[Number(event.key) - 1]
          if (item) {
            event.preventDefault()
            pick(item.id)
          }
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          event.preventDefault()
          moveCursor(1)
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          event.preventDefault()
          moveCursor(-1)
        } else if (event.key === 'Enter') {
          const item = state.items[state.cursor]
          if (item) {
            event.preventDefault()
            pick(item.id)
          }
        }
      },
      true
    )

    return true
  }

  function installDrag(button) {
    let startX = 0
    let startY = 0
    let baseX = 0
    let baseY = 0
    let dragging = false

    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      dragging = true
      startX = event.clientX
      startY = event.clientY
      baseX = state.settings.btnX
      baseY = state.settings.btnY
      button.dataset.dragged = 'false'
      button.setPointerCapture(event.pointerId)
    })
    button.addEventListener('pointermove', (event) => {
      if (!dragging) return
      const dx = event.clientX - startX
      const dy = event.clientY - startY
      if (!button.dataset.dragged) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
        button.dataset.dragged = 'true'
        button.dataset.dragging = 'true'
      }
      const maxX = Math.max(0, window.innerWidth - 60)
      const maxY = Math.max(0, window.innerHeight - 60)
      state.settings.btnX = Math.max(-maxX, Math.min(20, Math.round(baseX + dx)))
      state.settings.btnY = Math.max(-maxY, Math.min(maxY, Math.round(baseY + dy)))
      document.body.style.setProperty('--dsh-bg-x', `${state.settings.btnX}px`)
      document.body.style.setProperty('--dsh-bg-y', `${state.settings.btnY}px`)
    })
    const finish = () => {
      if (!dragging) return
      dragging = false
      button.dataset.dragging = 'false'
      if (button.dataset.dragged === 'true') save()
    }
    button.addEventListener('pointerup', finish)
    button.addEventListener('pointercancel', finish)
  }

  function moveCursor(step) {
    if (state.items.length === 0) return
    state.cursor = (state.cursor + step + state.items.length) % state.items.length
    renderGrid()
    const wanted = state.items[state.cursor].id
    for (const card of refs.grid.children) {
      if (card.dataset && card.dataset.id === wanted) {
        card.scrollIntoView({ block: 'nearest' })
        break
      }
    }
  }

  function setOpen(open) {
    if (!buildUi()) return
    state.open = open
    refs.panel.dataset.open = open ? 'true' : 'false'
    refs.button.dataset.active = open ? 'true' : 'false'
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  function renderGrid() {
    if (refs === null) return
    const active = effectiveId()
    refs.grid.textContent = ''
    refs.count.textContent = `${state.items.length} 张`
    if (state.items.length === 0) {
      refs.grid.append(el('div', { class: 'dsh-bg-empty', text: '图库是空的：点「上传」或「路径」加入图片。' }))
      return
    }
    state.items.forEach((item, index) => {
      const card = el('div', {
        class: 'dsh-bg-card',
        'data-id': item.id,
        'data-active': item.id === active ? 'true' : 'false',
        title: `${item.name}${item.width ? ` · ${item.width}×${item.height}` : ''}${item.source === 'builtin' ? ' · 内置' : ''}`,
        tabindex: '0',
        role: 'button'
      })
      card.append(
        el('img', {
          src: apiUrl(`/thumb?id=${encodeURIComponent(item.id)}`),
          alt: item.name,
          loading: 'lazy',
          draggable: 'false'
        })
      )
      if (index < 9) card.append(el('span', { class: 'dsh-bg-flag', text: String(index + 1) }))
      card.append(el('span', { class: 'dsh-bg-cap', text: item.name }))
      card.addEventListener('click', () => pick(item.id))
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          pick(item.id)
        }
      })
      if (item.source === 'user') {
        card.append(
          el('button', {
            class: 'dsh-bg-del',
            type: 'button',
            text: '✕',
            title: '从图库删除',
            onclick: (event) => {
              event.stopPropagation()
              void removeItem(item)
            }
          })
        )
      }
      refs.grid.append(card)
    })
  }

  function syncControls() {
    if (refs === null) return
    const s = state.settings
    refs.dimSlider.value = String(s.dim)
    refs.dimValue.textContent = `${s.dim}%`
    // 遮罩拉满等于把壁纸盖死：滑块变色 + 文案提醒
    const blinding = Number(s.dim) >= SCRIM_LIMIT
    refs.dimSlider.dataset.warn = blinding ? 'true' : 'false'
    refs.dimValue.dataset.warn = blinding ? 'true' : 'false'
    refs.dimSlider.title = blinding ? '遮罩已接近 100%：壁纸会被完全盖住，建议调到 60% 以下' : '内容层遮罩浓度（越高壁纸越淡）'
    refs.blurSlider.value = String(s.blur)
    refs.blurValue.textContent = `${s.blur}px`
    for (const [mode, pill] of Object.entries(refs.modePills)) {
      pill.dataset.on = mode === s.mode ? 'true' : 'false'
    }
    refs.splitBox.checked = Boolean(s.split)
    refs.immersiveBox.checked = Boolean(s.immersive)
    refs.hiddenBox.checked = Boolean(s.hidden)
    refs.parallaxBox.checked = s.parallax !== false
    document.body.toggleAttribute('data-dsh-bg-hiddenbtn', Boolean(s.hidden))

    const rotating = s.rotateOn === true
    refs.rotateBox.checked = rotating
    if (document.activeElement !== refs.rotateMinutesInput) refs.rotateMinutesInput.value = String(rotateMinutes())
    refs.rotateMinutesInput.disabled = !rotating
    for (const [order, pill] of Object.entries(refs.rotateOrderPills)) {
      pill.dataset.on = order === s.rotateOrder ? 'true' : 'false'
    }
    refs.rotateCountdown.textContent = rotating && state.items.length > 1 ? refs.rotateCountdown.textContent : ''

    const side = isDark() ? 'dark' : 'light'
    const current = s.split ? s[`${side}Id`] : s.activeId
    const item = state.items.find((entry) => entry.id === current)
    if (blinding) {
      refs.hintLine.textContent = `遮罩 ${s.dim}% 会把壁纸完全盖住，往下拉就能看见`
      refs.hintLine.dataset.warn = 'true'
    } else {
      refs.hintLine.dataset.warn = 'false'
      refs.hintLine.textContent = s.split
        ? `分开模式：点图片即设为「${isDark() ? '暗色' : '亮色'}」背景；当前${isDark() ? '暗色' : '亮色'}：${item ? item.name : '未设置'}`
        : item
          ? `当前：${item.name}（点缩略图切换）`
          : '点缩略图即可切换背景'
    }
  }

  function renderAll() {
    applyBackground()
    renderGrid()
    syncControls()
  }

  // ── 业务动作 ──────────────────────────────────────────────────────────────

  /** 统一的"换到某张图"入口：手动点选与轮播都走这里（手动会重置倒计时）。 */
  function applyPick(id, options) {
    const item = state.items.find((entry) => entry.id === id)
    if (!item) return false
    const animate = options !== undefined && options.animate === true
    if (state.settings.split) {
      const key = isDark() ? 'darkId' : 'lightId'
      update({ [key]: id }, { animate })
    } else {
      update({ activeId: id }, { animate })
    }
    const index = state.items.findIndex((entry) => entry.id === id)
    if (index >= 0) state.cursor = index
    // 手动换图后重新起算，避免刚点完就被轮播换走
    if (rotateTimer !== null) rotateNextAt = Date.now() + rotateMinutes() * 60_000
    return true
  }

  function pick(id) {
    const item = state.items.find((entry) => entry.id === id)
    if (!item) return
    if (applyPick(id, { animate: true }) === true) showToast(`已应用：${item.name}`, 'ok')
  }

  function randomPick() {
    if (state.items.length === 0) {
      notify('图库是空的', 'error')
      return
    }
    const current = effectiveId()
    const pool = state.items.length > 1 ? state.items.filter((item) => item.id !== current) : state.items
    applyPick(pool[Math.floor(Math.random() * pool.length)].id, { animate: true })
  }

  function clearPick() {
    if (state.settings.split) {
      update(isDark() ? { darkId: null } : { lightId: null })
    } else {
      update({ activeId: null })
    }
    showToast('已清除背景', 'ok')
  }

  function update(patch, options) {
    Object.assign(state.settings, patch)
    const animate = options !== undefined && options.animate === true
    applyBackground({ animate })
    if (!options || !options.skipControls) syncControls()
    if (Object.keys(patch).some((key) => key === 'parallax')) syncParallax()
    if (Object.keys(patch).some((key) => key.startsWith('rotate'))) syncRotation()
    // 选区变化要重画高亮；滑块类改动不重画，省掉无谓的 DOM 重建。
    if (Object.keys(patch).some((key) => key.endsWith('Id') || key === 'split')) renderGrid()
    save()
  }

  function save() {
    if (saveTimer !== null) clearTimeout(saveTimer)
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(state.settings))
    } catch {
      /* 忽略 */
    }
    saveTimer = setTimeout(() => {
      saveTimer = null
      void request('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: state.settings })
      })
        .then((payload) => {
          if (payload && payload.settings) {
            state.settings = Object.assign({}, DEFAULTS, payload.settings)
            applyBackground()
            syncControls()
          }
        })
        .catch((error) => notify(`设置保存失败：${error.message}`, 'error'))
    }, 260)
  }

  async function reload() {
    if (state.busy) return null
    state.busy = true
    try {
      const payload = await request('/list')
      bootTrace.listCalls += 1
      bootTrace.listSettings = payload.settings ? Object.keys(payload.settings).slice(0, 20) : null
      bootTrace.listActiveId = payload.settings ? String(payload.settings.activeId) : null
      bootTrace.listDim = payload.settings ? payload.settings.dim : null
      bootTrace.snapshotActiveId = initial === null ? null : String(initial.activeId)
      state.items = Array.isArray(payload.items) ? payload.items : []
      state.dirs = payload.dirs || {}
      if (payload.settings) state.settings = Object.assign({}, DEFAULTS, payload.settings)
      // 服务端可能还存着"把壁纸盖死"的遮罩值：合并后立刻纠偏并落盘
      if (ensureScrimVisible(true)) save()
      const active = effectiveId()
      const index = state.items.findIndex((item) => item.id === active)
      state.cursor = index >= 0 ? index : 0
      renderAll()
      syncRotation()
      return payload
    } catch (error) {
      // 只提示、不外抛：调用方多半是 `void reload()`，未处理的 rejection 会污染控制台。
      bootTrace.errors.push(`list: ${error.message}`)
      notify(`读取图库失败：${error.message}`, 'error')
      return null
    } finally {
      state.busy = false
    }
  }

  async function uploadFiles(files) {
    let added = 0
    for (const file of files) {
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result || ''))
          reader.onerror = () => reject(new Error('读取文件失败'))
          reader.readAsDataURL(file)
        })
        const payload = await request('/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: file.name, dataUrl })
        })
        if (payload.items) state.items = payload.items
        added += 1
      } catch (error) {
        notify(`「${file.name}」加入失败：${error.message}`, 'error')
      }
    }
    if (added > 0) {
      renderGrid()
      notify(`已加入 ${added} 张图片`, 'ok')
    }
  }

  async function addPath(rawPath) {
    const path = String(rawPath || '').trim()
    if (path === '') return
    try {
      const payload = await request('/add-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path })
      })
      if (payload.items) state.items = payload.items
      refs.pathInput.value = ''
      refs.pathRow.dataset.show = 'false'
      renderGrid()
      notify('已导入图库', 'ok')
    } catch (error) {
      notify(`导入失败：${error.message}`, 'error')
    }
  }

  async function removeItem(item) {
    try {
      const payload = await request('/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id })
      })
      if (payload.items) state.items = payload.items
      if (payload.settings) state.settings = Object.assign({}, DEFAULTS, payload.settings)
      renderAll()
      notify(`已删除「${item.name}」`, 'ok')
    } catch (error) {
      notify(`删除失败：${error.message}`, 'error')
    }
  }

  async function revealFolder() {
    try {
      const payload = await request('/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (payload && payload.ok === false) notify(payload.message || '无法打开目录', 'error')
      else notify(`图库目录：${(payload && payload.dir) || state.dirs.user || ''}`, 'ok')
    } catch (error) {
      notify(`打开目录失败：${error.message}`, 'error')
    }
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  function watchTheme() {
    const observer = new MutationObserver(() => {
      applyBackground()
      syncControls()
    })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  }

  /**
   * 页面自检：把"浏览器里真正看到的东西"打包回传给宿主半区（写进 data/dsh-bg-switcher/diag.json）。
   * 只在宿主有 /dsh-bg/diag 路由时有用；失败静默。
   */
  function collectDiag(reason) {
    const summary = (node) => {
      if (!node || node.nodeType !== 1) return null
      const cs = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        tag: node.tagName,
        id: node.id || '',
        cls: String(node.className || '').slice(0, 80),
        size: [Math.round(rect.width), Math.round(rect.height)],
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage.slice(0, 90),
        opacity: cs.opacity,
        z: cs.zIndex,
        pos: cs.position,
        filter: cs.filter,
        backdrop: cs.backdropFilter
      }
    }
    const out = {
      reason,
      at: new Date().toISOString(),
      href: String(location.href).slice(0, 200),
      origin: String(location.origin || location.protocol),
      protocol: location.protocol,
      readyState: document.readyState,
      api: { base: apiBase === '' ? '(same-origin relative)' : apiBase, injected: INJECTED_API, note: apiNote },
      settings: Object.assign({}, state.settings),
      items: state.items.length,
      effectiveId: effectiveId(),
      boot: Object.assign({}, bootTrace)
    }
    try {
      const body = document.body
      const cs = getComputedStyle(body)
      out.body = {
        attrs: Array.from(body.attributes || []).map((a) => a.name),
        computed: {
          bgImage: cs.backgroundImage.slice(0, 140),
          bgColor: cs.backgroundColor,
          bgSize: cs.backgroundSize,
          bgAttach: cs.backgroundAttachment
        },
        vars: {
          image: body.style.getPropertyValue('--dsh-bg-image').slice(0, 140),
          scrim: body.style.getPropertyValue('--dsh-bg-scrim'),
          blur: body.style.getPropertyValue('--dsh-bg-blurpx'),
          base: body.style.getPropertyValue('--dsh-bg-base')
        },
        tokens: {
          base: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
          sidebar: cs.getPropertyValue('--dsw-specific-sidebar-fill').trim()
        }
      }
      const root = document.getElementById('root')
      out.root = summary(root)
      if (root) out.root.tokenBase = getComputedStyle(root).getPropertyValue('--dsw-alias-bg-base').trim()
      out.stack = []
      let node = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2))
      for (let index = 0; index < 7 && node; index += 1) {
        out.stack.push(summary(node))
        node = node.parentElement
      }
      const style = document.getElementById(STYLE_ID)
      out.style = { mounted: style !== null, length: style === null ? 0 : style.textContent.length }
      const api = window.__dshBgSwitcher
      out.widget = {
        ready: Boolean(api && api.ready),
        button: document.querySelector('[data-dsh-bg-btn]') !== null,
        panel: document.querySelector('[data-dsh-bg-panel]') !== null,
        open: state.open,
        cards: document.querySelectorAll('[data-dsh-bg-panel] [data-id]').length,
        thumbs: Array.from(document.querySelectorAll('[data-dsh-bg-panel] img')).map((img) => ({
          src: String(img.getAttribute('src')).slice(0, 90),
          natural: [img.naturalWidth, img.naturalHeight]
        }))
      }
      out.rotate = {
        on: state.settings.rotateOn === true,
        minutes: rotateMinutes(),
        order: state.settings.rotateOrder,
        armed: rotateTimer !== null,
        nextIn: rotateNextAt === 0 ? null : Math.max(0, Math.round((rotateNextAt - Date.now()) / 1000))
      }
      out.parallax = {
        on: state.settings.parallax === true && parallaxHandler !== null,
        reducedMotion: prefersReducedMotion(),
        transform: stage === null ? '' : stage.root.style.transform
      }
      out.stage = stage === null ? null : {
        slides: stage.slides.map((node) => ({
          opacity: node.style.opacity,
          hasImage: String(node.style.backgroundImage || '').includes('/dsh-bg/img'),
          size: node.style.backgroundSize || ''
        })),
        index: stage.index,
        currentId
      }
      const active = effectiveId()
      out.imageProbe = active === null ? null : { src: apiUrl(`/img?id=${encodeURIComponent(active)}`).slice(0, 160), pending: true }
    } catch (error) {
      out.error = String((error && error.stack) || error)
    }
    return out
  }

  /** 真的把背景图取一次，报回 naturalWidth/耗时；带超时，绝不拖住诊断。 */
  function probeImage(url, timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now()
      const image = new Image()
      let done = false
      const finish = (ok, note) => {
        if (done) return
        done = true
        resolve({ src: String(url).slice(0, 160), ok, bytes: [image.naturalWidth, image.naturalHeight], ms: Date.now() - started, note: note || '' })
      }
      image.onload = () => finish(true)
      image.onerror = () => finish(false, 'onerror')
      setTimeout(() => finish(false, 'timeout'), timeoutMs)
      image.src = url
    })
  }

  async function diagnose(reason, options) {
    try {
      const payload = collectDiag(reason)
      const active = effectiveId()
      if (active !== null) {
        payload.imageProbe = await probeImage(apiUrl(`/img?id=${encodeURIComponent(active)}`), 6000)
      }
      return await request('/diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
    } catch (error) {
      // 自动回报是尽力而为：失败只写控制台，不打扰用户
      if (options && options.quiet === true) {
        try {
          console.debug('[dsh-bg-switcher] diag failed:', error.message)
        } catch {
          /* 忽略 */
        }
        return null
      }
      notify(`诊断回报失败：${error.message}`, 'error')
      return null
    }
  }

  function boot() {
    if (document.body === null) {
      requestAnimationFrame(boot)
      return
    }
    const scrimFixed = ensureScrimVisible(false)
    mountStyle()
    applyBackground()
    if (!buildUi()) {
      requestAnimationFrame(boot)
      return
    }
    syncControls()
    watchTheme()
    syncRotation()
    document.addEventListener('visibilitychange', () => {
      // 回到前台时如果早就过期，rotateTick 会立刻换一张；这里只刷新倒计时显示
      renderRotateCountdown()
    })
    window.__dshBgSwitcher = Object.assign(window.__dshBgSwitcher, {
      ready: true,
      version: '0.2.1',
      open: () => setOpen(true),
      close: () => setOpen(false),
      toggle: () => setOpen(!state.open),
      apply: (id) => pick(id),
      random: () => randomPick(),
      clear: () => clearPick(),
      rotateNow: () => advanceRotation(),
      rotateInfo: () => ({
        on: state.settings.rotateOn === true,
        minutes: rotateMinutes(),
        order: state.settings.rotateOrder,
        armed: rotateTimer !== null,
        nextIn: rotateNextAt === 0 ? null : Math.max(0, Math.round((rotateNextAt - Date.now()) / 1000))
      }),
      stageInfo: () => ({
        slides: stage === null ? 0 : stage.slides.length,
        index: stage === null ? -1 : stage.index,
        transform: stage === null ? '' : stage.root.style.transform,
        currentId
      }),
      reload: () => reload(),
      diagnose: (reason) => diagnose(reason || 'api'),
      setApiBase: (value) => {
        apiBase = typeof value === 'string' ? value.replace(/\/+$/, '') : ''
        apiNote = 'forced'
        applyBackground()
        renderGrid()
        return apiBase
      },
      collectDiag,
      state
    })
    if (scrimFixed) {
      // 用户看不到壁纸往往就是遮罩拉满了：纠偏一次、落盘、说清楚
      ensureScrimVisible(true)
      save()
    }
    void reload().then(() => {
      if (!diagSent) {
        diagSent = true
        void diagnose('boot', { quiet: true })
      }
    })
  }

  if (document.readyState === 'loading' && document.body === null) {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})()
