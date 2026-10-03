/**
 * 宿主半区测试：node --test test/server.test.mjs
 * 用 DSH_HOME 指向临时目录，绝不碰真实 profile。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { callRoute, fakeRoot } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const home = mkdtempSync(join(tmpdir(), 'dsh-bg-test-'))

process.env.DSH_HOME = home
process.env.DSH_DESKTOP_PROFILE = 'web'
// 宿主（真 harness）会给子进程塞 DSH_PROFILE_DIR / DSH_PROFILE：测试里必须清掉，
// 否则插件会指向真实 profile，测试结果取决于用户当前状态。
delete process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE
delete process.env.DSHW_TRUSTED_HOSTS
delete process.env.DSH_TRUSTED_HOSTS

const plugin = await import('../lib/index.js')
const dataDir = join(home, 'profiles', 'web', 'data', 'dsh-bg-switcher')
const galleryDir = join(dataDir, 'backgrounds')
const settingsFile = join(dataDir, 'settings.json')

const harness = fakeRoot()
plugin.apply(harness.root)

after(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 直接改盘上的 settings.json（模拟"上次会话留下的选择"）。 */
function seedSettings(patch) {
  const current = (() => {
    try {
      return JSON.parse(readFileSync(settingsFile, 'utf8'))
    } catch {
      return {}
    }
  })()
  writeFileSync(settingsFile, JSON.stringify({ ...current, ...patch }), 'utf8')
}

describe('插件外形', () => {
  it('导出 name / apply，并注册全部路由', () => {
    assert.equal(plugin.name, 'dsh-bg-switcher')
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(typeof plugin.default.apply, 'function')
    assert.deepEqual([...harness.routes.keys()].sort(), [
      '/dsh-bg/add-path',
      '/dsh-bg/delete',
      '/dsh-bg/diag',
      '/dsh-bg/img',
      '/dsh-bg/list',
      '/dsh-bg/reveal',
      '/dsh-bg/settings',
      '/dsh-bg/thumb',
      '/dsh-bg/upload',
      '/dsh-bg/widget.js'
    ])
  })

  it('注入行在服务就绪后带上宿主绝对地址 __DSH_BG_API__', () => {
    const table = []
    harness.emit('webserver/index-inject', table)
    assert.match(table[0].text, /__DSH_BG_API__="http:\/\/127\.0\.0\.1:\d+"/)
  })

  it('注入行是内联 script 行，内嵌设置快照且可去重', () => {
    const table = []
    harness.emit('webserver/index-inject', table)
    assert.equal(table.length, 1)
    assert.equal(table[0].kind, 'script')
    assert.equal(table[0].placement, 'body')
    assert.match(table[0].text, /\/dsh-bg\/widget\.js/)
    assert.match(table[0].text, /__DSH_BG_INITIAL__/)
    assert.match(table[0].text, /onerror/) // 路由不在时静默失败，绝不 reject 掉 boot
    harness.emit('webserver/index-inject', table)
    assert.equal(table.length, 1)
  })

  it('tapIndex 补一记 <script defer>，对已含标记的 html 不重复插入', () => {
    assert.equal(harness.taps.length, 1)
    const out = harness.taps[0]('<html><body><div id="root"></div></body></html>')
    assert.match(out, /<script defer src="\/dsh-bg\/widget\.js"><\/script><\/body>/)
    assert.equal(harness.taps[0](out), out)
  })
})

