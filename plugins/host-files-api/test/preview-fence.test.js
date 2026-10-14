import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connect } from 'node:net'

import { startPreviewServer } from '../lib/preview.js'

// The preview server is deliberately unauthenticated: it must stay loadable in
// an iframe on a different loopback port, so it carries neither the app's
// capability cookie nor its Origin fence. That made it the one surface where a
// DNS rebind paid off. An audit fetched a workspace .env from it with
// `Host: evil.com` and got the file, while the identical request to the app's
// own API was refused. These tests are that attack, kept.

function fakeCtx (roots) {
  return {
    workspaceRegistry: { list: () => roots.map((path, i) => ({ id: `w${i}`, path, title: 'w' })) },
    fs: { async resolve (path) { return { path } } },
  }
}

const scratch = async () => realpath(await mkdtemp(join(tmpdir(), 'dshd-fence-')))

/** A raw request, because fetch() writes Host itself and cannot forge one. */
function rawGet (port, path, host) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    let raw = ''
    socket.setEncoding('utf8')
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timed out')) })
    socket.on('data', (chunk) => { raw += chunk })
    socket.on('end', () => resolve(raw))
    socket.on('error', reject)
  })
}

test('a rebound host cannot read workspace files through the preview server', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, '.env'), 'OPENAI_API_KEY=sk-canary-DO-NOT-USE')
  await writeFile(join(root, 'index.html'), '<h1>site</h1>')

  const { server, port } = await startPreviewServer(fakeCtx([root]))
  assert.ok(port, 'preview server should bind')
  t.after(() => new Promise((resolve) => server.close(resolve)))

  // The attack, verbatim. A browser sends the name it resolved, so a page on
  // a rebound domain arrives with that domain in Host.
  const rebound = await rawGet(port, '/.env', 'evil.com')
  assert.match(rebound, /^HTTP\/1\.1 403/, 'a forged Host must be refused')
  assert.equal(rebound.includes('sk-canary'), false, 'the file body leaked despite the status')

  // Near-miss names that merely contain a loopback literal.
  for (const host of ['localhost.evil.com', 'evil.com#127.0.0.1', '127.0.0.1.evil.com']) {
    const res = await rawGet(port, '/.env', host)
    assert.match(res, /^HTTP\/1\.1 403/, `${host} was accepted as loopback`)
  }

  // And the iframe's own request still works, or the fence has broken the pane.
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    const res = await rawGet(port, '/index.html', host)
    assert.match(res, /^HTTP\/1\.1 200/, `${host} should be served`)
  }
})

test('the fence does not depend on the file existing', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  const { server, port } = await startPreviewServer(fakeCtx([root]))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  // A 404 for a forged host would still confirm which paths exist, and the
  // refusal must come before any filesystem work rather than after it.
  assert.match(await rawGet(port, '/nothing-here.html', 'evil.com'), /^HTTP\/1\.1 403/)
})
