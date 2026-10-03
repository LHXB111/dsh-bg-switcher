/**
 * 极简 DOM 替身：只覆盖 lib/widget.js 真正用到的 API（createElement / querySelector /
 * dataset / style.setProperty / addEventListener / fetch / localStorage / MutationObserver）。
 * 目的是把浏览器半区真正跑起来做冒烟测试，而不是断言 CSS。
 */
import vm from 'node:vm'

class Style {
  constructor() {
    this.props = new Map()
  }
  setProperty(name, value) {
    this.props.set(name, String(value))
  }
  removeProperty(name) {
    this.props.delete(name)
  }
  getPropertyValue(name) {
    return this.props.has(name) ? this.props.get(name) : ''
  }
  get cssText() {
    return [...this.props.entries()].map(([key, value]) => `${key}:${value}`).join(';')
  }
}

class Node {
  constructor(nodeType, tagName) {
    this.nodeType = nodeType
    this.tagName = tagName
    this.nodeName = tagName
    this.childNodes = []
    this.parentNode = null
    this.listeners = new Map()
    this._text = ''
  }
  get children() {
    return this.childNodes.filter((child) => child.nodeType === 1)
  }
  get attributes() {
    if (this.attrs === undefined) return []
    return [...this.attrs.entries()].map(([name, value]) => ({ name, value }))
  }
  get firstChild() {
    return this.childNodes[0] || null
  }
  get isConnected() {
    let node = this
    while (node.parentNode !== null) node = node.parentNode
    return node.nodeType === 9 || node === globalThis.window
  }
  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof Node ? node : new TextNode(String(node))
      if (child.parentNode !== null) child.parentNode.removeChild(child)
      child.parentNode = this
      this.childNodes.push(child)
    }
  }
  appendChild(node) {
    this.append(node)
    return node
  }
  insertBefore(node, reference) {
    const child = node instanceof Node ? node : new TextNode(String(node))
    if (reference === null || reference === undefined) {
      this.append(child)
      return child
    }
    const at = this.childNodes.indexOf(reference)
    if (at < 0) {
      this.append(child)
      return child
    }
    if (child.parentNode !== null) child.parentNode.removeChild(child)
    child.parentNode = this
    this.childNodes.splice(at, 0, child)
    return child
  }
  removeChild(node) {
    const at = this.childNodes.indexOf(node)
    if (at >= 0) this.childNodes.splice(at, 1)
    node.parentNode = null
    return node
  }
  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
  }
  get textContent() {
    if (this.nodeType === 3) return this._text
    return this.childNodes.map((child) => child.textContent).join('')
  }
  set textContent(value) {
    if (this.nodeType === 3) {
      this._text = String(value)
      return
    }
    this.childNodes = []
    if (value !== '' && value !== null && value !== undefined) this.append(new TextNode(String(value)))
  }
  get innerHTML() {
    return this._html || this.textContent
  }
  set innerHTML(value) {
    this._html = String(value)
    this.childNodes = []
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value))
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }
  hasAttribute(name) {
    return this.attrs.has(name)
  }
  removeAttribute(name) {
    this.attrs.delete(name)
  }
  toggleAttribute(name, force) {
    const on = force === undefined ? !this.attrs.has(name) : Boolean(force)
    if (on) this.setAttribute(name, '')
    else this.removeAttribute(name)
    return on
  }
  addEventListener(type, listener) {
    const set = this.listeners.get(type) || new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type, listener) {
    const set = this.listeners.get(type)
    if (set) set.delete(listener)
  }
  dispatch(type, event = {}) {
    const payload = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event }
    for (const listener of this.listeners.get(type) || []) listener(payload)
    return payload
  }
  click() {
    this.dispatch('click')
  }
  focus() {}
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  matchesCompound(compound) {
    const tokens = compound.match(/\[[^\]]*\]|[#.]?[A-Za-z0-9_\u00a0-\uffff-]+/g) || []
    return tokens.every((token) => {
      if (token.startsWith('[')) {
        const match = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(token)
        if (match === null) return false
        if (!this.attrs.has(match[1])) return false
        return match[2] === undefined || this.attrs.get(match[1]) === match[2]
      }
      if (token.startsWith('.')) return String(this.className || '').split(/\s+/).includes(token.slice(1))
      if (token.startsWith('#')) return this.attrs.get('id') === token.slice(1)
      return this.tagName === token.toUpperCase()
    })
  }
  matches(selector) {
    const parts = String(selector).trim().split(/\s+/)
    if (!this.matchesCompound(parts[parts.length - 1])) return false
    let node = this.parentNode
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      let found = null
      while (node !== null && node.nodeType === 1) {
        if (node.matchesCompound(parts[index])) {
          found = node
          break
        }
        node = node.parentNode
      }
      if (found === null) return false
      node = found.parentNode
    }
    return true
  }
  querySelectorAll(selector) {
    const found = []
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue
        if (child.matches(selector)) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null
  }
}

class TextNode extends Node {
  constructor(text) {
    super(3, '#text')
    this._text = String(text)
  }
}

const dataAttrName = (key) => 'data-' + String(key).replace(/[A-Z]/g, (char) => '-' + char.toLowerCase())

