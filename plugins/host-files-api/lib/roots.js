/**
 * The containment fence.
 *
 * `ctx.fs` reads are deliberately unfenced — `LocalFileSystem`'s own doc says
 * `cwd` is "a resolution default, NOT a containment boundary", so
 * `ctx.fs.resolve('/etc/passwd')` succeeds. Every route in this plugin therefore
 * has to decide for itself what it is willing to touch, and the answer is: the
 * directories the user has explicitly opened as workspaces, and nothing else.
 * Live session folders are treated the same way: a conversation the user is
 * already in has a cwd they chose, and Git/Files should not pretend that
 * folder is closed until they click Reopen.
 *
 * The check is realpath-based rather than string-based. A string prefix test on
 * the requested path is defeated by a symlink inside the workspace pointing
 * out of it; resolving the real path first means the link has to land back
 * inside a root to pass. For a path that does not exist yet — saving a new file
 * — the nearest existing ancestor is resolved instead, which is the same fence
 * one component up.
 */

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'

import { contentTypeFor, isRenderable } from './mime.js'

/** Nothing outside these directories is readable or writable through this API. */
export function workspaceRoots (ctx) {
  const roots = []
  const seen = new Set()
  const add = (path) => {
    if (typeof path !== 'string' || !path || path === sep || seen.has(path)) return
    seen.add(path)
    roots.push(path)
  }
  for (const workspace of ctx.workspaceRegistry.list()) add(workspace.path)
  // The harness is launched with the workspace as its cwd, so a session started
  // before any workspace record exists still has somewhere legitimate to browse.
  add(process.cwd())
  // Live conversations already named a folder. Admitting that cwd here is what
  // lets Git, Files and media work after a relaunch without silently calling
  // workspaces.create (which the inspector recovery tests forbid on mount).
  try {
    const list = ctx.sessions && typeof ctx.sessions.list === 'function' ? ctx.sessions.list() : []
    for (const session of Array.isArray(list) ? list : []) {
      add(session?.header?.cwd ?? session?.cwd)
    }
  } catch {
    // A sessions service that throws must not take down every file route.
  }
  return roots
}

/** Is `candidate` the root itself, or beneath it? Never a sibling sharing a prefix. */
function beneath (candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
}

const SENSITIVE_HOME_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.kube', '.docker'])

/** Home directories that must never be readable through the media shortcut. */
export function isSensitiveHomePath (real) {
  const parts = String(real || '').split(sep)
  if (parts.some((part) => SENSITIVE_HOME_DIRS.has(part))) return true
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === '.config' && parts[i + 1] === 'gcloud') return true
    if (parts[i] === 'Library' && parts[i + 1] === 'Keychains') return true
  }
  return false
}

/**
 * Types the home-media shortcut will serve. SVG is excluded because the byte
 * route would still name it image/svg+xml, and a home file is not a workspace
 * the user explicitly opened.
 */
function isHomeMediaType (type) {
  return isRenderable(type) && type !== 'image/svg+xml'
}

/**
 * Read-only media from the user's home, used only by GET/HEAD /raw.
 *
 * Chat cards often name a Desktop or Movies copy that is outside every opened
 * workspace. Admitting those paths through `containedPath` would also open
 * list/read/write on the whole home directory. This helper is the narrower
 * door: the file must already exist, must be a browser-playable type, must
 * realpath back under $HOME, and must not sit in a secrets directory.
 *
 * `home` is injectable so tests do not write into the real profile.
 */
export async function mediaReadPath (ctx, raw, { home = homedir() } = {}) {
  const contained = await containedPath(ctx, raw)
  if (contained) return contained
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || !isAbsolute(raw)) return null
  if (!isHomeMediaType(contentTypeFor(basename(raw)))) return null

  let real
  let realHome
  try {
    real = await realpath(raw)
    realHome = await realpath(home)
  } catch {
    return null
  }
  if (!beneath(real, realHome) || isSensitiveHomePath(real)) return null
  return { path: real, root: realHome }
}

/**
 * Resolve the deepest ancestor of `target` that exists, and report how many
 * components had to be dropped to get there. A path whose parent chain is
 * entirely absent walks up to the filesystem root, where realpath always
 * succeeds — so the loop terminates without a separate guard.
 */
async function realpathOfNearestExisting (target) {
  let probe = target
  let dropped = 0
  for (;;) {
    try {
      return { real: await realpath(probe), dropped }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(probe)
      if (parent === probe) throw error
      probe = parent
      dropped += 1
    }
  }
}

/**
 * Turn a client-supplied path into one this process is willing to act on.
 *
 * @returns `{ path, root }` — the resolved absolute path and the workspace root
 *   that admitted it — or `null` when it falls outside every root. Callers
 *   answer a plain 403 for null and never echo the path back, because a
 *   distinguishable "outside the workspace" and "does not exist" pair is a
 *   directory oracle for the whole disk.
 *
 * `root` is not decoration: `ctx.fs` writes are fenced by a sandbox policy, and
 * the deployment default roots that policy at `process.cwd()` — which is the
 * harness's own working directory, not whichever workspace the user opened. A
 * write has to name its own root or it is denied for being in the wrong place.
 */
export async function containedPath (ctx, raw) {
  if (typeof raw !== 'string' || raw === '') return null
  // A NUL byte truncates the path at the syscall boundary, so a name that looks
  // contained here could open something else entirely.
  if (raw.includes('\0')) return null

  const roots = workspaceRoots(ctx)
  if (roots.length === 0) return null

  const absolute = isAbsolute(raw) ? resolvePath(raw) : resolvePath(roots[0], raw)

  let resolved
  try {
    resolved = await realpathOfNearestExisting(absolute)
  } catch {
    return null
  }

  // `dropped` components are names that do not exist yet. They cannot contain
  // `..` — resolvePath already collapsed those — so appending them back to a
  // contained real path stays contained.
  const tail = resolved.dropped === 0
    ? ''
    : absolute.slice(absolute.length - suffixLength(absolute, resolved.dropped))

  for (const root of roots) {
    let realRoot
    try { realRoot = await realpath(root) } catch { continue }
    if (beneath(resolved.real, realRoot)) return { path: resolved.real + tail, root: realRoot }
  }
  return null
}

/** Byte length of the last `count` path components of `absolute`, separators included. */
function suffixLength (absolute, count) {
  let index = absolute.length
  for (let i = 0; i < count; i += 1) {
    const cut = absolute.lastIndexOf(sep, index - 1)
    if (cut <= 0) return absolute.length
    index = cut
  }
  return absolute.length - index
}