describe('图库', () => {
  it('内置图两张，尺寸解析正确', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/list')
    assert.equal(res.status, 200)
    const payload = res.json()
    assert.equal(payload.ok, true)
    const builtin = payload.items.filter((item) => item.source === 'builtin')
    assert.equal(builtin.length, 2)
    const classroom = builtin.find((item) => item.id === 'builtin:教室自习.jpg')
    assert.equal(classroom.width, 1072)
    assert.equal(classroom.height, 758)
    assert.equal(classroom.name, '教室自习')
    const corridor = builtin.find((item) => item.id === 'builtin:校舍走廊.png')
    assert.equal(corridor.width, 1735)
    assert.equal(corridor.height, 1227)
    assert.equal(payload.settings.activeId, null)
    assert.equal(payload.settings.dim, 45)
    assert.equal(payload.dirs.user, galleryDir)
  })

  it('按 id 返回原始字节与 MIME', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/img', {
      url: '/dsh-bg/img?id=' + encodeURIComponent('builtin:教室自习.jpg')
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['Content-Type'], 'image/jpeg')
    const onDisk = readFileSync(join(packageRoot, 'assets/backgrounds/教室自习.jpg'))
    assert.ok(res.body.equals(onDisk))
  })

  it('拒绝越界 / 非法 id', async () => {
    const bad = [
      '../../etc/passwd',
      'builtin:../../../etc/passwd',
      'user:..%2F..%2Fx.jpg',
      'builtin:',
      'nope:x.jpg',
      '/etc/passwd',
      'builtin:../../package.json',
      'builtin:missing.jpg'
    ]
    for (const id of bad) {
      const res = await callRoute(harness.routes, '/dsh-bg/img', { url: '/dsh-bg/img?id=' + encodeURIComponent(id) })
      assert.equal(res.status, 404, `应拒绝 ${id}`)
    }
  })

  it('缩略图走 sips（macOS）并明显小于原图', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/thumb', {
      url: '/dsh-bg/thumb?id=' + encodeURIComponent('builtin:校舍走廊.png')
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers['Content-Type'], 'image/jpeg')
    const original = statSync(join(packageRoot, 'assets/backgrounds/校舍走廊.png')).size
    assert.ok(res.body.length > 0 && res.body.length < original, '缩略图应小于原图')
  })

  it('widget.js 可下载且含全局标记', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/widget.js')
    assert.equal(res.status, 200)
    assert.match(res.headers['Content-Type'], /javascript/)
    assert.match(res.body.toString('utf8'), /__dshBgSwitcher/)
  })
})

describe('缩略图引擎（跨平台兜底）', () => {
  const thumbUrl = (id) => '/dsh-bg/thumb?id=' + encodeURIComponent(id)

  it('DSH_BG_THUMB_ENGINE=none 时不生成缩略图，/thumb 回原图', async () => {
    process.env.DSH_BG_THUMB_ENGINE = 'none'
    try {
      const list = await callRoute(harness.routes, '/dsh-bg/list')
      assert.equal(list.json().thumbnails, false, '要如实告诉前端没有缩略图引擎')

      const res = await callRoute(harness.routes, '/dsh-bg/thumb', { url: thumbUrl('builtin:教室自习.jpg') })
      assert.equal(res.status, 200)
      assert.equal(res.headers['Content-Type'], 'image/jpeg')
      const onDisk = readFileSync(join(packageRoot, 'assets/backgrounds/教室自习.jpg'))
      assert.ok(res.body.equals(onDisk), '应该与磁盘上的原图逐字节一致')
    } finally {
      delete process.env.DSH_BG_THUMB_ENGINE
    }
  })

  it('引擎跑不动时（坏图）也回原图，不报错', async () => {
    mkdirSync(galleryDir, { recursive: true })
    const broken = join(galleryDir, 'broken.jpg')
    writeFileSync(broken, Buffer.from('this is not an image at all'), 'utf8')
    try {
      const res = await callRoute(harness.routes, '/dsh-bg/thumb', { url: thumbUrl('user:broken.jpg') })
      assert.equal(res.status, 200)
      assert.equal(res.body.toString('utf8'), 'this is not an image at all')
    } finally {
      rmSync(broken, { force: true })
    }
  })

  it('强制指定 sips 引擎仍能出图（macOS 上）', async () => {
    process.env.DSH_BG_THUMB_ENGINE = 'sips'
    try {
      const res = await callRoute(harness.routes, '/dsh-bg/thumb', { url: thumbUrl('builtin:教室自习.jpg') })
      assert.equal(res.status, 200)
      if (process.platform === 'darwin') {
        assert.equal(res.headers['Content-Type'], 'image/jpeg')
        assert.ok(res.body.length < 130526, '缩略图应小于原图')
      }
    } finally {
      delete process.env.DSH_BG_THUMB_ENGINE
    }
  })
})

