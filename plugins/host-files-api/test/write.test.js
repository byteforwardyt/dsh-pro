import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, writeFile, rm, realpath, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { apply } from '../lib/index.js'

// Resolve the actual filesystem shipped with the harness, including its atomic
// no-replace publication. A mock writeText cannot prove the recreation guard.
const shellRequire = createRequire(new URL('../../../shell/package.json', import.meta.url))
const harnessRequire = createRequire(shellRequire.resolve('@deepseek-ai/dsh/package.json'))
const filesystemModule = harnessRequire.resolve('@deepseek-ai/dsh-fs-local')
const { Context } = await import(createRequire(filesystemModule).resolve('@deepseek-ai/cordis'))
const { LocalFileSystem } = await import(filesystemModule)

test('registered Files API recreates deleted files without overwriting competing creations', async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-recreate-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const filesystem = new LocalFileSystem(new Context(), { cwd: home, diffBasisMaxBytes: 10 * 1024 * 1024 })
  let handler, dispose
  apply({ fs: filesystem, workspaceRegistry: { list: () => [{ path: home, title: 'Fixture' }] },
    webServer: { register(config) { handler = config.handler; return () => {} } },
    on(event, fn) { if (event === 'dispose') dispose = fn },
  })
  const server = createServer((req, res) => handler(req, res))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const path = join(home, 'recover.txt')
  const post = body => fetch(origin + '/dsh-files/write', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, ...body }) })
  await writeFile(path, 'Original')
  const baseline = await (await fetch(origin + '/dsh-files/read?path=' + encodeURIComponent(path))).json()
  await rm(path)
  const searchUrl = origin + '/dsh-files/search?root=' + encodeURIComponent(home) + '&q=recover'
  assert.equal((await (await fetch(searchUrl)).json()).entries.length, 0)
  const missing = await post({ text: 'Recovered', version: baseline.version })
  assert.equal(missing.status, 409); assert.equal((await missing.json()).missing, true)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  const recreated = await post({ text: 'Recovered', createOnly: true })
  assert.equal(recreated.status, 200); assert.equal((await recreated.json()).operation, 'create')
  assert.equal(await readFile(path, 'utf8'), 'Recovered')
  assert.equal((await (await fetch(searchUrl)).json()).entries[0].path, path, 'writes invalidate the existing search index')
  assert.equal((await fetch(searchUrl, { headers: { origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' } })).status, 403)
  const exists = await post({ text: 'Must not overwrite', createOnly: true })
  assert.equal(exists.status, 409); assert.equal((await exists.json()).missing, false)
  assert.equal(await readFile(path, 'utf8'), 'Recovered')

  await rm(path)
  let staged = false
  filesystem.internals.inspectTemp = async () => {
    staged = true
    await writeFile(path, 'Created during publication', { flag: 'wx' })
  }
  const race = await post({ text: 'Losing recreation', createOnly: true })
  assert.equal(race.status, 409); assert.equal(staged, true)
  assert.equal(await readFile(path, 'utf8'), 'Created during publication')
  assert.equal((await readdir(home)).some(name => name.endsWith('.tmpdir')), false)
  filesystem.internals.inspectTemp = undefined

  assert.equal((await post({ text: 'invalid', createOnly: 'true' })).status, 400)
  assert.equal((await post({ text: 'invalid', createOnly: true, version: baseline.version })).status, 400)
  const outside = await post({ path: join(home, '..', 'outside.txt'), text: 'refused', createOnly: true })
  assert.equal(outside.status, 403)
  assert.equal(await readFile(path, 'utf8'), 'Created during publication')
})
