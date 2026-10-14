import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { containedPath, isSensitiveHomePath, mediaReadPath } from '../lib/roots.js'

function fakeCtx (paths) {
  return { workspaceRegistry: { list: () => paths.map((path, i) => ({ id: `w${i}`, path, title: 'w' })) } }
}

async function scratch () {
  return realpath(await mkdtemp(join(tmpdir(), 'dshd-media-')))
}

test('mediaReadPath serves a home movie that containedPath refuses', async (t) => {
  const home = await scratch()
  const root = await scratch()
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]))
  const movie = join(home, 'Desktop')
  await mkdir(movie)
  const file = join(movie, 'clip.mp4')
  await writeFile(file, 'fake')

  assert.equal(await containedPath(fakeCtx([root]), file), null)
  const allowed = await mediaReadPath(fakeCtx([root]), file, { home })
  assert.equal(allowed.path, file)
  assert.equal(allowed.root, home)
})

test('mediaReadPath refuses secrets even with a media extension', async (t) => {
  const home = await scratch()
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, '.ssh')
  await mkdir(dir)
  const file = join(dir, 'note.mp4')
  await writeFile(file, 'no')
  assert.equal(await mediaReadPath(fakeCtx([]), file, { home }), null)
})

test('mediaReadPath refuses a non-media home file', async (t) => {
  const home = await scratch()
  t.after(() => rm(home, { recursive: true, force: true }))
  const file = join(home, 'secret.txt')
  await writeFile(file, 'no')
  assert.equal(await mediaReadPath(fakeCtx([]), file, { home }), null)
})

test('mediaReadPath refuses a symlink that escapes home', async (t) => {
  const home = await scratch()
  const other = await scratch()
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]))
  await writeFile(join(other, 'out.mp4'), 'no')
  await symlink(join(other, 'out.mp4'), join(home, 'link.mp4'))
  assert.equal(await mediaReadPath(fakeCtx([]), join(home, 'link.mp4'), { home }), null)
})

test('isSensitiveHomePath flags ssh, gcloud and keychains, not Desktop', () => {
  assert.equal(isSensitiveHomePath('/Users/someone/.ssh/id_rsa'), true)
  assert.equal(isSensitiveHomePath('/Users/someone/.config/gcloud/key.json'), true)
  assert.equal(isSensitiveHomePath('/Users/someone/Library/Keychains/login.keychain-db'), true)
  assert.equal(isSensitiveHomePath('/Users/someone/Desktop/a.mp4'), false)
})
