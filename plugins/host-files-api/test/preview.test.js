import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { test } from 'node:test'

import { findEntries } from '../lib/preview.js'
import { isTrustedRequest } from '../lib/trust.js'

function fakeCtx (roots) {
  return {
    workspaceRegistry: { list: () => roots.map((path, i) => ({ id: `w${i}`, path, title: 'w' })) },
    fs: {
      async resolve (path) { return { path } },
      async listDir (target) {
        const { readdir } = await import('node:fs/promises')
        const entries = await readdir(target.path, { withFileTypes: true })
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? 'directory' : 'file' }))
      },
    },
  }
}

async function scratch () { return realpath(await mkdtemp(join(tmpdir(), 'dshd-prev-'))) }

test('finds index.html and ranks it first, deeper pages after', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'about.html'), '<h1>about</h1>')
  await writeFile(join(root, 'index.html'), '<h1>home</h1>')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'page.html'), '<h1>deep</h1>')

  const mine = (await findEntries(fakeCtx([root]))).filter((e) => e.path.startsWith(root))
  // index.html outranks every other page under this root.
  assert.equal(mine[0].name, 'index.html')
  assert.deepEqual(mine.map((e) => e.rel).sort(), ['about.html', 'index.html', 'sub/page.html'])
  // rel is workspace-relative, so the preview URL resolves assets naturally.
  assert.equal(mine.find((e) => e.name === 'index.html').rel, 'index.html')
})

test('skips node_modules and dotdirs', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'pkg', 'readme.html'), 'x')
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'hooks.html'), 'x')
  await writeFile(join(root, 'index.html'), 'ok')

  const mine = (await findEntries(fakeCtx([root]))).filter((e) => e.path.startsWith(root))
  assert.deepEqual(mine.map((e) => e.name), ['index.html'])
})

test('package source HTML is marked as requiring a dev server', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), '{"scripts":{"dev":"vite"}}')
  await writeFile(join(root, 'index.html'), '<div id="root"></div>')
  const entries = await findEntries(fakeCtx([root]))
  assert.equal(entries[0].needsServer, true)
})

test('a scoped scan sees one workspace, not every folder the app has open', async (t) => {
  const mine = await scratch()
  const other = await scratch()
  t.after(() => rm(mine, { recursive: true, force: true }))
  t.after(() => rm(other, { recursive: true, force: true }))
  await writeFile(join(mine, 'index.html'), '<h1>mine</h1>')
  await writeFile(join(other, 'index.html'), '<h1>someone else</h1>')

  const ctx = fakeCtx([mine, other])
  // Unscoped is the standalone pane: both workspaces are fair game.
  const everything = await findEntries(ctx)
  assert.ok(everything.some((e) => e.path.startsWith(mine)))
  assert.ok(everything.some((e) => e.path.startsWith(other)))

  // Scoped is a conversation, which is bound to exactly one folder. Offering
  // the other workspace's page here is what made Preview feel broken in chat.
  const scoped = await findEntries(ctx, 25, mine)
  assert.ok(scoped.length > 0)
  assert.ok(scoped.every((e) => e.path.startsWith(mine)))
})