describe('设置持久化', () => {
  it('PUT 写入并做范围 / 白名单清洗', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          activeId: 'builtin:教室自习.jpg',
          mode: 'contain',
          dim: 9999,
          blur: -5,
          split: true,
          immersive: false,
          hidden: true,
          btnX: 12.7,
          btnY: -88000,
          evil: 'drop table',
          lightId: '../../etc/passwd'
        }
      })
    })
    assert.equal(res.status, 200)
    const { settings } = res.json()
    assert.equal(settings.activeId, 'builtin:教室自习.jpg')
    assert.equal(settings.mode, 'contain')
    assert.equal(settings.dim, 100)
    assert.equal(settings.blur, 0)
    assert.equal(settings.split, true)
    assert.equal(settings.immersive, false)
    assert.equal(settings.hidden, true)
    assert.equal(settings.btnX, 13)
    assert.equal(settings.btnY, -8000)
    assert.equal(settings.evil, undefined)
    assert.equal(settings.lightId, null)
    assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).dim, 100)
  })

  it('GET 返回默认值合并后的完整设置', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings')
    const { settings } = res.json()
    assert.deepEqual(Object.keys(settings).sort(), [
      'activeId',
      'blur',
      'btnX',
      'btnY',
      'darkId',
      'dim',
      'hidden',
      'immersive',
      'lightId',
      'mode',
      'parallax',
      'rotateMinutes',
      'rotateOn',
      'rotateOrder',
      'split'
    ])
    assert.equal(settings.rotateOn, false, '轮播默认关')
    assert.equal(settings.rotateMinutes, 30)
    assert.equal(settings.rotateOrder, 'random')
    assert.equal(settings.parallax, true)
  })

  it('坏 JSON 返回 400，且不覆盖已存设置', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings', { method: 'PUT', body: '{oops' })
    assert.equal(res.status, 400)
    assert.equal(res.json().ok, false)
    assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).activeId, 'builtin:教室自习.jpg')
  })

  it('设置文件损坏时回落默认值', async () => {
    const backup = readFileSync(settingsFile, 'utf8')
    writeFileSync(settingsFile, 'not json at all', 'utf8')
    const res = await callRoute(harness.routes, '/dsh-bg/settings')
    assert.equal(res.json().settings.activeId, null)
    writeFileSync(settingsFile, backup, 'utf8')
    for (const name of readdirSync(dataDir).filter((entry) => entry.startsWith('settings.json.bad-'))) {
      rmSync(join(dataDir, name), { force: true })
    }
  })
})

describe('轮播 / 视差设置清洗', () => {
  it('PUT 写入轮播与视差，并做区间/枚举校验', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings', {
      method: 'PUT',
      body: JSON.stringify({
        settings: { rotateOn: true, rotateMinutes: 9999, rotateOrder: 'inOrder', parallax: false, junk: 1 }
      })
    })
    assert.equal(res.status, 200)
    const { settings } = res.json()
    assert.equal(settings.rotateOn, true)
    assert.equal(settings.rotateMinutes, 720, '间隔上限 720 分钟')
    assert.equal(settings.rotateOrder, 'inOrder')
    assert.equal(settings.parallax, false)
    assert.equal(settings.junk, undefined)
    assert.equal(readFileSync(settingsFile, 'utf8').includes('"rotateMinutes": 720'), true)
  })

  it('非法枚举与下界同样被夹住', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: { rotateMinutes: 0, rotateOrder: 'sideways' } })
    })
    const { settings } = res.json()
    assert.equal(settings.rotateMinutes, 1, '间隔下限 1 分钟')
    assert.equal(settings.rotateOrder, 'inOrder', '非法枚举保持上一次的值')
  })

  it('把轮播关回去', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings', {
      method: 'PUT',
      body: JSON.stringify({ settings: { rotateOn: false, parallax: true } })
    })
    const { settings } = res.json()
    assert.equal(settings.rotateOn, false)
    assert.equal(settings.parallax, true)
  })
})

