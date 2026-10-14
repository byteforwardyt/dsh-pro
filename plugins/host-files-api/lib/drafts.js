import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, writeFile, rename, unlink, chmod, opendir } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_TEXT_BYTES = 2 * 1024 * 1024
// Two editor buffers can expand sixfold when JSON escapes control characters.
// Bound the whole stored record, including metadata and unexpected fields.
const MAX_RECORD_BYTES = 32 * 1024 * 1024
const failure = (code, message) => Object.assign(new Error(message), { code })

// Drafts live in the app's private home, never in the project or web storage.
// Revisions protect another window's backup; per-path queues make compare/write
// atomic within the single harness host. The project file is never touched here.
export function createDraftStore (home) {
  const queues = new Map()
  const directory = home ? join(home, 'file-drafts') : null
  const fileFor = path => {
    if (!directory) throw failure('DRAFT_UNAVAILABLE', 'Draft storage is unavailable')
    return join(directory, createHash('sha256').update(path).digest('hex') + '.json')
  }
  function validate (snapshot) {
    if (!snapshot || typeof snapshot.text !== 'string' || typeof snapshot.base?.text !== 'string'
      || typeof snapshot.base?.version !== 'string' || !snapshot.base.version) {
      throw failure('DRAFT_INVALID', 'Draft needs text and its original file version')
    }
    if ([snapshot.text, snapshot.base.text].some(text => Buffer.byteLength(text) > MAX_TEXT_BYTES)) {
      throw failure('FS_TOO_LARGE', 'Draft exceeds the editor limit')
    }
  }
  async function readRecord (file) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw Error('Invalid record size or type')
      // Read at most the observed size plus one byte. Our writes replace files
      // atomically; growth in this opened inode signals external damage.
      const buffer = Buffer.alloc(info.size + 1)
      let offset = 0
      for (;;) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
        if (offset > info.size) throw Error('Record changed while reading')
      }
      const record = JSON.parse(buffer.toString('utf8', 0, offset))
      validate(record)
      if (typeof record.path !== 'string' || fileFor(record.path) !== file
        || typeof record.revision !== 'string' || !record.revision
        || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) throw Error('Invalid record')
      if (record.inventoryVersion === 1 && record.bytes !== Buffer.byteLength(record.text)) throw Error('Invalid inventory size')
      return { path: record.path, text: record.text, base: record.base, revision: record.revision, updatedAt: record.updatedAt }
    } finally { await handle.close() }
  }
  async function read (path) {
    try {
      const record = await readRecord(fileFor(path))
      if (record.path !== path) throw Error('Invalid record')
      return record
    } catch (error) {
      if (error.code === 'ENOENT') return null
      if (error.code === 'DRAFT_UNAVAILABLE') throw error
      throw failure('DRAFT_CORRUPT', 'The existing draft could not be read; it has been preserved')
    }
  }
  function metadata (record) {
    return { path: record.path, revision: record.revision, updatedAt: record.updatedAt,
      bytes: Buffer.byteLength(record.text) }
  }
  // New backups remain ordinary JSON, with a small first-line header. Listing
  // them need not allocate/parse both editor buffers. Legacy JSON still works.
  async function readMetadata (file, signal) {
    signal?.throwIfAborted();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw Error('Invalid record size or type')
      const buffer = Buffer.alloc(Math.min(info.size, 64 * 1024))
      let offset = 0, end = -1
      while (offset < buffer.length && end < 0) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead; end = buffer.indexOf(10, 0)
      }
      const prefix = buffer.toString('utf8', 0, end < 0 ? offset : end)
      if (prefix.startsWith('{"inventoryVersion":1,')) {
        if (end < 0 || !prefix.endsWith(',')) throw Error('Invalid inventory header')
        const record = JSON.parse(prefix.slice(0, -1) + '}')
        if (typeof record.path !== 'string' || fileFor(record.path) !== file
          || typeof record.revision !== 'string' || !record.revision
          || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))
          || !Number.isInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_TEXT_BYTES) throw Error('Invalid inventory header')
        return { path: record.path, revision: record.revision, updatedAt: record.updatedAt, bytes: record.bytes }
      }
    } finally { await handle.close() }
    signal?.throwIfAborted()
    return metadata(await readRecord(file))
  }
  async function * inventory ({ signal } = {}) {
    if (!directory) throw failure('DRAFT_UNAVAILABLE', 'Draft storage is unavailable')
    let handle
    try { handle = await opendir(directory) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    // opendir and async iteration avoid retaining the whole directory listing.
    // Breaking/cancelling the iterator closes its directory handle automatically.
    for await (const entry of handle) {
      signal?.throwIfAborted()
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
      let item
      try { item = { draft: await readMetadata(join(directory, entry.name), signal) } }
      catch (error) {
        signal?.throwIfAborted()
        if (error.code === 'ENOENT') continue
        item = { unreadable: true }
      }
      signal?.throwIfAborted()
      yield item
    }
  }
  async function list () {
    const drafts = []
    let unreadable = 0
    for await (const item of inventory()) {
      if (item.draft) drafts.push(item.draft)
      else unreadable++
    }
    drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path))
    return { drafts, unreadable }
  }
  function replace (path, snapshot, revision) {
    const operation = (queues.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
      if (snapshot !== null) validate(snapshot)
      const current = await read(path)
      if ((current?.revision ?? null) !== revision) {
        throw failure('DRAFT_CONFLICT', 'A newer draft exists in another window; its backup has been preserved')
      }
      const file = fileFor(path)
      if (snapshot === null) {
        if (current) await unlink(file)
        return null
      }
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const record = { path, text: snapshot.text, base: { text: snapshot.base.text, version: snapshot.base.version },
        revision: randomUUID(), updatedAt: new Date().toISOString() }
      const header = { inventoryVersion: 1, ...metadata(record) }
      // Valid JSON with a bounded metadata line followed by the original body.
      const serialized = JSON.stringify(header).slice(0, -1) + ',\n'
        + JSON.stringify({ text: record.text, base: record.base }).slice(1)
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw failure('FS_TOO_LARGE', 'Draft record exceeds the storage limit')
      const temp = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temp, serialized, { flag: 'wx', mode: 0o600 })
        await rename(temp, file)
      } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error })
      }
      return record
    })
    queues.set(path, operation)
    const release = () => { if (queues.get(path) === operation) queues.delete(path) }
    operation.then(release, release)
    return operation
  }
  return { read, replace, list, inventory }
}
