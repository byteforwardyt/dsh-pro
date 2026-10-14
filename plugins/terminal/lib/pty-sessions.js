/** Interactive user terminals. Agent commands keep their separate completion protocol. */
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { containedPath } from './roots.js'
import { resolveShell } from './shell.js'
import { createRing, splitChunk, listRoots, SessionError } from './sessions.js'

const dimension = (value, fallback) => value === undefined ? fallback :
  Number.isInteger(value) && value >= 2 && value <= 500 ? value : (() => { throw new SessionError(400, 'Invalid terminal dimensions.') })()

export function createPtySessions(ctx) {
  const records = new Map()
  let allocating = 0, disposed = false
  const allocation = new AbortController()
  const get = id => {
    const row = records.get(id)
    if (!row) throw new SessionError(404, 'Terminal not found.')
    return row
  }
  const describe = row => ({ id: row.id, cwd: row.cwd, shell: row.shell, running: row.running, cols: row.cols, rows: row.rows })
  const emit = (row, event) => {
    const entry = row.ring.push(event)
    for (const listener of row.listeners) listener(entry)
  }
  return {
    roots: () => listRoots(ctx),
    list: () => [...records.values()].map(describe),
    async open(body = {}) {
      if (disposed) throw new SessionError(503, 'Terminal service is stopping.')
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SessionError(400, 'Invalid terminal request.')
      for (const [id, row] of records) if (!row.running) records.delete(id)
      if (records.size + allocating >= 8) throw new SessionError(409, 'Close a terminal before opening another.')
      allocating++
      let handle
      try {
        const resolved = await containedPath(ctx, body.cwd)
        if (!resolved) throw new SessionError(403, 'Choose an open workspace.')
        if (!(await stat(resolved.path)).isDirectory()) throw new SessionError(400, 'Choose a directory.')
        const shell = await resolveShell()
        if (!shell) throw new SessionError(503, 'No supported shell is installed.')
        const cols = dimension(body.cols, 80), rows = dimension(body.rows, 24)
        // rc.2 allocates all terminals as TERM=dumb. Set TERM in the child
        // before shell startup so interactive CLIs discover the real emulator.
        const env = await ctx.subprocess.resolveExecutable('env')
        handle = await ctx.subprocess.spawnTerminal({ argv: [env, 'TERM=xterm-256color', shell.path, '-l', '-i'], cwd: resolved.path,
          env: { TERM: 'xterm-256color' }, cols, rows, graceMs: 1000, signal: allocation.signal })
        // rc.2's public terminal seam omits resize. Its locked local provider
        // exposes the underlying PTY; fail visibly if that contract changes.
        // Keep lifecycle/tree cleanup on the provider rather than a second spawner.
        const resize = typeof handle.resize === 'function' ? handle.resize.bind(handle)
          : handle.terminal?.resize?.bind(handle.terminal)
        if (!resize) throw new Error('The terminal provider does not support live resizing.')
        if (disposed) throw new Error('Terminal service is stopping.')
        const row = { id: randomUUID(), cwd: resolved.path, shell: shell.name, cols, rows,
          handle, resize, running: true, ring: createRing(1024 * 1024), listeners: new Set() }
        records.set(row.id, row)
        handle.output.setEncoding('utf8')
        handle.output.on('data', text => { for (const part of splitChunk(text)) emit(row, { kind: 'chunk', text: part }) })
        handle.output.on('error', error => emit(row, { kind: 'error', message: error.message }))
        handle.done.then(outcome => { row.running = false; emit(row, { kind: 'exit', ...outcome }) },
          error => { row.running = false; emit(row, { kind: 'error', message: error.message }); emit(row, { kind: 'exit' }) })
        return describe(row)
      } catch (error) { if (handle) await handle.terminate(); throw error }
      finally { allocating-- }
    },
    subscribe(id, since, callback) {
      const row = get(id), replay = row.ring.since(since)
      callback({ kind: 'session', session: describe(row), truncated: replay.truncated })
      replay.events.forEach(callback)
      row.listeners.add(callback)
      return () => row.listeners.delete(callback)
    },
    async write(id, data) {
      if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw new SessionError(400, 'Terminal input is too large or invalid.')
      const row = get(id)
      if (!row.running) throw new SessionError(409, 'Terminal has exited. Restart it.')
      await row.handle.write(data)
    },
    resize(id, cols, rows) {
      const row = get(id)
      const nextCols = dimension(cols, row.cols), nextRows = dimension(rows, row.rows)
      if (row.running) row.resize(nextCols, nextRows)
      row.cols = nextCols; row.rows = nextRows
      return describe(row)
    },
    async close(id) {
      const row = records.get(id)
      if (!row) return false
      await row.handle.terminate()
      records.delete(id)
      return true
    },
    async dispose() {
      disposed = true; allocation.abort()
      await Promise.all([...records.values()].map(row => row.handle.terminate()))
      records.clear()
    },
  }
}