test('the trust fence rejects a non-loopback Host', () => {
  assert.equal(isTrustedRequest({ headers: { host: 'evil.com' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:5051' } }), true)
})

test('the trust fence rejects a cross-site fetch and a foreign Origin', () => {
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:1', origin: 'http://evil.com' } }), false)
  // same-origin and a missing origin (media/navigation) are both fine.
  assert.equal(isTrustedRequest({ headers: { host: 'localhost:1', 'sec-fetch-site': 'same-origin' } }), true)
  assert.equal(isTrustedRequest({ headers: { host: 'localhost:1' } }), true)
})

// --- Regression: the malformed-percent host crash (review finding #1) ---
import { startPreviewServer } from '../lib/preview.js'
import { once } from 'node:events'

test('a malformed percent-escape in the path is a 400, not a host crash', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'index.html'), 'ok')

  const { server, port } = await startPreviewServer(fakeCtx([root]))
  assert.ok(port, 'preview server should bind')
  t.after(() => server.close())

  // %c0%af is a valid-syntax, invalid-UTF-8 triple: decodeURIComponent throws
  // on it, and a browser passes it through unchanged. Before the fix this
  // became an unhandled rejection and killed the process.
  const res = await fetch(`http://127.0.0.1:${port}/%c0%af`)
  assert.equal(res.status, 400)

  // And the server is still alive and serving afterwards.
  const ok = await fetch(`http://127.0.0.1:${port}/index.html`)
  assert.equal(ok.status, 200)
  assert.equal((await ok.text()).trim(), 'ok')
})

test('an abort during serving does not throw', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'index.html'), 'x'.repeat(4096))

  const { server, port } = await startPreviewServer(fakeCtx([root]))
  t.after(() => server.close())

  const controller = new AbortController()
  const pending = fetch(`http://127.0.0.1:${port}/index.html`, { signal: controller.signal })
  controller.abort()
  await pending.catch(() => {})
  // Server survives the abort and still answers.
  const ok = await fetch(`http://127.0.0.1:${port}/index.html`)
  assert.equal(ok.status, 200)
})

test('the preview server serves index.html for the root and for directories', async (t) => {
  const { startPreviewServer } = await import('../lib/preview.js')
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'index.html'), '<h1>root page</h1>')
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'index.html'), '<h1>docs page</h1>')
  await writeFile(join(root, 'plain.txt'), 'not html')

  const { server, port } = await startPreviewServer(fakeCtx([root]))
  assert.ok(server, 'server started')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`)
    return { status: res.status, body: await res.text(), type: res.headers.get('content-type') || '' }
  }

  // "/" is the URL people type and share; it must be the root index, not a 404.
  const rootRes = await get('/')
  assert.equal(rootRes.status, 200)
  assert.match(rootRes.body, /root page/)
  assert.match(rootRes.type, /text\/html/)

  // A directory path falls back to ITS index.
  const docs = await get('/docs/')
  assert.equal(docs.status, 200)
  assert.match(docs.body, /docs page/)

  // Plain files and misses keep their existing behavior.
  assert.equal((await get('/plain.txt')).status, 200)
  assert.equal((await get('/nope.html')).status, 404)
})

test('the preview server root 404s only when no index.html exists', async (t) => {
  const { startPreviewServer } = await import('../lib/preview.js')
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'about.html'), '<h1>about</h1>')

  const { server, port } = await startPreviewServer(fakeCtx([root]))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404)
  assert.equal((await fetch(`http://127.0.0.1:${port}/about.html`)).status, 200)
})

test('a selected HTML folder owns root-relative assets and cannot mix open workspaces', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = join(root, 'first'), second = join(root, 'second'), nested = join(second, 'site')
  await mkdir(join(first, 'assets'), { recursive: true })
  await mkdir(join(nested, 'assets'), { recursive: true })
  await writeFile(join(first, 'index.html'), 'wrong project')
  await writeFile(join(first, 'assets', 'style.css'), 'wrong stylesheet')
  await writeFile(join(nested, 'index.html'), '<link rel="stylesheet" href="/assets/style.css">correct project')
  await writeFile(join(nested, 'assets', 'style.css'), 'correct stylesheet')
  await writeFile(join(second, 'outside.txt'), 'outside the selected preview folder')
  const { symlink } = await import('node:fs/promises')
  await symlink(join(second, 'outside.txt'), join(nested, 'escape.txt'))
  const { server, port } = await startPreviewServer(fakeCtx([first, second]), nested)
  assert.ok(port)
  t.after(() => server.close())
  const base = `http://127.0.0.1:${port}`
  assert.match(await (await fetch(base + '/')).text(), /correct project/)
  assert.equal(await (await fetch(base + '/assets/style.css')).text(), 'correct stylesheet')
  assert.equal((await fetch(base + '/escape.txt')).status, 404)
})
