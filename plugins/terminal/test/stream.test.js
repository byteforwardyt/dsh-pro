/**
 * The NDJSON stream on /dsh-terminal, read by a socket that stops draining.
 *
 * A reader that keeps up sees neither of these failures, and every reader in
 * the rest of this suite keeps up. What is left over when a socket stalls is
 * the host holding output on that reader's behalf, and holding a subscription
 * that sessions.js counts as a live reader — so both tests stall the writer on
 * purpose and then ask what the host is still carrying.
 *
 * Real shells, like the rest of the suite. The exit event in particular is
 * emitted when the child handle settles, which is not something a fake stdin
 * can produce at the right moment relative to a stalled write.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { streamSession } from '../lib/index.js'
import { createSessions } from '../lib/sessions.js'
import { deadline, fixtureContext, plainShell, request, response, trusted, until, workspace } from './harness.js'

/**
 * The route's byte bound, restated here rather than imported.
 *
 * Importing MAX_QUEUED_BYTES made this whole file fail at LOAD time against a
 * build that does not have the export — a SyntaxError that proves the symbol
 * is new and nothing at all about behaviour. Restated, the same test runs
 * against either build and fails on what the reader was actually handed, which
 * is the thing worth asserting. lib/index.js owns the real value; if it moves,
 * this moves with it and the assertions below say so when it does not.
 */
const QUEUE_BOUND_BYTES = 1024 * 1024

/**
 * harness.js's response(), with the one behaviour it does not have: a socket
 * that can refuse a write and stay refused. Wrapped rather than replaced, so
 * the recorded body is still the fixture's own.
 *
 * `stallOn` is given each line as it is written and decides whether this is
 * the write that backs up; `drain()` is the only thing that lets the writer
 * go again, which is what makes "never drains" expressible at all.
 */
function socket (stallOn = () => false) {
  const res = response()
  const events = new EventEmitter()
  for (const method of ['on', 'once', 'off', 'addListener', 'removeListener', 'removeAllListeners', 'emit', 'listenerCount']) {
    res[method] = (...args) => events[method](...args)
  }
  const record = res.write.bind(res)
  let stalled = false
  res.write = (chunk) => {
    record(chunk)
    if (!stalled && stallOn(chunk)) stalled = true
    return !stalled
  }
  // The route destroys the response when its lifetime is aborted; without this
  // the teardown below turns into a TypeError inside streamSession's catch.
  res.destroy = () => { res.destroyed = true }
  res.stalled = () => stalled
  res.drain = () => { stalled = false; events.emit('drain') }
  return res
}

