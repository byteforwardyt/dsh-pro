/** Read-only, bounded decoding of the harness's append-only usage artifacts. */
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { StringDecoder } from 'node:string_decoder'
import { setImmediate } from 'node:timers/promises'

export const MAX_LOG_BYTES = 24 * 1024 * 1024
const MAX_DECODED_BYTES = 64 * 1024 * 1024
const decompress = promisify(zstdDecompress)
const relevant = new Set(['request/header', 'assistant/chunk', 'assistant/message'])
class ConsumerError extends Error {}

// Follow frame/block lengths, not magic-byte occurrences inside payloads.
// This is the same frame layout used by the installed JSONL persistence writer;
// zlib validates compressed content and checksums after the boundary is known.
function frameEnd(raw, start) {
  if (raw.length - start < 4) return null
  if (raw.readUInt32LE(start) !== 0xfd2fb528) throw new Error('invalid frame magic')
  let offset = start + 4
  if (offset === raw.length) return null
  const descriptor = raw[offset++]
  if (descriptor & 24) throw new Error('reserved frame flag')
  const single = Boolean(descriptor & 32)
  const sizeFlag = descriptor >>> 6
  const dictFlag = descriptor & 3
  offset += (single ? 0 : 1) + (dictFlag === 3 ? 4 : dictFlag)
    + (sizeFlag === 0 ? (single ? 1 : 0) : 1 << sizeFlag)
  if (offset > raw.length) return null
  for (;;) {
    if (raw.length - offset < 3) return null
    const header = raw.readUIntLE(offset, 3)
    offset += 3
    const type = (header >>> 1) & 3
    if (type === 3) throw new Error('reserved block type')
    offset += type === 1 ? 1 : header >>> 3
    if (offset > raw.length) return null
    if (header & 1) break
  }
  if (descriptor & 4) offset += 4
  return offset <= raw.length ? offset : null
}

// With onEvent, feed confirmed records directly to the projection instead of
// retaining complete assistant messages. The events-array API remains available.
export async function readUsageLog(file, { maxDecodedBytes = MAX_DECODED_BYTES, signal, onEvent } = {}) {
  signal?.throwIfAborted()
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Invalid usage event consumer')
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 1 || maxDecodedBytes > MAX_DECODED_BYTES)
    throw new TypeError('Invalid usage decode budget')
  const events = []
  let handle, raw, changed = false
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    signal?.throwIfAborted()
    const before = await handle.stat()
    if (!before.isFile()) return { events, issue: 'unreadable' }
    if (before.size > MAX_LOG_BYTES) return { events, issue: 'oversized' }
    // Read at most the observed size plus one byte, even if the file grows.
    const buffer = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < buffer.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_LOG_BYTES) return { events, issue: 'oversized' }
    raw = buffer.subarray(0, length)
    const after = await handle.stat()
    changed = before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size
  } catch { signal?.throwIfAborted(); return { events, issue: 'unreadable' } }
  finally { await handle?.close() }
  signal?.throwIfAborted()
  if (!raw.length) return { events, issue: 'truncated' }

  let carry = '', lines = 0
  const decoder = new StringDecoder('utf8')
  const consume = async bytes => {
    signal?.throwIfAborted()
    const text = carry + decoder.write(bytes)
    let start = 0, end
    while ((end = text.indexOf('\n', start)) !== -1) {
      const line = text.slice(start, end)
      start = end + 1
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('invalid event')
      if (event.type === 'session' && event.version !== 0) throw new Error('unsupported log version')
      if (relevant.has(event.type)) {
        if (onEvent) {
          try { await onEvent(event) } catch (cause) { throw new ConsumerError('Usage consumer failed', {cause}) }
        } else events.push(event)
      }
      if (++lines % 512 === 0) { await setImmediate(); signal?.throwIfAborted() }
    }
    carry = text.slice(start)
  }

  if (!file.endsWith('.zstd')) {
    if (raw.length > maxDecodedBytes) return { events, issue: 'oversized' }
    try { await consume(raw) } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof ConsumerError) throw error.cause
      return { events, issue: 'corrupt' }
    }
  } else {
    let offset = 0, decoded = 0, frames = 0
    while (offset < raw.length) {
      signal?.throwIfAborted()
      let end
      try { end = frameEnd(raw, offset) } catch { return { events, issue: 'corrupt' } }
      if (end === null) return { events, issue: 'truncated' }
      if (decoded >= maxDecodedBytes) return { events, issue: 'oversized' }
      let bytes
      try { bytes = await decompress(raw.subarray(offset, end), { maxOutputLength: maxDecodedBytes - decoded }) }
      catch (error) { signal?.throwIfAborted(); return { events, issue: error.code === 'ERR_BUFFER_TOO_LARGE' ? 'oversized' : 'corrupt' } }
      decoded += bytes.length
      try { await consume(bytes) } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof ConsumerError) throw error.cause
        return { events, issue: 'corrupt' }
      }
      offset = end
      if (++frames % 128 === 0) await setImmediate()
    }
  }
  signal?.throwIfAborted()
  carry += decoder.end()
  return { events, issue: changed || carry.length > 0 ? 'truncated' : null }
}
