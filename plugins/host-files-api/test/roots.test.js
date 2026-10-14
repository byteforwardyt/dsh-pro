import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { containedPath, workspaceRoots } from '../lib/roots.js'

/** A ctx with just the two surfaces the fence reads. */
function fakeCtx (paths) {
  return { workspaceRegistry: { list: () => paths.map((path, i) => ({ id: `w${i}`, path, title: 'w' })) } }
}

async function scratch () {
  const dir = await mkdtemp(join(tmpdir(), 'dshd-files-'))
  // macOS puts the real temp dir under /private; realpath it so the test
  // compares like with like.
  const { realpath } = await import('node:fs/promises')
  return realpath(dir)
}

test('admits a file inside the workspace', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'a.txt'), 'hi')

  const result = await containedPath(fakeCtx([root]), join(root, 'a.txt'))
  assert.equal(result.path, join(root, 'a.txt'))
  assert.equal(result.root, root)
})

test('refuses a path outside every root', async (t) => {
  const root = await scratch()
  const other = await scratch()
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]))
  await writeFile(join(other, 'secret.txt'), 'no')

  assert.equal(await containedPath(fakeCtx([root]), join(other, 'secret.txt')), null)
})

test('refuses traversal out of the workspace', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  const inner = join(root, 'inner')
  await mkdir(inner)

  assert.equal(await containedPath(fakeCtx([inner]), join(inner, '..', '..', 'etc', 'passwd')), null)
  assert.equal(await containedPath(fakeCtx([inner]), '/etc/passwd'), null)
})

test('refuses a symlink that points out of the workspace', async (t) => {
  // The case a string-prefix check gets wrong: the requested path is spelled
  // entirely inside the root, and resolves outside it.
  const root = await scratch()
  const other = await scratch()
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]))
  await writeFile(join(other, 'secret.txt'), 'no')
  await symlink(join(other, 'secret.txt'), join(root, 'link.txt'))

  assert.equal(await containedPath(fakeCtx([root]), join(root, 'link.txt')), null)
})

test('refuses a symlinked directory that escapes, even for a child path', async (t) => {
  const root = await scratch()
  const other = await scratch()
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]))
  await mkdir(join(other, 'deep'))
  await writeFile(join(other, 'deep', 'x.txt'), 'no')
  await symlink(other, join(root, 'out'))

  assert.equal(await containedPath(fakeCtx([root]), join(root, 'out', 'deep', 'x.txt')), null)
})

test('admits a file that does not exist yet, so a new file can be saved', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await containedPath(fakeCtx([root]), join(root, 'nested', 'new.txt'))
  assert.equal(result.path, join(root, 'nested', 'new.txt'))
  assert.equal(result.root, root)
})

test('refuses a nonexistent path outside the workspace', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.equal(await containedPath(fakeCtx([root]), '/nowhere/at/all/new.txt'), null)
})

test('refuses a sibling directory sharing the root name as a prefix', async (t) => {
  // `/tmp/work` must not admit `/tmp/work-secrets`.
  const base = await scratch()
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'work')
  const sibling = join(base, 'work-secrets')
  await mkdir(root)
  await mkdir(sibling)
  await writeFile(join(sibling, 's.txt'), 'no')

  assert.equal(await containedPath(fakeCtx([root]), join(sibling, 's.txt')), null)
})

test('refuses a NUL byte, which truncates at the syscall boundary', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))

  assert.equal(await containedPath(fakeCtx([root]), join(root, 'a.txt') + '\0.png'), null)
})

test('refuses empty and non-string paths', async () => {
  assert.equal(await containedPath(fakeCtx(['/tmp']), ''), null)
  assert.equal(await containedPath(fakeCtx(['/tmp']), null), null)
  assert.equal(await containedPath(fakeCtx(['/tmp']), 42), null)
})

test('always offers the harness cwd as a root', () => {
  assert.ok(workspaceRoots(fakeCtx([])).includes(process.cwd()))
})

test('live session folders are roots even without a workspace record', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'clip.mp4'), 'fake')
  const ctx = {
    ...fakeCtx([]),
    sessions: { list: () => [{ header: { cwd: root } }] },
  }
  assert.ok(workspaceRoots(ctx).includes(root))
  const admitted = await containedPath(ctx, join(root, 'clip.mp4'))
  assert.equal(admitted.path, join(root, 'clip.mp4'))
  assert.equal(admitted.root, root)
})

test('a sessions.list failure does not take down the fence', () => {
  const ctx = {
    ...fakeCtx([]),
    sessions: { list: () => { throw new Error('sessions unavailable') } },
  }
  assert.ok(workspaceRoots(ctx).includes(process.cwd()))
})

test('resolves a relative path against the first root rather than the process cwd', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'rel.txt'), 'hi')

  const result = await containedPath(fakeCtx([root]), 'rel.txt')
  assert.equal(result.path, join(root, 'rel.txt'))
})

test('the root itself is contained', async (t) => {
  const root = await scratch()
  t.after(() => rm(root, { recursive: true, force: true }))

  const result = await containedPath(fakeCtx([root]), root + sep)
  assert.equal(result.path, root)
})
