/**
 * 测试脚手架：一个最小可用的 cordis ctx / node:http req-res 替身。
 * 只在 test/ 下使用，不随插件发布。
 */
import { EventEmitter } from 'node:events'

/** 收集路由 / 注入行 / effect 的假 root ctx。 */
export function fakeRoot({ connection } = {}) {
  const listeners = new Map()
  const routes = new Map()
  const taps = []
  const cleanups = []

  const webServer = {
    port: 52535,
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    tapIndex(transform) {
      taps.push(transform)
      return () => {
        const at = taps.indexOf(transform)
        if (at >= 0) taps.splice(at, 1)
      }
    }
  }

  const serviceCtx = {
    webServer,
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'connection') return connection
      if (name === 'webServer') return webServer
      return undefined
    }
  }

  const root = {
    on(event, listener) {
      const set = listeners.get(event) || new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    inject(names, callback) {
      if (names.includes('webServer')) callback(serviceCtx)
    },
    effect(callback) {
      cleanups.push(callback)
    }
  }

  return {
    root,
    routes,
    taps,
    serviceCtx,
    emit(event, payload) {
      for (const listener of listeners.get(event) || []) listener(payload)
    },
    disposeAll() {
      for (const cleanup of cleanups) {
        const disposer = cleanup()
        if (typeof disposer === 'function') disposer()
      }
    }
  }
}

/** 假 IncomingMessage：够 readJsonBody / fence 用。 */
export function makeReq({ method = 'GET', url = '/', headers = {}, body = null, remoteAddress = '127.0.0.1' } = {}) {
  const emitter = new EventEmitter()
  emitter.method = method
  emitter.url = url
  emitter.headers = { host: '127.0.0.1:52535', ...headers }
  emitter.socket = { remoteAddress }
  emitter.destroy = () => {}
  queueMicrotask(() => {
    if (body !== null && body !== undefined) emitter.emit('data', Buffer.from(body, 'utf8'))
    emitter.emit('end')
  })
  return emitter
}

/** 假 ServerResponse：记录状态码、响应头、响应体。 */
export function makeRes() {
  const res = {
    status: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers || {}
      res.headersSent = true
      return res
    },
    setHeader(name, value) {
      res.headers = { ...(res.headers || {}), [name]: value }
    },
    getHeader(name) {
      return (res.headers || {})[name]
    },
    end(chunk) {
      res.body = chunk === undefined ? Buffer.alloc(0) : Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      return res
    },
    destroy() {},
    json() {
      return res.body === null ? null : JSON.parse(res.body.toString('utf8'))
    }
  }
  return res
}

/** 调一次路由并等 handler 的 Promise 落定。 */
export async function callRoute(routes, path, options = {}) {
  const route = routes.get(path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const req = makeReq(options)
  const res = makeRes()
  await route.handler(req, res)
  await new Promise((resolve) => setImmediate(resolve))
  return res
}
