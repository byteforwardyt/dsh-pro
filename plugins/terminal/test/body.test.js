/**
 * Request bodies on /dsh-terminal.
 *
 * A mangled body on a file API corrupts a save. A mangled body here runs a
 * different command than the one submitted, so these are the same three
 * failures the file API fixed, held to the same wire behaviour.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { fixtureContext, plainShell, request, response, trusted, workspace } from './harness.js'

/** Apply the plugin and hand back the one handler it registered. */
function route (roots) {
  const ctx = fixtureContext(roots)
  let handler = null
  let disposer = null
  ctx.webServer.register = ({ handler: fn }) => { handler = fn; return () => {} }
  ctx.on = (event, fn) => { if (event === 'dispose') disposer = fn }
  apply(ctx)
  return { handler, dispose: () => disposer?.() }
}

/** Split `text` into two Buffers at a byte offset, which is how a socket does it. */
function splitBytes (text, at) {
  const whole = Buffer.from(text, 'utf8')
  return [whole.subarray(0, at), whole.subarray(at)]
}

test('a body split inside a multi-byte character is not silently mangled', async () => {
  const root = workspace()
  // A directory whose name needs three bytes per character. The containment
  // fence resolves the path it is given, so a body that decoded to U+FFFD
  // cannot possibly match it — which is what makes this observable from
  // outside rather than a test of the decoder's internals.
  const nested = join(root, '\u65e5\u672c\u8a9e')
  mkdirSync(nested)
  const { handler, dispose } = route([root])
  const restore = plainShell()
  try {
    const payload = JSON.stringify({ cwd: nested })
    // Cut ONE BYTE INTO the last character, not at its boundary: a boundary
    // split decodes correctly even with the broken reader, so a test that
    // lands on one proves nothing. The assertion below pins that down.
    const cut = Buffer.byteLength(payload, 'utf8') - 4
    const pieces = splitBytes(payload, cut)
    assert.match(pieces[0].toString('utf8'), /\ufffd$/, 'the split has to straddle a character to mean anything')
    const res = response()
    await handler(request('POST', '/dsh-terminal/open', trusted, pieces), res)
    assert.equal(res.statusCode, 201, res.body)
    assert.equal(res.json.session.cwd, nested)
  } finally {
    dispose()
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an oversized body is refused with a status line, not an empty reply', async () => {
  const { handler, dispose } = route([process.cwd()])
  try {
    const huge = JSON.stringify({ id: 'x', command: 'a'.repeat(300 * 1024) })
    const res = response()
    // Delivered in socket-sized pieces, because the refusal happens mid-stream
    // and the bug was that destroying the request there killed the socket
    // before anything could be written to it.
    const chunks = []
    for (let at = 0; at < huge.length; at += 64 * 1024) chunks.push(Buffer.from(huge.slice(at, at + 64 * 1024)))
    await handler(request('POST', '/dsh-terminal/run', trusted, chunks), res)
    assert.equal(res.statusCode, 413)
    assert.deepEqual(res.json, { error: 'body too large' })
    assert.equal(res.ended, true, 'the client must not be left waiting on a reply that never comes')
  } finally { dispose() }
})

test('the size cap counts bytes, not UTF-16 code units', async () => {
  const { handler, dispose } = route([process.cwd()])
  try {
    // 100k three-byte characters: 300 KB on the wire, 100k units in a JS
    // string. Counting units let a body through at three times the stated cap.
    const command = '\u65e5'.repeat(100_000)
    assert.ok(command.length < 256 * 1024)
    assert.ok(Buffer.byteLength(command, 'utf8') > 256 * 1024)
    const payload = JSON.stringify({ id: 'x', command })
    const chunks = []
    const whole = Buffer.from(payload, 'utf8')
    for (let at = 0; at < whole.length; at += 64 * 1024) chunks.push(whole.subarray(at, at + 64 * 1024))
    const res = response()
    await handler(request('POST', '/dsh-terminal/run', trusted, chunks), res)
    assert.equal(res.statusCode, 413)
  } finally { dispose() }
})

test('a malformed body is the client\'s fault and says so', async () => {
  const { handler, dispose } = route([process.cwd()])
  try {
    const res = response()
    await handler(request('POST', '/dsh-terminal/run', trusted, [Buffer.from('{not json')]), res)
    // 500 "terminal operation failed" blamed the shell for a body it never saw.
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.json, { error: 'Invalid JSON.' })

    // An empty body still means "no fields", which several routes rely on.
    const empty = response()
    await handler(request('POST', '/dsh-terminal/close', trusted, []), empty)
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json, { ok: false })
  } finally { dispose() }
})