class HTMLElement extends Node {
  constructor(tagName) {
    super(1, String(tagName).toUpperCase())
    this.attrs = new Map()
    // dataset 必须是"活"的：dataset.foo = 'x' 等价于 setAttribute('data-foo','x')
    const attrs = this.attrs
    this.dataset = new Proxy({}, {
      get: (_target, key) => (typeof key === 'string' ? attrs.get(dataAttrName(key)) : undefined),
      set: (_target, key, value) => {
        attrs.set(dataAttrName(key), String(value))
        return true
      },
      has: (_target, key) => typeof key === 'string' && attrs.has(dataAttrName(key)),
      deleteProperty: (_target, key) => {
        attrs.delete(dataAttrName(key))
        return true
      },
      ownKeys: () => [...attrs.keys()].filter((name) => name.startsWith('data-')).map((name) => name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase()))
    })
    this.style = new Style()
    this.className = ''
    this.value = ''
    this.checked = false
    this.files = null
  }
}

class Document extends Node {
  constructor() {
    super(9, '#document')
    this.readyState = 'complete'
    this.hidden = false
    this.activeElement = null
    this.documentElement = new HTMLElement('html')
    this.head = new HTMLElement('head')
    this.body = new HTMLElement('body')
    this.documentElement.append(this.head, this.body)
    this.append(this.documentElement)
  }
  createElement(tagName) {
    return new HTMLElement(tagName)
  }
  createTextNode(text) {
    return new TextNode(text)
  }
  getElementById(id) {
    return this.querySelector('#' + id)
  }
  elementFromPoint() {
    // 探针只需要一个"最上层元素"，桩里返回 body 即可
    return this.body
  }
}

class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    MutationObserverStub.instances.add(this)
  }
  observe(target) {
    this.targets.push(target)
  }
  disconnect() {
    MutationObserverStub.instances.delete(this)
  }
  takeRecords() {
    return []
  }
  static instances = new Set()
  /** 手动触发所有观察者（模拟属性变化后的回调）。 */
  static fire() {
    for (const observer of MutationObserverStub.instances) observer.callback([], observer)
  }
  static reset() {
    MutationObserverStub.instances.clear()
  }
}

/**
 * 造一个沙箱并跑一段浏览器脚本。
 * @param {string} code 脚本源码
 * @param {{routes?: Record<string, (body:any, url:URL)=>any>}} [options] fetch 伪实现
 */
export function runInDom(code, options = {}) {
  const document = new Document()
  const requests = []
  const routes = options.routes || {}

  const fetchStub = async (input, init = {}) => {
    const url = new URL(String(input), 'http://127.0.0.1:52535')
    const method = (init.method || 'GET').toUpperCase()
    const body = typeof init.body === 'string' && init.body !== '' ? JSON.parse(init.body) : null
    requests.push({ raw: String(input), url: url.pathname + url.search, method, body })
    const handler = routes[url.pathname] || routes['*']
    if (handler === undefined) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ ok: false, message: 'not found' }) }
    }
    const payload = await handler(body, url, method, String(input))
    const status = payload && payload.__status ? payload.__status : 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload)
    }
  }

  // 定时器桩：记录下来但不真的跑，测试里手动触发（widget 只用它驱动轮播心跳）
  const intervals = []
  const store = new Map()
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  }

  const sandbox = {
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms })
      return intervals.length
    },
    clearInterval: () => {},
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    RegExp,
    Map,
    Set,
    URL,
    URLSearchParams,
    fetch: fetchStub,
    localStorage,
    MutationObserver: MutationObserverStub,
    Node,
    HTMLElement,
    Text: TextNode,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    FileReader: class {
      readAsDataURL() {
        this.onerror && this.onerror(new Error('not supported in stub'))
      }
    }
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  sandbox.innerWidth = 1440
  sandbox.innerHeight = 900
  sandbox.location = options.location || {
    href: 'http://127.0.0.1:52535/',
    origin: 'http://127.0.0.1:52535',
    protocol: 'http:',
    host: '127.0.0.1:52535'
  }
  // getComputedStyle：只需要返回朴素的样式对象，能读到内联自定义属性即可
  // window 级事件（视差挂在 window 上）：记录下来，测试可以手动触发
  const windowListeners = new Map()
  sandbox.addEventListener = (type, listener) => {
    const set = windowListeners.get(type) || new Set()
    set.add(listener)
    windowListeners.set(type, set)
  }
  sandbox.removeEventListener = (type, listener) => {
    const set = windowListeners.get(type)
    if (set) set.delete(listener)
  }
  sandbox.dispatchWindow = (type, event) => {
    for (const listener of windowListeners.get(type) || []) listener(event || {})
  }
  sandbox.matchMedia = () => ({ matches: options.reducedMotion === true })
  sandbox.getComputedStyle = (node) => {
    const style = node && node.style ? node.style : { getPropertyValue: () => '' }
    return {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      backgroundImage: 'none',
      backgroundSize: 'auto',
      backgroundAttachment: 'scroll',
      opacity: '1',
      zIndex: 'auto',
      position: 'static',
      filter: 'none',
      backdropFilter: 'none',
      getPropertyValue: (name) => style.getPropertyValue(name)
    }
  }
  sandbox.Image = class {
    constructor() {
      this.onload = null
      this.onerror = null
      this.naturalWidth = 0
      this.naturalHeight = 0
      this.complete = false
      this._src = ''
    }
    get src() {
      return this._src
    }
    set src(value) {
      this._src = String(value)
      // 桩：一律"加载成功"，10x10，异步回调（贴近浏览器时序）
      setTimeout(() => {
        this.complete = true
        this.naturalWidth = 10
        this.naturalHeight = 10
        if (typeof this.onload === 'function') this.onload()
      }, 0)
    }
  }

  return {
    sandbox,
    document,
    requests,
    store,
    intervals,
    windowListeners,
    run: () => vm.runInNewContext(code, sandbox, { filename: 'widget.js' })
  }
}

export { Document, HTMLElement, MutationObserverStub, Node }
