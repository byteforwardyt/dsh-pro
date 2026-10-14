/**
 * HTTP surface for workspace files.
 *
 * The harness keeps a complete filesystem seam in the host process — `ctx.fs`
 * has resolve/stat/listDir/readText/writeText/editText with atomic writes and
 * version guards — and publishes none of it to the browser. What the browser
 * can reach today is `fileReferences/list`, which returns at most twenty
 * relative paths with no size and no metadata because it exists to back `@file`
 * autocomplete, and `host.listDirectory`, which returns directories only and is
 * unavailable on macOS anyway (the composed picker resolves to `native`, so the
 * apiproxy answers `directory-picker-unavailable`).
 *
 * So this plugin publishes the seam, fenced. Both fences are ours to build and
 * neither is optional:
 *
 *   - `isTrustedRequest` keeps other processes on this machine out. It is the
 *     same check `host-auth-api` uses; the note there explains why Host is the
 *     load-bearing header rather than Origin.
 *   - `containedPath` keeps this route inside the directories the user opened.
 *     `ctx.fs` reads are unfenced by design, so without it a byte route with a
 *     path parameter is a read of the entire disk.
 *
 * Routes (all under /dsh-files):
 *   GET  /roots            the workspaces this API will serve
 *   GET  /list?path=       one directory: name, type, size, per child
 *   GET  /search?root=&q=  bounded fuzzy file/folder lookup without a session
 *   GET  /read?path=       text content plus the version to write back against
 *   POST /write            {path, text, version?, createOnly?} guarded file write
 *   GET  /drafts           recovery metadata for available workspaces
 *   GET  /drafts/stream    progressive metadata scan (NDJSON)
 *   GET  /draft?path=      saved text and original file version
 *   POST /draft            {path, draft, revision} revision-guarded backup/clear
 *   GET  /raw?path=        the bytes, with Range — media and PDF src targets
 */

import { basename, dirname, sep } from 'node:path'
import { realpath, readFile } from 'node:fs/promises'

import { containedPath, mediaReadPath, workspaceRoots } from './roots.js'
import { StringDecoder } from 'node:string_decoder'
import { serveBytes } from './raw.js'
import { isTrustedRequest } from './trust.js'
import { probeServers, findEntries, startPreviewServer } from './preview.js'
import { createDraftStore } from './drafts.js'
import { streamDraftInventory } from './draft-inventory.js'
import { createFileSearch } from './search.js'
import { createPullRequests } from './pull-requests.js'
import { createGit } from './git.js'
import { createUploads } from './uploads.js'
import { createPreviewIntents } from './preview-intents.js'
import { previewTool } from './preview-tool.js'
import { createPreviewProjects } from './preview-projects.js'
import { previewServerTool } from './preview-server-tool.js'

const PREFIX = '/dsh-files'

/** Above this, the editor is the wrong tool and the browser is the wrong place. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** A write body larger than this is refused before it is parsed. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** A preview server unused for this long is closed and its port released. */
const PREVIEW_IDLE_MS = 10 * 60 * 1000

/** How often idle preview servers are swept. */
const PREVIEW_SWEEP_MS = 60 * 1000

/** Concurrent preview servers. Beyond this the least recently used is closed. */
const MAX_PREVIEW_SERVERS = 32

export const inject = ['webServer', 'fs', 'workspaceRegistry', 'sessions', 'sessionPersistence', 'tools', 'subprocess']

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
 * Read a JSON request body.
 *
 * Decoded through a StringDecoder rather than `raw += chunk`, which is a
 * silent data-loss bug and not a theoretical one: concatenation decodes each
 * Buffer independently, so a multi-byte character straddling a chunk boundary
 * becomes replacement characters. An audit sent 'café — naïve 日本語 🎬' split
 * inside the three bytes of 日 and the server stored '���本語' — and answered
 * 200 with a fresh version string, so the editor believed the save succeeded.
 * A 2 MB text limit guarantees chunking, which is why this presented as files
 * corrupting at random rather than never working.
 *
 * The cap counts bytes. `raw.length` counted UTF-16 code units, which let a
 * body up to three times the stated limit through.
 *
 * Both failures reject with a status, because the previous rejections reached
 * the route's generic handler and surfaced as 500 "file operation failed" —
 * blaming the filesystem for what the client sent.
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

