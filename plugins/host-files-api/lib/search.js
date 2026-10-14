import { WorkspaceFileSearch } from '@deepseek-ai/dsh-file-reference-local/search'
import { join, sep } from 'node:path'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { containedPath } from './roots.js'

const MAX_RESULTS = 50
const MAX_ENTRIES = 50000
const CACHE_MS = 30000
const beneath = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const fail = (code, message) => Object.assign(new Error(message), { code })

// Reuse the harness's supported fuzzy index, independently of an agent/session.
// This owns its bounded cache and rechecks workspace containment on every query
// and every returned candidate. File contents are never part of this search.
export function createFileSearch(ctx) {
  const indexes = new Map()
  function drop(root) { indexes.get(root)?.search.dispose(); indexes.delete(root) }
  async function list(rawRoot, query, { signal = new AbortController().signal, refresh = false } = {}) {
    if (typeof query !== 'string' || query.length > 256 || query.includes('\0')) throw fail('SEARCH_INVALID', 'Use a file name or relative path of at most 256 characters')
    const contained = await containedPath(ctx, rawRoot)
    if (!contained) throw fail('FS_SANDBOX_DENIED', 'Outside the workspace')
    const root = contained.path
    const target = await ctx.fs.resolve(root)
    const info = await ctx.fs.stat(target)
    if (!info) throw fail('FS_NOT_FOUND', 'Workspace folder is missing')
    if (info.type !== 'directory') throw fail('SEARCH_INVALID', 'Search needs a workspace folder')
    // Report inaccessible roots honestly without enumerating a huge root on
    // every keystroke. Upstream traversal skips unreadable descendants.
    try { await access(root, constants.R_OK | constants.X_OK) }
    catch (error) {
      if (error.code === 'EACCES' || error.code === 'EPERM') throw fail('FS_PERMISSION_DENIED', 'Workspace folder is not readable')
      throw error
    }
    signal.throwIfAborted()
    if (refresh || (indexes.has(root) && Date.now() - indexes.get(root).created > CACHE_MS)) drop(root)
    let entry = indexes.get(root)
    if (!entry) {
      if (indexes.size >= 8) drop(indexes.keys().next().value)
      entry = { created: Date.now(), search: new WorkspaceFileSearch(root, {
        maxResults: MAX_RESULTS, maxEntries: MAX_ENTRIES, excludedDirectories: ['.git', 'node_modules'],
      }) }
      indexes.set(root, entry)
    }
    const candidates = await entry.search.list(query, signal)
    const entries = []
    for (const candidate of candidates) {
      signal.throwIfAborted()
      const path = join(root, candidate.path)
      const allowed = await containedPath(ctx, path)
      if (allowed && beneath(allowed.path, root)) {
        const current = await ctx.fs.stat(await ctx.fs.resolve(allowed.path))
        if (current?.type === candidate.kind) entries.push({ path: allowed.path, relativePath: candidate.path, type: candidate.kind })
      }
    }
    return { root, entries, maxResults: MAX_RESULTS, indexLimit: MAX_ENTRIES }
  }
  return {
    list,
    invalidate(path) { for (const root of indexes.keys()) if (beneath(path, root)) drop(root) },
    dispose() { for (const root of indexes.keys()) drop(root) },
  }
}
