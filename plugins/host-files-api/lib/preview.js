/**
 * Preview intelligence: find what is worth previewing, and serve workspace
 * HTML from an origin that cannot touch the app.
 *
 * The Preview tab used to open a bare localhost:3000 and, when nothing was
 * there, show only "returned no authorization code" — because the user had
 * built a static site the agent wrote to disk but never started a server for.
 * Two capabilities fix that:
 *
 *   probeServers()  — which common dev-server ports are actually answering,
 *                     so the empty state can offer live ones instead of a
 *                     fixed guess.
 *   findEntries()   — HTML files in the open workspace (index.html first),
 *                     so a site that was written but not served can still be
 *                     previewed.
 *
 * The second half raises a real hazard: a workspace page served on the APP's
 * origin could drive the agent. That is why workspace HTML is served by a
 * SEPARATE http server on its own loopback port — a different origin,
 * firewalled from the app's API by the browser's same-origin policy, sandboxed
 * by CSP, and scoped to the workspace roots by the same realpath fence the file
 * routes use. The app's API additionally requires the shell's capability
 * cookie, which preview guests run in their own partition and never receive,
 * so the separation holds even if a browser's origin handling does not.
 *
 * This server carries no capability of its own — it has to stay loadable in an
 * iframe on a different port — so it fences on Host instead. See the request
 * handler for why that is both necessary and sufficient here.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, relative, isAbsolute } from 'node:path'

import { containedPath, workspaceRoots } from './roots.js'
import { hasLoopbackHost } from './trust.js'
import { contentTypeFor } from './mime.js'

/** Dev-server ports worth probing, in the order frameworks tend to pick them. */
const CANDIDATE_PORTS = [
  3000, 3001, 3002, 3003, 3004,
  4173, 4174, 4175, 4176, 4177, 4178, 4179,
  5173, 5174, 5175, 5176, 5177, 5178, 5179,
  8080, 4321, 5000, 8000, 4200, 1420, 8788,
]

/** Is something listening on this loopback port? A connect that opens = yes. */
function portAnswers (port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (answer) => { if (!done) { done = true; socket.destroy(); resolve(answer) } }
    socket.setTimeout(400)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** Which candidate ports are live right now. */
export async function probeServers () {
  const results = await Promise.all(CANDIDATE_PORTS.map(async (port) => ({
    port,
    live: await portAnswers(port),
  })))
  return results.filter((r) => r.live).map((r) => r.port)
}

/**
 * HTML entry points in the workspace, index.html first, then by depth so a
 * top-level page outranks a buried one. Bounded: this walks the tree but stops
 * at a fixed budget so a giant repo cannot stall the probe.
 *
 * `scope` narrows the walk to one already-fenced directory. A conversation is
 * bound to a single workspace, so previewing from a chat has to see that
 * workspace rather than every folder the app happens to have open — otherwise
 * the tab offers pages from an unrelated project and the user opens something
 * that has nothing to do with the session they are in. The caller is
 * responsible for passing a path that already cleared the containment fence;
 * an absent scope keeps the original every-root behaviour.
 */
export async function findEntries (ctx, limit = 25, scope = null) {
  const roots = scope ? [scope] : workspaceRoots(ctx)
  const found = []
  const seen = new Set()
  const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage', '.codegraph'])
  let budget = 4000

  const relTo = (root, abs) => {
    const base = root.replace(/\/+$/, '')
    return abs === base ? '' : abs.slice(base.length + 1)
  }

  const walk = async (dir, depth, root) => {
    if (budget <= 0 || depth > 6 || found.length >= limit) return
    let entries
    try {
      const target = await ctx.fs.resolve(dir)
      entries = await ctx.fs.listDir(target)
    } catch { return }
    // Source index.html beside a package.json is normally a Vite/React/etc.
    // entry point, not a standalone page. Serving it as static HTML produces
    // the white or unstyled game the user reported: its module imports need
    // the project's dev server. Still list it, but never auto-open it.
    const needsServer = entries.some((entry) => entry.type === 'file' && entry.name === 'package.json')
    for (const entry of entries) {
      if (budget <= 0 || found.length >= limit) return
      budget -= 1
      const childPath = dir.endsWith('/') ? dir + entry.name : dir + '/' + entry.name
      if (entry.type === 'directory') {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) await walk(childPath, depth + 1, root)
      } else if (/\.html?$/i.test(entry.name)) {
        if (seen.has(childPath)) continue
        seen.add(childPath)
        found.push({ path: childPath, name: entry.name, depth, root, rel: relTo(root, childPath), needsServer })
      }
    }
  }

  for (const root of roots) await walk(root, 0, root)
  found.sort((a, b) => {
    const isIndex = (n) => n === 'index.html' || n === 'index.htm'
    const ai = isIndex(a.name.toLowerCase()) ? 0 : 1
    const bi = isIndex(b.name.toLowerCase()) ? 0 : 1
    if (ai !== bi) return ai - bi
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.path.localeCompare(b.path)
  })
  return found.slice(0, limit)
}

