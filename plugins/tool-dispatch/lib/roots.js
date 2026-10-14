/**
 * The containment fence.
 *
 * `ctx.fs` reads are deliberately unfenced — `LocalFileSystem`'s own doc says
 * `cwd` is "a resolution default, NOT a containment boundary", so
 * `ctx.fs.resolve('/etc/passwd')` succeeds. Every route in this plugin therefore
 * has to decide for itself what it is willing to touch, and the answer is: the
 * directories the user has explicitly opened as workspaces, and nothing else.
 *
 * The check is realpath-based rather than string-based. A string prefix test on
 * the requested path is defeated by a symlink inside the workspace pointing
 * out of it; resolving the real path first means the link has to land back
 * inside a root to pass. For a path that does not exist yet — saving a new file
 * — the nearest existing ancestor is resolved instead, which is the same fence
 * one component up.
 */

import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, resolve as resolvePath, sep } from 'node:path'

/** Nothing outside these directories is readable or writable through this API. */
export function workspaceRoots (ctx) {
  const roots = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (typeof workspace.path === 'string' && workspace.path) roots.push(workspace.path)
  }
  // The harness is launched with the workspace as its cwd, so a session started
  // before any workspace record exists still has somewhere legitimate to browse.
  const cwd = process.cwd()
  if (!roots.includes(cwd)) roots.push(cwd)
  return roots
}

/** Is `candidate` the root itself, or beneath it? Never a sibling sharing a prefix. */
function beneath (candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep)
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
