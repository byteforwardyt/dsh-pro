import { realpath, stat } from 'node:fs/promises'
import { relative, isAbsolute } from 'node:path'

const failure = (status, message) => Object.assign(new Error(message), { status })
const clean = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/((?:api[_-]?key|token|password|authorization)\s*[:=]\s*)\S+/gi, '$1[redacted]')

/** Only URLs printed by this chat's process are considered; never scan shared ports. */
export function localPreviewURL (text) {
  for (const match of clean(text).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+(?:\/[^\s<>"']*)?/g)) {
    try {
      const url = new URL(match[0])
      if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1'
      if (url.port && !url.username && !url.password) return url.href
    } catch { /* Incomplete output is retried when the next chunk arrives. */ }
  }
  return null
}

/** Owns only processes started through Preview. No persisted PIDs or borrowed terminals. */
export function createPreviewProjects (ctx, intents, options = {}) {
  const records = new Map(), queues = new Map()
  let disposed = false
  const max = options.max ?? 8
  const snapshot = record => record ? {
    sessionId: record.sessionId, cwd: record.cwd, command: record.command,
    status: record.status, url: record.url, error: record.error, output: record.output,
  } : { status: 'stopped', url: '', error: '', output: '' }

  async function sessionRoot (sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw failure(400, 'Choose a chat first.')
    const sessions = await ctx.sessions.list()
    const session = sessions.find(s => (s.header?.id ?? s.id) === sessionId)
    // Browsing a restored chat does not create a live agent/session. Read its
    // stored header without launching an agent or rewriting conversation data.
    const stored = !session && ctx.sessionPersistence ? (await ctx.sessionPersistence.list()).find(s => s.id === sessionId) : null
    const cwd = session?.header?.cwd ?? session?.cwd ?? stored?.cwd
    if (!cwd) throw failure(404, 'This chat has no project folder.')
    return realpath(cwd)
  }

  async function validate (request) {
    const root = await sessionRoot(request.sessionId)
    if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) throw failure(400, 'Choose an absolute project folder.')
    const cwd = await realpath(request.cwd).catch(() => { throw failure(400, 'Project folder not found.') })
    const rel = relative(root, cwd)
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw failure(403, 'Choose a folder inside this chat’s workspace.')
    if (!(await stat(cwd)).isDirectory()) throw failure(400, 'Choose a project directory.')
    if (typeof request.command !== 'string' || !request.command.trim() || request.command.includes('\0') || request.command.length > 8192)
      throw failure(400, 'Enter a launch command (up to 8 KB).')
    return { cwd, command: request.command.trim() }
  }

  function enqueue (id, operation) {
    const pending = (queues.get(id) || Promise.resolve()).catch(() => {}).then(operation)
    queues.set(id, pending)
    const release = () => { if (queues.get(id) === pending) queues.delete(id) }
    pending.then(release, release)
    return pending
  }

  async function stop (record) {
    if (!record?.handle) return
    record.status = 'stopping'
    intents.clearManaged?.(record.sessionId, record.url)
    clearInterval(record.timer)
    record.controller.abort()
    record.handle.terminate()
    const stopped = await record.handle.waitForExit(AbortSignal.timeout(6000))
    if (!stopped) {
      record.error = 'The server has not stopped yet. Try Stop again; a second process will not be started.'
      throw failure(409, record.error)
    }
    record.handle = null
    record.status = 'stopped'
    record.url = ''
  }

  async function check (record) {
    if (record.checking || !record.candidate || !record.handle || record.controller.signal.aborted) return
    record.checking = true
    try {
      const response = await fetch(record.candidate, { redirect: 'manual', signal: AbortSignal.any([
        record.controller.signal, AbortSignal.timeout(1500),
      ]) })
      await response.body?.cancel()
      if (record.controller.signal.aborted) return
      if (response.status >= 400) throw new Error('Server returned HTTP ' + response.status)
      const changed = record.url !== record.candidate
      record.status = 'ready'; record.error = ''; record.url = record.candidate
      if (changed) intents.publish({ kind: 'url', url: record.url, sessionId: record.sessionId, managed: true })
    } catch (error) {
      if (!record.controller.signal.aborted) {
        record.status = 'starting'
        record.error = error.message.startsWith('Server returned') ? error.message : 'Waiting for the server to answer HTTP requests.'
      }
    } finally { record.checking = false }
  }

  async function start (request) {
    const config = await validate(request)
    if (disposed) throw failure(503, 'Preview is shutting down.')
    if ([...records.values()].filter(r => r.handle).length >= max) throw failure(429, 'Stop another preview server first (limit ' + max + ').')
    if (!ctx.subprocess?.spawn) throw failure(503, 'Process service is unavailable.')
    const record = { ...config, sessionId: request.sessionId, status: 'starting', url: '', candidate: '',
      output: '', error: '', controller: new AbortController(), checking: false }
    // The command is intentionally a shell command supplied through the launch UI/tool.
    // The folder is separate argv metadata; never interpolate it into shell syntax.
    const handle = ctx.subprocess.spawn({ argv: ['/bin/sh', '-c', config.command], cwd: config.cwd,
      env: { FORCE_COLOR: '0', TERM: 'dumb' }, graceMs: 1500,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    record.handle = handle
    records.set(request.sessionId, record)
    for (const stream of [handle.stdout, handle.stderr]) {
      stream?.setEncoding('utf8')
      stream?.on('data', chunk => {
        record.output = clean(record.output + chunk).slice(-24 * 1024)
        // Prefer the latest complete line; split URL chunks are buffered above.
        const urls = record.output.split(/\r?\n/).slice(0, -1).map(localPreviewURL).filter(Boolean)
        if (urls.length) record.candidate = urls.at(-1)
        void check(record)
      })
    }
    const exited = error => {
      clearInterval(record.timer); record.controller.abort()
      if (record.status !== 'stopping' && record.status !== 'stopped') {
        intents.clearManaged?.(record.sessionId, record.url)
        record.status = 'exited'; record.url = ''
        record.error = error
        // Terminate descendants even when the launcher itself has already exited.
        handle.terminate()
        handle.waitForExit().then(() => { if (record.status === 'exited') record.handle = null }).catch(() => {})
      }
    }
    handle.done.then(result => exited('Launch command exited (' + (result.exitCode ?? result.signal) + ').'),
      error => exited('Could not launch server: ' + error.message))
    record.timer = setInterval(() => {
      if (!record.candidate) record.error = 'No local URL reported yet. The command must stay running and print its http://localhost:PORT address.'
      void check(record)
    }, 2000)
    record.timer.unref?.()
    return snapshot(record)
  }

  return {
    async read (id) { await sessionRoot(id); return snapshot(records.get(id)) },
    change (request) {
      if (!request || typeof request !== 'object') return Promise.reject(failure(400, 'Preview request must be an object.'))
      return enqueue(request.sessionId, async () => {
        await sessionRoot(request.sessionId)
        if (disposed) throw failure(503, 'Preview is shutting down.')
        const record = records.get(request.sessionId)
        if (request.action === 'stop') { await stop(record); return snapshot(record) }
        if (!['start', 'restart'].includes(request.action)) throw failure(400, 'Unknown preview action.')
        await validate(request) // Refuse bad configuration before stopping a working server.
        if (request.action === 'start' && record?.handle && !['stopped', 'exited'].includes(record.status)) return snapshot(record)
        await stop(record)
        return start(request)
      })
    },
    async dispose () {
      disposed = true
      await Promise.allSettled([...queues.values()])
      await Promise.allSettled([...records.values()].map(stop))
    },
  }
}