/** Directories first, then files, each case-insensitively by name. */
function byKindThenName (a, b) {
  if ((a.type === 'directory') !== (b.type === 'directory')) return a.type === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
}

export function apply (ctx) {
  const drafts = createDraftStore(process.env.DSH_HOME)
  const inventoryLifetime = new AbortController()
  const fileSearch = createFileSearch(ctx)
  const pullRequests = createPullRequests(ctx)
  const git = createGit(ctx)
  const uploads = createUploads(ctx)
  // Created before the handler so the /preview/events route always has a
  // registry to attach to, even if tool registration is unavailable.
  const previewIntents = createPreviewIntents()
  const previewProjects = createPreviewProjects(ctx, previewIntents)
  const handler = async (req, res) => {
    if (!isTrustedRequest(req)) return json(res, 403, { error: 'cross-origin request refused' })

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    try {
      if (route === '/preview/panel.js' && method === 'GET') {
        const source = await readFile(new URL('./preview-panel.js', import.meta.url))
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
        return res.end(source)
      }
      if (route === '/preview/server' && ['GET', 'POST'].includes(method)) {
        if (method === 'GET') return json(res, 200, await previewProjects.read(url.searchParams.get('sessionId')))
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'JSON required' })
        return json(res, 200, await previewProjects.change(await readJson(req)))
      }
      if (route === '/upload' && method === 'POST') {
        try { return json(res, 201, await uploads.receive(req, url.searchParams.get('root'), url.searchParams.get('name'))) }
        catch (error) { if (error.status) return json(res, error.status, { error: error.message }); throw error }
      }
      if (route === '/git' && ['GET', 'POST'].includes(method)) {
        try {
          if (method === 'POST' && !String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'JSON required' })
          return json(res, 200, method === 'GET' ? await git.read(url.searchParams.get('root')) : await git.change(await readJson(req)))
        } catch (error) {
          if (error.status) return json(res, error.status, { error: error.message, code: error.code })
          throw error
        }
      }
      if (route === '/pull-requests' && method === 'GET') {
        try {
          return json(res, 200, await pullRequests.list(url.searchParams.get('root'), url.searchParams.get('state') || 'open'))
        } catch (error) {
          if ([400, 403].includes(error.status)) return json(res, error.status, { error: error.message })
          throw error
        }
      }
      if (route === '/search' && method === 'GET') {
        const controller = new AbortController()
        const cancel = () => controller.abort()
        req.once('aborted', cancel); res.once('close', cancel)
        const deadline = setTimeout(cancel, 5000)
        try {
          const result = await fileSearch.list(url.searchParams.get('root'), url.searchParams.get('q') || '', {
            signal: controller.signal, refresh: url.searchParams.get('refresh') === '1',
          })
          if (!res.destroyed) return json(res, 200, result)
        } catch (error) {
          if (controller.signal.aborted) {
            if (!res.destroyed) return json(res, 503, { error: 'File search timed out. Try a folder path or refresh.' })
            return
          }
          throw error
        } finally { clearTimeout(deadline); req.off('aborted', cancel); res.off('close', cancel) }
        return
      }
      if (route === '/drafts/stream' && method === 'GET') {
        return await streamDraftInventory(req, res, drafts, ctx, inventoryLifetime.signal)
      }
      if (route === '/drafts' && method === 'GET') {
        const inventory = await drafts.list()
        const visible = []
        for (const entry of inventory.drafts) {
          const contained = await containedPath(ctx, entry.path)
          if (contained?.path === entry.path) visible.push({ ...entry, root: contained.root })
        }
        return json(res, 200, { drafts: visible, unreadable: inventory.unreadable })
      }
      if (route === '/draft' && (method === 'GET' || method === 'POST')) {
        const body = method === 'POST' ? await readJson(req) : null
        const contained = await containedPath(ctx, body?.path ?? url.searchParams.get('path'))
        if (!contained) return json(res, 403, { error: 'outside the workspace' })
        if (method === 'GET') return json(res, 200, { draft: await drafts.read(contained.path) })
        if (!(body.revision === null || typeof body.revision === 'string') || !Object.hasOwn(body, 'draft')) {
          return json(res, 400, { error: 'draft and revision are required' })
        }
        const draft = await drafts.replace(contained.path, body.draft, body.revision)
        return json(res, 200, { revision: draft?.revision ?? null })
      }

      if (route === '/roots' && method === 'GET') {
        const items = ctx.workspaceRegistry.list().map((workspace) => ({
          id: String(workspace.id),
          path: workspace.path,
          title: workspace.title,
        }))
        // The harness cwd is browsable even with no workspace record, so it is
        // reported too rather than leaving the view empty on a fresh install.
        const known = new Set(items.map((item) => item.path))
        for (const root of workspaceRoots(ctx)) {
          if (!known.has(root)) items.push({ id: `cwd:${root}`, path: root, title: basename(root) || root })
        }
        // Keep the registry path for existing consumers, and expose the same
        // identity used by list/read/draft for clients retaining file state.
        const resolved = await Promise.all(items.map(async item => ({ ...item,
          canonicalPath: await realpath(item.path).catch(() => null),
        })))
        return json(res, 200, { roots: resolved })
      }

      if (route === '/list' && method === 'GET') {
        const contained = await containedPath(ctx, url.searchParams.get('path'))
        if (!contained) return json(res, 403, { error: 'outside the workspace' })

        const target = await ctx.fs.resolve(contained.path)
        const info = await ctx.fs.stat(target)
        if (info === undefined) return json(res, 404, { error: 'not found' })
        if (info.type !== 'directory') return json(res, 400, { error: 'not a directory' })

        const children = await ctx.fs.listDir(target)
        const entries = children.map((child) => ({
          name: child.name,
          type: child.type,
          size: child.size ?? null,
          path: contained.path.endsWith(sep)
            ? contained.path + child.name
            : contained.path + sep + child.name,
        })).sort(byKindThenName)

        const parent = dirname(contained.path)
        return json(res, 200, {
          path: contained.path,
          root: contained.root,
          // A parent above the root is not offered, so the view cannot navigate
          // somewhere the next request would refuse to list.
          parent: contained.path === contained.root || parent === contained.path ? null : parent,
          entries,
        })
      }

      if (route === '/read' && method === 'GET') {
        const contained = await containedPath(ctx, url.searchParams.get('path'))
        if (!contained) return json(res, 403, { error: 'outside the workspace' })

        const target = await ctx.fs.resolve(contained.path)
        const info = await ctx.fs.stat(target)
        if (info === undefined) return json(res, 404, { error: 'not found' })
        if (info.type === 'directory') return json(res, 400, { error: 'is a directory' })

        const size = info.size ?? 0
        if (size > MAX_TEXT_BYTES) {
          return json(res, 200, { kind: 'too-large', path: contained.path, size })
        }

        try {
          const text = await ctx.fs.readText(target)
          return json(res, 200, {
            kind: 'text',
            path: contained.path,
            text,
            version: String(info.version),
            size,
          })
        } catch (error) {
          // FS_NOT_TEXT is the seam telling us this is not UTF-8. That is an
          // answer, not a failure: the view switches to a media or binary
          // presentation on it.
          if (error?.code === 'FS_NOT_TEXT') {
            return json(res, 200, { kind: 'binary', path: contained.path, size })
          }
          throw error
        }
      }

      if (route === '/write' && method === 'POST') {
        const body = await readJson(req)
        const contained = await containedPath(ctx, body?.path)
        if (!contained) return json(res, 403, { error: 'outside the workspace' })
        if (typeof body?.text !== 'string') return json(res, 400, { error: 'text must be a string' })
        if (Object.hasOwn(body, 'createOnly') && typeof body.createOnly !== 'boolean') return json(res, 400, { error: 'createOnly must be a boolean' })
        if (body.createOnly && body.version !== undefined) return json(res, 400, { error: 'createOnly cannot be combined with a version' })

        const target = await ctx.fs.resolve(contained.path)
        // A version turns the write into a guarded replacement, which is what
        // makes concurrent editing safe: the agent runs in this same workspace
        // and can rewrite a file while it is open here. Without the guard the
        // last writer wins silently; with it, the save fails loudly and the
        // view can say what happened.
        const expected = body.createOnly ? { kind: 'createIfAbsent' } : typeof body.version === 'string' && body.version
          ? { kind: 'replaceIfVersion', version: body.version }
          : undefined

        try {
          const outcome = await ctx.fs.writeText(
            target, body.text, expected, undefined,
            { mode: 'workspace-write', workspaceRoot: contained.root },
          )
          fileSearch.invalidate(contained.path)
          return json(res, 200, {
            path: contained.path,
            operation: outcome.operation,
            version: String(outcome.version),
          })
        } catch (error) {
          if (error?.code === 'FS_STALE_VERSION' || (body.createOnly && error?.code === 'FS_NOT_OBSERVED')) {
            // This read is only UI context. Recreate still uses the filesystem's
            // atomic createIfAbsent guard, never a check-then-unconditional-write.
            let missing = false
            try { missing = await ctx.fs.stat(target) === undefined } catch { /* retain the original conflict */ }
            return json(res, 409, { error: missing ? 'file no longer exists' : 'changed on disk', code: 'FS_STALE_VERSION', missing })
          }
          throw error
        }
      }

      if (route === '/raw' && (method === 'GET' || method === 'HEAD')) {
        // Workspace files first; playable files under $HOME next. list/read/write
        // stay on containedPath, so admitting a Desktop movie never opens the
        // rest of the home directory to the editor.
        const readable = await mediaReadPath(ctx, url.searchParams.get('path'))
        if (!readable) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('outside the workspace')
          return
        }
        return await serveBytes(req, res, readable.path)
      }

      if (route === '/preview/open' && method === 'GET') {
        const contained = await containedPath(ctx, url.searchParams.get('path'))
        if (!contained) return json(res, 403, { error: 'outside the workspace' })
        if (!/\.html?$/i.test(contained.path)) return json(res, 400, { error: 'Choose an HTML file; other apps need a dev server.' })
        const info = await ctx.fs.stat(await ctx.fs.resolve(contained.path))
        if (!info || info.type !== 'file') return json(res, 404, { error: 'HTML file not found' })
        const directory = dirname(contained.path)
        if (!pageServers.has(directory)) {
          if (pageServers.size >= MAX_PREVIEW_SERVERS && !releaseIdlePreview()) {
            return json(res, 503, { error: 'Too many preview folders open at once. Close one and try again.' })
          }
          const pending = startPreviewServer(ctx, directory, () => pageServerSeen.set(directory, Date.now())).then((value) => {
            if (previewClosed) value.server?.close()
            return value
          })
          pageServers.set(directory, pending)
        }
        pageServerSeen.set(directory, Date.now())
        const pageServer = await pageServers.get(directory)
        if (!pageServer.port || previewClosed) {
          pageServers.delete(directory)
          pageServerSeen.delete(directory)
          return json(res, 503, { error: 'Could not start a preview for this folder' })
        }
        const previewOrigin = `http://127.0.0.1:${pageServer.port}`
        return json(res, 200, { previewOrigin, url: previewOrigin + '/' + encodeURIComponent(basename(contained.path)) })
      }

      if (route === '/preview/events' && method === 'GET') {
        previewIntents.subscribe(req, res)
        return undefined
      }

      if (route === '/preview/probe' && method === 'GET') {
        // Which common dev-server ports are answering, and which HTML files
        // the workspace holds — so the Preview tab can offer a live server or
        // a built-but-unserved page instead of a fixed guess. previewOrigin is
        // the separate-origin server that renders workspace HTML.
        //
        // `root` scopes the file half to the conversation's own workspace. It
        // goes through the containment fence like any other client-supplied
        // path: a scan is a directory listing, so an unfenced root here would
        // enumerate HTML anywhere on the disk. A root outside every workspace
        // falls back to the unscoped walk rather than failing the whole scan,
        // because the ports half is still useful and the pane's job is to keep
        // working.
        const requestedRoot = url.searchParams.get('root')
        const scope = requestedRoot ? await containedPath(ctx, requestedRoot) : null
        const [ports, entries] = await Promise.all([probeServers(), findEntries(ctx, 25, scope?.path ?? null)])
        return json(res, 200, {
          ports,
          entries: entries.map((e) => ({ name: e.name, path: e.path, rel: e.rel, needsServer: e.needsServer })),
          previewOrigin: previewInfo?.port ? `http://127.0.0.1:${previewInfo.port}` : null,
          scoped: Boolean(scope),
        })
      }

      return json(res, 404, { error: 'no such route' })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : undefined
      // A client-side fault the body reader already classified. Without this it
      // fell through to the 500 below and read as a server failure.
      if (typeof error?.status === 'number') return json(res, error.status, { error: error.message })
      if (code === 'SEARCH_INVALID') return json(res, 400, { error: error.message, code })
      if (code === 'DRAFT_INVALID') return json(res, 400, { error: error.message, code })
      if (code === 'DRAFT_CONFLICT' || code === 'DRAFT_CORRUPT') return json(res, 409, { error: error.message, code })
      if (code === 'DRAFT_UNAVAILABLE') return json(res, 503, { error: error.message, code })
      if (code === 'FS_NOT_FOUND') return json(res, 404, { error: 'not found', code })
      if (code === 'FS_PERMISSION_DENIED' || code === 'FS_SANDBOX_DENIED') {
        return json(res, 403, { error: 'refused', code })
      }
      if (code === 'FS_TOO_LARGE') return json(res, 413, { error: 'too large', code })
      ctx.logger?.warn?.('files-api: %s', error?.message ?? error)
      return json(res, 500, { error: 'file operation failed', code })
    }
  }

  // The separate-origin server for workspace HTML. Started once; its port is
  // reported to the client through /preview/probe. A failure to bind is not
  // fatal — the probe simply reports no preview origin and live dev servers
  // still work.
  const pageServers = new Map()
  // Last time each folder's server answered a request. A preview server holds a
  // listening socket and file descriptors, and previously nothing ever closed
  // one: opening three folders left three listeners for the life of the
  // process, and the 33rd told the user to restart the app. Both the idle sweep
  // and the capacity eviction read this map.
  const pageServerSeen = new Map()
  let previewInfo = null
  let previewClosed = false

  /** Close the least recently used preview server. False when none can go. */
  function releaseIdlePreview () {
    let oldest = null
    let oldestAt = Infinity
    for (const directory of pageServers.keys()) {
      const at = pageServerSeen.get(directory) ?? 0
      if (at < oldestAt) { oldest = directory; oldestAt = at }
    }
    // A server touched in the last few seconds is very likely the pane the user
    // is looking at. Refusing is better than yanking a live preview.
    if (oldest === null || Date.now() - oldestAt < 5000) return false
    closePreview(oldest)
    return true
  }

  function closePreview (directory) {
    const pending = pageServers.get(directory)
    pageServers.delete(directory)
    pageServerSeen.delete(directory)
    pending?.then((value) => value.server?.close()).catch(() => {})
  }

  const previewSweep = setInterval(() => {
    const now = Date.now()
    for (const directory of [...pageServers.keys()]) {
      if (now - (pageServerSeen.get(directory) ?? now) > PREVIEW_IDLE_MS) closePreview(directory)
    }
  }, PREVIEW_SWEEP_MS)
  // Nothing here should keep the harness alive on its own.
  previewSweep.unref?.()

  startPreviewServer(ctx).then((info) => {
    // info.server is null when the bind failed — a non-fatal absence.
    if (previewClosed) { info.server?.close(); return }
    previewInfo = info
  }).catch((error) => { ctx.logger?.warn?.('files-api preview server: %s', error?.message ?? error) })

  const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })

  // The agent-facing half of Preview. Guarded because this plugin is applied
  // in tests with a context that carries only the services those tests need,
  // and a missing tool registry is not a reason to lose the HTTP surface.
  if (typeof ctx.tools?.register === 'function') {
    ctx.tools.register(previewTool(ctx, previewIntents))
    ctx.tools.register(previewServerTool(previewProjects))
  }

  ctx.on('dispose', () => {
    dispose()
    fileSearch.dispose()
    inventoryLifetime.abort()
    previewIntents.dispose()
    previewClosed = true
    clearInterval(previewSweep)
    if (previewInfo?.server) previewInfo.server.close()
    for (const pending of pageServers.values()) pending.then((value) => value.server?.close())
    pageServers.clear()
    pageServerSeen.clear()
    return previewProjects.dispose()
  })
}