describe('图库增删', () => {
  const tinyPng =
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  let uploadedId = null

  it('上传 dataURL → 入库（含中文名与空格）', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/upload', {
      method: 'POST',
      body: JSON.stringify({ name: '我的 壁纸', dataUrl: tinyPng })
    })
    assert.equal(res.status, 200)
    const payload = res.json()
    uploadedId = payload.item.id
    assert.equal(uploadedId, 'user:我的 壁纸.png')
    assert.equal(payload.item.width, 1)
    assert.equal(payload.item.height, 1)
    assert.equal(payload.items.filter((item) => item.source === 'user').length, 1)
  })

  it('重名自动加序号', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/upload', {
      method: 'POST',
      body: JSON.stringify({ name: '我的 壁纸', dataUrl: tinyPng })
    })
    assert.equal(res.json().item.id, 'user:我的 壁纸-1.png')
  })

  it('文件名里的路径分隔符被清洗', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/upload', {
      method: 'POST',
      body: JSON.stringify({ name: '../../etc/passwd', dataUrl: tinyPng })
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().item.id, 'user:.. .. etc passwd.png')
    assert.ok(statSync(join(galleryDir, '.. .. etc passwd.png')).isFile())
    await callRoute(harness.routes, '/dsh-bg/delete', {
      method: 'POST',
      body: JSON.stringify({ id: 'user:.. .. etc passwd.png' })
    })
  })

  it('拒绝非图片 dataURL / 缺字段 / 超限声明', async () => {
    for (const body of [
      { name: 'x', dataUrl: 'data:text/plain;base64,aGk=' },
      { name: 'x', dataUrl: 'data:image/gif;base64,' },
      { name: 'x' },
      { name: 'x', dataUrl: 'not-a-data-url' }
    ]) {
      const res = await callRoute(harness.routes, '/dsh-bg/upload', { method: 'POST', body: JSON.stringify(body) })
      assert.equal(res.status, 400, `应拒绝 ${JSON.stringify(body)}`)
      assert.equal(res.json().ok, false)
    }
  })

  it('add-path 复制本机文件进图库并解析尺寸', async () => {
    const source = join(home, 'from-disk.webp')
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
      Buffer.from('VP8 '),
      Buffer.alloc(4),
      Buffer.from([0x2f, 0x00, 0x00]),
      Buffer.from([0x9d, 0x01, 0x2a]),
      Buffer.from([16, 0]),
      Buffer.from([10, 0])
    ])
    writeFileSync(source, webp)
    const res = await callRoute(harness.routes, '/dsh-bg/add-path', {
      method: 'POST',
      body: JSON.stringify({ path: source })
    })
    assert.equal(res.status, 200)
    const payload = res.json()
    assert.equal(payload.item.id, 'user:from-disk.webp')
    assert.equal(payload.item.width, 16)
    assert.equal(payload.item.height, 10)
    assert.ok(statSync(join(galleryDir, 'from-disk.webp')).isFile())
  })

  it('add-path 支持 file:// URL', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/add-path', {
      method: 'POST',
      body: JSON.stringify({ path: 'file://' + join(packageRoot, 'assets/backgrounds/教室自习.jpg') })
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().item.id, 'user:教室自习.jpg')
  })

  it('add-path 对不存在的路径 / 非图片给出可读错误', async () => {
    const missing = await callRoute(harness.routes, '/dsh-bg/add-path', {
      method: 'POST',
      body: JSON.stringify({ path: join(home, 'nope.png') })
    })
    assert.equal(missing.status, 400)
    assert.match(missing.json().message, /路径不存在/)

    const notImage = join(home, 'note.txt')
    writeFileSync(notImage, 'hello')
    const bad = await callRoute(harness.routes, '/dsh-bg/add-path', {
      method: 'POST',
      body: JSON.stringify({ path: notImage })
    })
    assert.equal(bad.status, 400)
    assert.match(bad.json().message, /不是受支持的图片/)
  })

  it('删除用户图，并清空指向它的选区', async () => {
    seedSettings({ activeId: uploadedId })
    const res = await callRoute(harness.routes, '/dsh-bg/delete', {
      method: 'POST',
      body: JSON.stringify({ id: uploadedId })
    })
    assert.equal(res.status, 200)
    const payload = res.json()
    assert.equal(payload.items.some((item) => item.id === uploadedId), false)
    assert.equal(payload.settings.activeId, null)
  })

  it('内置图不可删除', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/delete', {
      method: 'POST',
      body: JSON.stringify({ id: 'builtin:教室自习.jpg' })
    })
    assert.equal(res.status, 400)
    assert.match(res.json().message, /内置/)
  })

  it('reveal 返回图库目录', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/reveal', { method: 'POST', body: '{}' })
    assert.equal(res.status, 200)
    assert.equal(res.json().dir, galleryDir)
  })
})

describe('设置文件损坏兜底', () => {
  it('坏 settings.json 会被挪到 .bad-* 并回落默认值', async () => {
    const backup = readFileSync(settingsFile, 'utf8')
    writeFileSync(settingsFile, '{"activeId":"builtin:x.jpg",}}', 'utf8')
    const res = await callRoute(harness.routes, '/dsh-bg/settings')
    assert.equal(res.json().settings.activeId, null)
    const leftover = readdirSync(dataDir).filter((name) => name.startsWith('settings.json.bad-'))
    assert.equal(leftover.length, 1, '坏文件应被挪走一个')
    writeFileSync(settingsFile, backup, 'utf8')
    rmSync(join(dataDir, leftover[0]), { force: true })
  })
})

describe('页面自检回执', () => {
  it('POST /dsh-bg/diag 落盘 diag.json', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/diag', {
      method: 'POST',
      body: JSON.stringify({ reason: 'boot', href: 'dsh-app://app/', widget: { ready: true } })
    })
    assert.equal(res.status, 200)
    assert.equal(res.json().ok, true)
    const saved = JSON.parse(readFileSync(join(dataDir, 'diag.json'), 'utf8'))
    assert.equal(saved.payload.reason, 'boot')
    assert.equal(saved.payload.href, 'dsh-app://app/')
    assert.match(readFileSync(join(dataDir, 'diag.log'), 'utf8'), /"reason":"boot"/)
  })

  it('坏 JSON 返回 400', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/diag', { method: 'POST', body: '{nope' })
    assert.equal(res.status, 400)
  })
})