test('the reader queue is bounded by bytes, not by event count', { timeout: 30_000 }, async () => {
  const root = workspace()
  const restore = plainShell()
  const sessions = createSessions(fixtureContext([root]))
  const lifetime = new AbortController()
  // Four times the bound, from a file: `cat` of an already-cached file is the
  // one producer measured to outrun the socket (8 MB of it left 6.7 MB queued
  // against a reader that never paused), so it is what a byte bound has to
  // hold. A command that paces itself never gets near this — `git log -p -n 40`
  // moved 3.25 MB with a 69 KB high-water queue.
  const blast = join(root, 'blast.txt')
  writeFileSync(blast, Buffer.alloc(4 * 1024 * 1024, 0x61))
  let stalling = true
  const res = socket(() => stalling)
  let stream = Promise.resolve()
  try {
    const opened = await sessions.open({ cwd: root })
    // Counts what the stream was handed, which is the number the bound is
    // about; the queue's own accounting is private to the route.
    let handedBytes = 0
    let handedEvents = 0
    const counted = {
      subscribe: (id, since, onEvent) => sessions.subscribe(id, since, (event) => {
        handedBytes += Buffer.byteLength(JSON.stringify(event) + '\n')
        handedEvents += 1
        onEvent(event)
      }),
    }
    const url = '/dsh-terminal/stream?id=' + opened.id
    stream = streamSession(request('GET', url, trusted), res, counted, opened.id, null, lifetime.signal)
    await until(() => res.stalled(), 5000, 'the reader to stall on its first write')

    sessions.run(opened.id, 'cat ' + blast)
    await until(() => handedBytes > 2 * QUEUE_BOUND_BYTES, 20_000, 'the stalled reader to be handed twice the bound')
    // splitChunk caps an event at 16 KB, so 2 MB arrives as ~130 events and
    // the count bound this replaced did not trip until 2000 of them — 32 MB
    // measured on the shipped build. A test that let the event count near 2000
    // would pass for the wrong reason.
    assert.ok(handedEvents < 500, 'the old count bound must be nowhere near tripping, got ' + handedEvents + ' events')

    stalling = false
    res.drain()
    await until(() => res.body.includes('fell behind'), 10_000, 'the stream to tell the reader to reconnect')
    await deadline(stream, 10_000, 'the stream to end after the overflow')
    // The reader is left holding the bound and the notice, not the blast: the
    // ring replays the rest from `since`.
    const delivered = Buffer.byteLength(res.body)
    assert.ok(delivered < 2 * QUEUE_BOUND_BYTES, 'the reader was handed ' + delivered + ' bytes, past the bound')
  } finally {
    lifetime.abort()
    stalling = false
    res.drain()
    await stream.catch(() => {})
    await sessions.dispose()
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a stream lets go of its subscription as soon as the exit event is written', { timeout: 30_000 }, async () => {
  const root = workspace()
  const restore = plainShell()
  // The reaper's own seams, short enough to watch: the idle grace can only
  // start once nothing is listening, which is what the release is for.
  const sessions = createSessions(fixtureContext([root]), { idleGraceMs: 750, reapIntervalMs: 100 })
  const lifetime = new AbortController()
  // Stall on the exit event itself. Everything before it is written and
  // acknowledged, so what this pins down is the window between the last event
  // a session can emit and a socket that may never come back.
  const res = socket((line) => line.includes('"kind":"exit"'))
  let stream = Promise.resolve()
  try {
    const opened = await sessions.open({ cwd: root })
    let releases = 0
    const counted = {
      subscribe: (id, since, onEvent) => {
        const unsubscribe = sessions.subscribe(id, since, onEvent)
        return () => { releases += 1; unsubscribe() }
      },
    }
    let finished = false
    const url = '/dsh-terminal/stream?id=' + opened.id
    stream = streamSession(request('GET', url, trusted), res, counted, opened.id, null, lifetime.signal)
      .then(() => { finished = true })
    await until(() => res.body.includes('"kind":"session"'), 5000, 'the stream to attach')

    // The shell exits on its own. close() clears the session's listeners
    // itself, which would hide the very thing under test.
    sessions.write(opened.id, 'exit\n')
    await until(() => res.body.includes('"kind":"exit"'), 10_000, 'the shell to exit')
    assert.equal(res.stalled(), true, 'the exit line has to be the write that backs up or this proves nothing')

    await until(() => releases === 1, 5000, 'the stream to release its subscription while the socket is still stalled')
    assert.equal(finished, false, 'the writer is still waiting on drain, so that release was not the finally')
    // What the held subscription actually cost: sessions.js counts a listener
    // as a live reader and will not reap a session that has one, so a shell
    // that had already exited stayed in the registry for as long as the reader
    // was stuck — 4 reaper ticks, 135 s, on the shipped build. Nothing has
    // drained here yet, and it is gone.
    await until(() => sessions.list().length === 0, 10_000, 'the exited session to be reaped while the reader is still stuck')

    res.drain()
    await deadline(stream, 10_000, 'the stream to finish once the socket drains')
    assert.equal(releases, 1, 'the finally must not unsubscribe a second time')
  } finally {
    lifetime.abort()
    res.drain()
    await stream.catch(() => {})
    await sessions.dispose()
    restore()
    rmSync(root, { recursive: true, force: true })
  }
})
