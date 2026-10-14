import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'

import { apply } from '../lib/index.js'

// Body handling, tested over a real socket with real chunk boundaries.
//
// The bug this exists for was invisible to any test that posted a body in one
// piece: `raw += chunk` decodes each Buffer independently, so only a multi-byte
// character split ACROSS a boundary corrupts. An audit sent 'café — naïve 日本語'
// split inside the three bytes of 日 and the server stored '���本語', answered
// 200, and returned a fresh version string — so the editor believed the save
// had succeeded. A 2 MB text limit guarantees chunking in real use, which is
// why this presented as files corrupting at random.

const shellRequire = createRequire(new URL('../../../shell/package.json', import.meta.url))
const harnessRequire = createRequire(shellRequire.resolve('@deepseek-ai/dsh/package.json'))
const filesystemModule = harnessRequire.resolve('@deepseek-ai/dsh-fs-local')
const { Context } = await import(createRequire(filesystemModule).resolve('@deepseek-ai/cordis'))
const { LocalFileSystem } = await import(filesystemModule)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fixture (t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-body-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const filesystem = new LocalFileSystem(new Context(), { cwd: home, diffBasisMaxBytes: 10 * 1024 * 1024 })
  let handler, dispose
  apply({
    fs: filesystem,
    workspaceRegistry: { list: () => [{ path: home, title: 'Fixture' }] },
    webServer: { register (config) { handler = config.handler; return () => {} } },
    on (event, fn) { if (event === 'dispose') dispose = fn },
  })
  const server = createServer((req, res) => handler(req, res))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  return { home, port: server.address().port }
}

/**
 * POST `chunks` as separate socket writes, spaced so they arrive as separate
 * 'data' events. Content-Length rather than chunked encoding keeps the framing
 * boring; the delay is what actually produces the boundary under test.
 */
function rawPost (port, path, chunks, { declaredLength } = {}) {
  const total = declaredLength ?? chunks.reduce((sum, c) => sum + c.length, 0)
  return new Promise((resolve, reject) => {
    let raw = ''
    let answered = false
    const socket = connect({ host: '127.0.0.1', port }, async () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `content-type: application/json\r\ncontent-length: ${total}\r\nConnection: close\r\n\r\n`,
      )
      for (const chunk of chunks) {
        // Stop early once the server has already answered — an oversized body
        // is refused mid-stream and there is no point sending the rest.
        if (answered || socket.destroyed) break
        socket.write(chunk)
        await sleep(15)
      }
    })
    socket.setEncoding('utf8')
    socket.setTimeout(15000, () => { socket.destroy(); reject(new Error('timed out')) })
    socket.on('data', (chunk) => { raw += chunk; answered = true })
    socket.on('end', () => resolve(raw))
    // A refused body closes the connection under us mid-write; that is the
    // behaviour being tested, not a failure.
    socket.on('error', () => resolve(raw))
  })
}

const statusOf = (raw) => Number(raw.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0)

test('a multi-byte character split across chunks survives the save', async (t) => {
  const { home, port } = await fixture(t)
  const path = join(home, 'unicode.txt')
  const text = 'café — naïve 日本語 🎬 résumé ééé'
  const body = Buffer.from(JSON.stringify({ path, text, createOnly: true }), 'utf8')

  // Split inside the three bytes of 日, which is the exact shape that corrupted.
  const marker = body.indexOf(Buffer.from('日', 'utf8'))
  assert.ok(marker > 0, 'fixture should contain the multi-byte character')
  const raw = await rawPost(port, '/dsh-files/write', [body.subarray(0, marker + 1), body.subarray(marker + 1)])

  assert.equal(statusOf(raw), 200, raw.slice(0, 200))
  // On disk, not merely in the response: the corruption was persisted.
  assert.equal(await readFile(path, 'utf8'), text)
  assert.equal((await readFile(path, 'utf8')).includes('\uFFFD'), false, 'replacement characters were written')
})

test('a malformed body is the client\'s fault, not the filesystem\'s', async (t) => {
  const { port } = await fixture(t)
  // Previously 500 "file operation failed", which logged a filesystem warning
  // and told the user their disk had failed when they had sent bad JSON.
  const raw = await rawPost(port, '/dsh-files/write', [Buffer.from('{"path": ', 'utf8')])
  assert.equal(statusOf(raw), 400, raw.slice(0, 200))
  assert.match(raw, /Invalid JSON/)
})

test('an oversized body gets a status line rather than a dropped connection', async (t) => {
  const { port } = await fixture(t)
  // The cap is 8 MB. Previously the socket was destroyed the instant the cap
  // tripped, so the client saw an empty reply with no status at all — and the
  // cap counted UTF-16 units, so it admitted up to three times what it claimed.
  const chunk = Buffer.alloc(512 * 1024, 0x61)
  const chunks = [Buffer.from('{"path":"/tmp/x","text":"', 'utf8'), ...Array.from({ length: 20 }, () => chunk)]
  const raw = await rawPost(port, '/dsh-files/write', chunks)
  assert.equal(statusOf(raw), 413, raw.slice(0, 200) || '(empty reply)')
})
