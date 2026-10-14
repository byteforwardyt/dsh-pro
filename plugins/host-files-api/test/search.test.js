import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, realpath, stat, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileSearch } from '../lib/search.js'

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-search-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'workspace'), outside = join(home, 'outside')
  await mkdir(root); await mkdir(outside)
  const roots = [root]
  const ctx = { workspaceRegistry: { list: () => roots.map(path => ({ path })) }, fs: {
    async resolve(path) { return { path } },
    async stat(target) {
      try { const info = await stat(target.path); return { type: info.isDirectory() ? 'directory' : 'file' } }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    },
  } }
  const search = createFileSearch(ctx); t.after(() => search.dispose())
  async function file(path, text = '') { const full = join(root, path); await mkdir(join(full, '..'), { recursive: true }); await writeFile(full, text); return full }
  return { root, outside, roots, search, file }
}

test('workspace search ranks names, narrows folders, and keeps source text out of results', async t => {
  const f = await fixture(t)
  await f.file('src/components/AccountPanel.tsx', 'private source contents')
  await f.file('src/account-utils.ts'); await f.file('space dir/écran.ts')
  await f.file('.env'); await f.file('node_modules/AccountPanel.tsx'); await f.file('.git/config')
  const found = await f.search.list(f.root, 'AccountPanel')
  assert.equal(found.entries[0].relativePath, 'src/components/AccountPanel.tsx')
  assert.equal(JSON.stringify(found).includes('private source contents'), false)
  assert.equal(found.entries.some(entry => entry.relativePath.startsWith('node_modules/')), false)
  assert.equal((await f.search.list(f.root, 'src/components/Acc')).entries[0].relativePath, 'src/components/AccountPanel.tsx')
  assert.equal((await f.search.list(f.root, 'space dir/écr')).entries[0].relativePath, 'space dir/écran.ts')
  assert.ok((await f.search.list(f.root, '.env')).entries.some(entry => entry.relativePath === '.env'))
  assert.equal((await f.search.list(f.root, 'node_modules/')).entries.length, 0)
})

test('search refreshes created files, drops deleted or escaped candidates, and revokes removed workspaces', async t => {
  const f = await fixture(t), file = await f.file('original.txt')
  await f.search.list(f.root, 'later')
  await f.file('later.txt')
  assert.equal((await f.search.list(f.root, 'later')).entries.length, 0)
  assert.equal((await f.search.list(f.root, 'later', { refresh: true })).entries[0].relativePath, 'later.txt')
  await rm(file); await writeFile(join(f.outside, 'private.txt'), 'outside')
  await symlink(join(f.outside, 'private.txt'), file)
  assert.equal((await f.search.list(f.root, 'original')).entries.length, 0)
  await rm(join(f.root, 'later.txt'))
  assert.equal((await f.search.list(f.root, 'later')).entries.length, 0)
  assert.equal((await f.search.list(f.root, '../outside/')).entries.length, 0)
  f.roots.length = 0
  await assert.rejects(f.search.list(f.root, 'original'), { code: 'FS_SANDBOX_DENIED' })
})

test('search refuses invalid, missing and unreadable roots and supports cancellation', async t => {
  const f = await fixture(t)
  await assert.rejects(f.search.list(f.root, 'x'.repeat(257)), { code: 'SEARCH_INVALID' })
  await assert.rejects(f.search.list(f.outside, ''), { code: 'FS_SANDBOX_DENIED' })
  await assert.rejects(f.search.list(join(f.root, 'missing'), ''), { code: 'FS_NOT_FOUND' })
  await f.file('file.txt')
  await assert.rejects(f.search.list(join(f.root, 'file.txt'), ''), { code: 'SEARCH_INVALID' })
  await chmod(f.root, 0)
  try { await assert.rejects(f.search.list(f.root, ''), { code: 'FS_PERMISSION_DENIED' }) }
  finally { await chmod(f.root, 0o700) }
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.search.list(f.root, 'file', { signal: controller.signal }), { name: 'AbortError' })
  assert.equal((await f.search.list(f.root, 'file')).entries[0].relativePath, 'file.txt')
})

test('search finds a nested exact match in a larger tree and bounds returned results', async t => {
  const f = await fixture(t)
  for (let batch = 0; batch < 30; batch++) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => f.file(`group-${batch}/module-${i}.txt`)))
  }
  await f.file('deep/nested/TargetModule.ts')
  const started = performance.now(), result = await f.search.list(f.root, 'TargetModule')
  assert.equal(result.entries[0].relativePath, 'deep/nested/TargetModule.ts')
  assert.equal((await f.search.list(f.root, 'module')).entries.length, 50)
  t.diagnostic(`3001-file search: ${Math.round(performance.now() - started)} ms including the second cached query`)
})
