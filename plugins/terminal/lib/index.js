/**
 * HTTP surface for the Terminal view.
 *
 * The app already publishes the filesystem seam on /dsh-files; this publishes
 * the one thing it deliberately did not, a shell, and it is held to a higher
 * standard because of what a shell is. Both of the file API's fences apply
 * here unchanged, and neither is optional:
 *
 *   - `isTrustedRequest` keeps other processes on this machine out. It is
 *     imported from host-files-api rather than copied so there is one
 *     definition of the loopback fence to reason about; the note there
 *     explains why Host is the load-bearing header rather than Origin.
 *   - `containedPath` keeps a session inside a directory the user opened.
 *     Applied in sessions.js at the one place a cwd is chosen, so no route can
 *     forget it.
 *
 * Routes (all under /dsh-terminal):
 *   GET  /sessions          live sessions, and the roots a session may open in
 *   POST /open              {root?,cwd?,cols?,rows?} start a shell, fenced
 *   GET  /stream?id=&since= the session's output as NDJSON, resumable
 *   POST /run               {id,command} submit one command line
 *   POST /input             {id,data} raw stdin for a program's own prompt
 *   POST /signal            {id,signal} SIGINT the running command, not the shell
 *   POST /resize            {id,cols,rows} record new dimensions
 *   POST /close             {id} stop the shell and its process tree
 */

import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { isTrustedRequest } from '@dsh-desktop/host-files-api/trust'

import { createSessions } from './sessions.js'
import { createPtySessions } from './pty-sessions.js'
import { registerTerminalTool } from './tool.js'

