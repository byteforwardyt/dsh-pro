/**
 * Byte serving, with Range.
 *
 * Two facts force this route to exist separately from the JSON one.
 *
 * The window policy names `media-src 'self' blob:`. Same-origin
 * `<video src="/dsh-files/raw?...">` is the path we use; blob: is allowed for
 * future in-app captures, not as a substitute for this route. Media still has
 * to be a real URL on this origin so Range seeking works.
 *
 * And nothing in the harness answers Range requests — a grep for
 * `accept-ranges` and `content-range` across every `@deepseek-ai/dsh-*` package
 * finds none. Without them a `<video>` element plays from the start but cannot
 * seek past what it has buffered, and Chromium re-downloads from zero on some
 * seeks. A 90-second screen recording survives that; an hour-long one does not.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { contentTypeFor, isRenderable } from './mime.js'

/** Parse a single-range `bytes=` header against a known size. */
export function parseRange (header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    // A suffix range: the last N bytes. N larger than the file means the whole file.
    const length = Number(rawEnd)
    if (!Number.isSafeInteger(length) || length <= 0) return null
    start = Math.max(0, size - length)
    end = size - 1
  } else {
    start = Number(rawStart)
    if (!Number.isSafeInteger(start)) return null
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isSafeInteger(end)) return null
    end = Math.min(end, size - 1)
  }

  // An unsatisfiable range is not the same as an absent one: RFC 9110 wants a
  // 416 for it, and returning null here would silently serve the whole file.
  if (start > end || start >= size) return { unsatisfiable: true }
  return { start, end }
}

/**
 * Stream a file, honouring Range.
 *
 * @param res - the raw ServerResponse; this function owns it from here.
 */
export async function serveBytes (req, res, path) {
  let info
  try {
    info = await stat(path)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
    return
  }
  if (!info.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not a file')
    return
  }

  const size = info.size
  const declared = contentTypeFor(basename(path))

  // Serving workspace HTML or SVG as itself would let a file the agent just
  // wrote execute as a same-origin script — with access to every route on this
  // port, including this one. Anything the browser is not being asked to render
  // as media is served as an attachment-flavoured octet-stream instead, with
  // sniffing switched off. The Preview tab is where workspace HTML is meant to
  // run, in its own partition.
  const safe = isRenderable(declared) ? declared : 'application/octet-stream'

  const headers = {
    'content-type': safe,
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    // A CSP sandbox applies to documents, not to subresources, so this is
    // invisible to <img>, <audio> and <video> and decisive everywhere else: an
    // SVG drawn into an <img> cannot run script anyway, but the same bytes
    // framed or navigated to would, and this puts them in an opaque origin
    // instead of the one that fronts an agent with shell access. The shell
    // merges this with the window policy rather than replacing it.
    'content-security-policy': 'sandbox',
  }

  const range = parseRange(req.headers.range, size)

  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  const start = range ? range.start : 0
  const end = range ? range.end : Math.max(0, size - 1)
  const length = size === 0 ? 0 : end - start + 1

  if (range) headers['content-range'] = `bytes ${start}-${end}/${size}`
  headers['content-length'] = String(length)

  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD' || length === 0) { res.end(); return }

  const stream = createReadStream(path, { start, end })
  // A client that seeks mid-download aborts the response; destroying the stream
  // is what stops the read, and without it a scrubbed-through video leaks one
  // file handle per seek. If the client already aborted during the stat() await
  // above, res 'close' fired before this listener could attach — so check once
  // explicitly, or that same fd leaks on an abort-during-stat.
  if (res.writableEnded || res.destroyed) { stream.destroy(); return }
  res.on('close', () => stream.destroy())
  stream.on('error', () => { if (!res.writableEnded) res.destroy() })
  stream.pipe(res)
}