/**
 * A static file server for workspace HTML, on its own loopback port.
 *
 * Deliberately a different origin from the app: the browser's same-origin
 * policy is then what stops a previewed page from reaching the app's API,
 * rather than trusting the page not to try. Every path is run through the same
 * realpath containment fence the file routes use, so a `../` or a symlink
 * cannot escape the workspace, and a strict CSP sandboxes whatever runs.
 *
 * `documentRoot` scopes it to one folder. The always-on instance is started
 * without one, and then its document root is every open workspace — which is
 * what makes the Host fence below load-bearing rather than decorative.
 *
 * `onActivity` is called on every request the fence admits, so the caller can
 * release servers that have gone idle. Without it these accumulate one per
 * distinct folder for the life of the process.
 */
export function startPreviewServer (ctx, documentRoot = null, onActivity = null) {
  const notFound = (res, message) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(message)
  }

  const server = createServer(async (req, res) => {
    // DNS-rebinding fence.
    //
    // "Different origin from the app" is not the same as "safe for anyone to
    // read", and this server has no other credential by design. An audit made
    // the point concretely: GET /.env with `Host: evil.com` returned a
    // workspace file in full, while the identical request to the app's API was
    // refused. An attacker page that rebinds a name it controls to 127.0.0.1
    // becomes same-origin with this server and can read the response body of
    // any file in any open workspace — the exact attack trust.js names as the
    // reason Host is the load-bearing check there.
    //
    // Host is sufficient because a browser sends the name it resolved, not the
    // address behind it: the iframe always addresses us as 127.0.0.1:<port>,
    // and a rebound page structurally cannot. It costs the pane nothing, which
    // is why this is a fence rather than a redesign.
    if (!hasLoopbackHost(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('refused')
      return
    }
    onActivity?.()

    let rel
    try {
      // The path is the URL pathname resolved against the workspace roots, so a
      // page's own relative assets (/assets/app.css) resolve the same way its
      // markup expects. decodeURIComponent throws on a malformed percent triple
      // (%c0%af, %ff), and a browser passes those through unchanged — so the
      // sandboxed page this very server hosts could send one. Left unguarded in
      // an async handler that becomes an unhandled rejection, and the harness
      // child exits: a one-line remote crash from exactly the content the
      // sandbox exists to contain. Guarded, it is a 400.
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).replace(/^\/+/, '')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('bad request')
      return
    }

    try {
      // Each root is tried until one holds the file — the ordinary single-root
      // case exactly, deterministic for more. A directory (the root itself for
      // "/", or any folder path) falls back to its index.html, because
      // http://127.0.0.1:<port>/ is the URL people naturally type and share —
      // 404ing the root while serving /index.html read as a white screen.
      let served = null
      for (const root of documentRoot ? [documentRoot] : workspaceRoots(ctx)) {
        const candidate = rel ? root.replace(/\/+$/, '') + '/' + rel : root
        const contained = await containedPath(ctx, candidate)
        if (!contained) continue
        const inside = relative(root, contained.path)
        if (documentRoot && (inside === '..' || inside.startsWith('../') || isAbsolute(inside))) continue
        let info
        try { info = await stat(contained.path) } catch { continue }
        if (info.isFile()) { served = contained.path; break }
        if (info.isDirectory()) {
          // Try index.html then index.htm — the picker advertises both, so a
          // site with only index.htm must not 404 at its root.
          const base = contained.path.replace(/\/+$/, '')
          let picked = null
          for (const name of ['/index.html', '/index.htm']) {
            const index = await containedPath(ctx, base + name)
            if (!index) continue
            const indexRel = relative(root, index.path)
            if (documentRoot && (indexRel === '..' || indexRel.startsWith('../') || isAbsolute(indexRel))) continue
            try {
              if ((await stat(index.path)).isFile()) { picked = index.path; break }
            } catch { /* try the next candidate */ }
          }
          if (picked) { served = picked; break }
        }
      }
      if (!served) return notFound(res, 'not found in the workspace')

      res.writeHead(200, {
        'content-type': contentTypeFor(basename(served)),
        'cache-control': 'no-store',
        // The page runs, but walled: it is its own opaque origin (so the app's
        // API is cross-origin and unreachable), scripts and forms allowed for a
        // real preview, no top-level navigation away.
        'content-security-policy': "sandbox allow-scripts allow-forms allow-popups",
      })
      const stream = createReadStream(served)
      // The res 'close' listener is the only thing that destroys the stream on a
      // client abort. If the client already disconnected during the awaits
      // above, 'close' fired before this line, so check once explicitly — else
      // one file descriptor leaks per aborted request.
      if (res.writableEnded || res.destroyed) { stream.destroy(); return }
      res.on('close', () => stream.destroy())
      stream.on('error', () => { if (!res.writableEnded) res.destroy() })
      stream.pipe(res)
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('preview error')
      } else if (!res.writableEnded) {
        res.destroy()
      }
    }
  })

  return new Promise((resolve) => {
    // A bind failure (EADDRINUSE, EACCES, or fd exhaustion after the agent has
    // spawned many processes) emits 'error'; with no listener Node re-throws it
    // as an uncaught exception and the harness child dies. Caught here, the
    // preview server is simply absent — live dev servers still work and the
    // probe reports no preview origin, which is the documented contract.
    let settled = false
    server.once('error', () => {
      if (settled) return
      settled = true
      resolve({ server: null, port: null })
    })
    // Port 0: the OS picks. This server's whole point is to be a DIFFERENT
    // origin from the app, so a stable port would be a liability, not a help.
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      if (settled) return
      settled = true
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : null })
    })
  })
}