const PREFIX = '/dsh-terminal'
const require = createRequire(import.meta.url)
const assets = {
  '/assets/xterm.js': [require.resolve('@xterm/xterm'), 'text/javascript'],
  '/assets/fit.js': [require.resolve('@xterm/addon-fit'), 'text/javascript'],
  '/assets/xterm.css': [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css'],
  '/assets/pty-view.js': [new URL('./pty-view.js', import.meta.url), 'text/javascript'],
}

/** A request body larger than this is refused before it is parsed. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Output buffered for one slow reader, in BYTES. Past this the reader is told
 * to reconnect instead of being buffered without limit — the ring already
 * holds the history, so a reconnect with `since` loses nothing.
 *
 * Every other bound here counts bytes — MAX_BODY_BYTES and the session ring
 * at 256 KB, MAX_INPUT_BYTES at 64 KB, MAX_COMMAND_BYTES at 8 KB — and this
 * one counted EVENTS, so its real ceiling was 2000 x MAX_EVENT_CHARS.
 * Measured against an instrumented build over a real loopback socket, a
 * 100 MB dump into one reader that had stopped reading: 32.89 MB of queue at
 * the high-water mark and +145 MB RSS in the host, and six such readers
 * retained 197 MB between them. The same blast holds 1.05 MB per reader here,
 * +29 MB RSS.
 *
 * Reader health was never what decided the depth: a reader consuming as fast
 * as the socket allowed still peaked at 22-24 MB during a 32 MB dump, because
 * `cat` of an already-cached file out-produces the writer about three to one.
 * This number decides it.
 *
 * 1 MB is four times the session's own scrollback (MAX_SCROLLBACK_BYTES), so
 * a reader may fall four whole transcripts behind before it is cut loose, and
 * what is dropped past that was going to be discarded on arrival: the ring
 * replays at most 256 KB and the pane keeps 400 000 chars
 * (MAX_TRANSCRIPT_CHARS in client.js). Against the commands a pane actually
 * runs it is ~15x headroom, because a real program paces its own output —
 * `git log -p -n 40` moved 3.25 MB with a 69 KB high-water queue (4 events),
 * `ls -laR` over this repo 45 KB, `cat` of two source files 48 KB. The
 * measured trip point is a raw dump: `cat` of a 1 MB file peaks at 460 KB and
 * still streams whole, 2 MB overflows once and the reader is told to
 * reconnect where it used to be buffered entire.
 */
export const MAX_QUEUED_BYTES = 1024 * 1024

export const inject = ['webServer', 'subprocess', 'workspaceRegistry', 'sessions', 'tools']

function json (res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Read a JSON request body. Kept wire-identical to the file API's reader,
 * because a client that has to remember which loopback route mangles which
 * body is a client that will get it wrong.
 *
 * Decoded through a StringDecoder rather than `raw += chunk`. Concatenation
 * decodes each Buffer independently, so a multi-byte character split across a
 * chunk boundary becomes replacement characters — and on this API that means
 * running a DIFFERENT command from the one submitted. Measured against the
 * shipped build: POSTing /input with 40 KB of padding followed by '日本語'
 * arrives in two socket reads and delivered '\ufffd\ufffd本語' to the shell.
 * /run is the same code path; an 8 KB command is usually one read, which is
 * why this presents as intermittent rather than never working.
 *
 * The cap counts BYTES. `raw.length` counted UTF-16 code units, so a body of
 * three-byte characters was loose by 3x and a four-byte one by 1.5x.
 *
 * Both failures reject with a status, because the previous rejections reached
 * the route's generic handler and surfaced as 500 "terminal operation failed"
 * — blaming the shell for what the client sent.
 */
function readJson (req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let raw = ''
    let bytes = 0
    let refused = false
    req.on('data', (chunk) => {
      if (refused) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        refused = true
        raw = ''
        // Paused, not destroyed. Destroying here killed the socket before the
        // route could write anything, so an oversized body got an empty reply
        // with no status line at all. Node closes the connection itself once
        // the 413 is written, because the body was never fully read.
        req.pause()
        const error = new Error('body too large')
        error.status = 413
        reject(error)
        return
      }
      raw += decoder.write(chunk)
    })
    req.on('end', () => {
      if (refused) return
      raw += decoder.end()
      try { resolve(JSON.parse(raw || '{}')) } catch {
        const error = new Error('Invalid JSON.')
        error.status = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Stream one session as NDJSON.
 *
 * The subscription callback is synchronous and the socket is not, so events
 * land in a queue the writer drains under backpressure. The queue is bounded:
 * a reader that stops reading during a noisy build must not turn into unbounded
 * memory in the host process.
 *
 * Exported the way sessions.js exports its bounds, and for the same reason:
 * both failures this function has had are only expressible from a socket that
 * has stopped draining, which no request through the route can describe.
 */
export async function streamSession (req, res, sessions, id, since, lifetime) {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, lifetime])
  const cancel = () => controller.abort()
  req.once('aborted', cancel)
  res.once('close', cancel)

  const queue = []
  let queuedBytes = 0
  let overflowed = false
  let wake = () => {}
  const push = (event) => {
    // Serialised on the way in rather than on the way out: the bound is in
    // wire bytes, and this is the only place that can count them without
    // encoding every event twice.
    const line = JSON.stringify(event) + '\n'
    const bytes = Buffer.byteLength(line)
    queue.push({ kind: event.kind, line, bytes })
    queuedBytes += bytes
    if (queuedBytes > MAX_QUEUED_BYTES) {
      queue.length = 0
      queuedBytes = 0
      overflowed = true
    }
    wake()
  }

  let unsubscribe
  try {
    unsubscribe = sessions.subscribe(id, since, push)
  } catch (error) {
    req.off('aborted', cancel)
    res.off('close', cancel)
    return json(res, error?.status ?? 500, { error: error?.message ?? 'could not attach' })
  }

  // Guarded because two paths reach it: the exit case in the loop below, and
  // the finally that still has to be correct when the stream ends any other
  // way. sessions.js removes the listener from a Set, so a second call would
  // be harmless today — this keeps it harmless if that ever stops being true.
  let subscribed = true
  const release = () => {
    if (!subscribed) return
    subscribed = false
    unsubscribe()
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  signal.addEventListener('abort', () => wake(), { once: true })

  try {
    for (;;) {
      signal.throwIfAborted()
      let ended = false
      while (queue.length > 0) {
        const event = queue.shift()
        queuedBytes -= event.bytes
        const flushed = res.write(event.line)
        // `exit` is the last event a session can emit, so the subscription is
        // dead weight from here — and it is released BEFORE the drain wait,
        // not after the writer finishes, because a socket that never drains
        // would otherwise hold the listener for the life of the process.
        // sessions.js counts a listener as a live reader and will not reap a
        // session that has one, so holding this past the exit is what kept a
        // dead shell in the registry: measured on the shipped build, still
        // there across 4 reaper ticks (135 s) with one stalled reader.
        if (event.kind === 'exit') { ended = true; release() }
        if (!flushed) await once(res, 'drain', { signal })
      }
      if (overflowed) {
        res.write(JSON.stringify({
          kind: 'error',
          message: 'The terminal stream fell behind. Reconnecting will catch up.',
        }) + '\n')
        break
      }
      if (ended) break
      await new Promise((resolve) => {
        wake = resolve
        if (queue.length > 0 || signal.aborted) resolve()
      })
    }
    if (!res.destroyed) res.end()
  } catch (error) {
    if (!signal.aborted && !res.destroyed) {
      res.end(JSON.stringify({ kind: 'error', message: 'The terminal stream stopped unexpectedly.' }) + '\n')
    } else if (!res.destroyed) res.destroy()
  } finally {
    release()
    req.off('aborted', cancel)
    res.off('close', cancel)
  }
}

export function apply (ctx) {
  const sessions = createSessions(ctx)
  const terminals = createPtySessions(ctx)
  const lifetime = new AbortController()

  const handler = async (req, res) => {
    if (!isTrustedRequest(req)) return json(res, 403, { error: 'cross-origin request refused' })

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    try {
      if (method === 'GET' && assets[route]) {
        const [file, type] = assets[route]
        const bytes = await readFile(file)
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
        return res.end(bytes)
      }
      if (route === '/pty/sessions' && method === 'GET') return json(res, 200, { sessions: terminals.list(), roots: terminals.roots() })
      if (route === '/pty/stream' && method === 'GET') {
        const raw = url.searchParams.get('since'), since = raw === null ? null : Number(raw)
        return await streamSession(req, res, terminals, url.searchParams.get('id') ?? '', since, lifetime.signal)
      }
      if (route === '/sessions' && method === 'GET') {
        return json(res, 200, { sessions: sessions.list(), roots: sessions.roots() })
      }

      if (route === '/stream' && method === 'GET') {
        const since = Number(url.searchParams.get('since'))
        return await streamSession(
          req, res, sessions,
          url.searchParams.get('id') ?? '',
          Number.isInteger(since) && since >= 0 ? since : null,
          lifetime.signal,
        )
      }

      if (method !== 'POST') return json(res, 404, { error: 'no such route' })
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return json(res, 415, { error: 'JSON required' })
      }
      const body = await readJson(req)

      if (route === '/pty/open') return json(res, 201, { session: await terminals.open(body) })
      if (route === '/pty/input') { await terminals.write(body?.id, body?.data); return json(res, 200, { ok: true }) }
      if (route === '/pty/resize') return json(res, 200, { session: terminals.resize(body?.id, body?.cols, body?.rows) })
      if (route === '/pty/close') return json(res, 200, { ok: await terminals.close(body?.id) })

      if (route === '/open') return json(res, 201, { session: await sessions.open(body) })
      if (route === '/run') return json(res, 200, sessions.run(body?.id, body?.command))
      if (route === '/input') { sessions.write(body?.id, body?.data); return json(res, 200, { ok: true }) }
      if (route === '/signal') return json(res, 200, { ok: true, ...await sessions.interrupt(body?.id, body?.signal ?? 'SIGINT') })
      if (route === '/resize') return json(res, 200, { ok: true, session: sessions.resize(body?.id, body?.cols, body?.rows) })
      if (route === '/close') return json(res, 200, { ok: sessions.close(body?.id) })

      return json(res, 404, { error: 'no such route' })
    } catch (error) {
      // SessionError carries the status the caller should see; anything else is
      // ours and is reported without detail, the same way the file API does.
      if (Number.isInteger(error?.status)) return json(res, error.status, { error: error.message })
      ctx.logger?.warn?.('terminal-api: %s', error?.message ?? error)
      return json(res, 500, { error: 'terminal operation failed' })
    }
  }

  registerTerminalTool(ctx, sessions)

  const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })
  ctx.on('dispose', () => {
    dispose()
    lifetime.abort()
    // Every shell, and everything it started, goes with the plugin: a dev
    // server the user started here must not outlive the app that started it.
    // dispose() waits for the descendant sweep as well as the shells, and
    // sessions.js close() records the one child shape that still survives it.
    sessions.dispose().catch((error) => ctx.logger?.warn?.('terminal teardown: %s', error?.message ?? error))
    terminals.dispose().catch((error) => ctx.logger?.warn?.('terminal teardown: %s', error?.message ?? error))
  })
}
