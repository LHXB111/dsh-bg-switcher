/** Browser regression fixture for the Windows frame/sidebar background stack.
 * Run this server, then open the printed URL and follow each fixture link.
 * The v0.2.0 baseline must fail with the sidebar/frame still tinted.
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.argv[2] || 8765)
const results = []
const resultPath = process.argv[3] || join(tmpdir(), 'dsh-windows-shell-results.json')

function css(revision) {
  const source = revision === 'baseline'
    ? execFileSync('git', ['show', 'v0.2.0:lib/widget.js'], { cwd: root, encoding: 'utf8' })
    : readFileSync(join(root, 'lib/widget.js'), 'utf8')
  const match = /function styleText\(\)\s*\{\s*return `([\s\S]*?)`\s*\}/.exec(source)
  if (!match) throw new Error('Unable to read the widget stylesheet')
  return match[1]
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    if (url.pathname === '/result' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 16_384) throw new Error('Result is too large')
      }
      const result = JSON.parse(body)
      results.push(result)
      writeFileSync(resultPath, JSON.stringify(results, null, 2) + '\n')
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.revision} dark=${result.dark} immersive=${result.immersive} dim=${result.dim}`)
      res.writeHead(204).end()
      return
    }
    if (url.pathname === '/plugin.css') {
      res.writeHead(200, {'Content-Type':'text/css', 'Cache-Control':'no-store'}).end(css(url.searchParams.get('revision')))
      return
    }
    const path = url.pathname === '/' ? join(root, 'test/windows-shell.html') : resolve(root, '.' + decodeURIComponent(url.pathname))
    if (!path.startsWith(root + '/')) {
      res.writeHead(403).end()
      return
    }
    const types = {'.html':'text/html; charset=utf-8','.jpg':'image/jpeg','.png':'image/png'}
    const bytes = readFileSync(path)
    res.writeHead(200, {'Content-Type':types[extname(path)] || 'application/octet-stream', 'Cache-Control':'no-store'}).end(bytes)
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500, {'Content-Type':'text/plain'}).end(String(error.message))
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Open http://127.0.0.1:${port}/ — results: ${resultPath}`)
})