describe('信任栅栏', () => {
  it('非回环 Host 被拒', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { host: 'evil.example.com' } })
    assert.equal(res.status, 403)
  })

  it('cross-site 请求被拒', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { 'sec-fetch-site': 'cross-site' } })
    assert.equal(res.status, 403)
  })

  it('畸形 Host 被拒', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { host: 'not a host' } })
    assert.equal(res.status, 403)
  })

  it('写接口同样受栅栏保护', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings', {
      method: 'PUT',
      headers: { host: '10.0.0.5:8080' },
      body: JSON.stringify({ settings: { dim: 10 } })
    })
    assert.equal(res.status, 403)
  })

  it('DSHW_TRUSTED_HOSTS 里声明的权威放行', async () => {
    process.env.DSHW_TRUSTED_HOSTS = '10.0.0.5:8080'
    try {
      const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { host: '10.0.0.5:8080' } })
      assert.equal(res.status, 200)
    } finally {
      delete process.env.DSHW_TRUSTED_HOSTS
    }
  })

  it('委托宿主 connection.requestRejection 的结果，并随卸载消失', async () => {
    const delegated = fakeRoot({ connection: { requestRejection: () => 401 } })
    plugin.apply(delegated.root)
    const res = await callRoute(delegated.routes, '/dsh-bg/list', { headers: { host: 'dsh.r2049.cn' } })
    assert.equal(res.status, 401)
    delegated.disposeAll()
    assert.equal(delegated.routes.size, 0)
    assert.equal(delegated.taps.length, 0)
  })
})

describe('跨源（官方桌面端 dsh-app:// 页面）', () => {
  const appOrigin = 'dsh-app://app'

  it('GET 带 CORS 头，dsh-app://app 来源被放行', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { origin: appOrigin } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['Access-Control-Allow-Origin'], appOrigin)
    assert.match(res.headers['Access-Control-Allow-Methods'], /PUT/)
  })

  it('PUT 预检返回 204 与允许头', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/settings', {
      method: 'OPTIONS',
      headers: {
        origin: appOrigin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
        'access-control-request-private-network': 'true'
      }
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers['Access-Control-Allow-Origin'], appOrigin)
    assert.equal(res.headers['Access-Control-Allow-Headers'], 'content-type')
    assert.equal(res.headers['Access-Control-Allow-Private-Network'], 'true')
  })

  it('回环 http 来源也算白名单（浏览器直开宿主页面）', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { origin: 'http://127.0.0.1:52535' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:52535')
  })

  it('陌生来源仍然 403，且不带 CORS 头', async () => {
    const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { origin: 'http://evil.example.com' } })
    assert.equal(res.status, 403)
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
  })

  it('DSH_BG_TRUSTED_ORIGINS 可以额外放行来源', async () => {
    process.env.DSH_BG_TRUSTED_ORIGINS = 'https://my-shell.example'
    try {
      const res = await callRoute(harness.routes, '/dsh-bg/list', { headers: { origin: 'https://my-shell.example' } })
      assert.equal(res.status, 200)
      assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://my-shell.example')
    } finally {
      delete process.env.DSH_BG_TRUSTED_ORIGINS
    }
  })
})

describe('注入行快照', () => {
  it('已选中背景时快照带上 id 与参数', () => {
    seedSettings({ activeId: 'builtin:校舍走廊.png', dim: 30, mode: 'contain' })
    const table = []
    harness.emit('webserver/index-inject', table)
    assert.match(table[0].text, /"activeId":"builtin:校舍走廊\.png"/)
    assert.match(table[0].text, /"dim":30/)
    assert.match(table[0].text, /"mode":"contain"/)
    assert.equal(table[0].text.includes('</script'), false)
  })

  it('没有选中背景时快照里三个槽位都是 null，脚本本身仍然注入', () => {
    seedSettings({ activeId: null, lightId: null, darkId: null })
    const table = []
    harness.emit('webserver/index-inject', table)
    assert.match(table[0].text, /__DSH_BG_INITIAL__=\{"activeId":null,"lightId":null,"darkId":null/)
    assert.match(table[0].text, /\/dsh-bg\/widget\.js/)
  })
})
