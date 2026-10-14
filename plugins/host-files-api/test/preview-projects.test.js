import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createPreviewProjects, localPreviewURL } from '../lib/preview-projects.js'
import { previewServerTool } from '../lib/preview-server-tool.js'

const shellRequire = createRequire(new URL('../../../shell/package.json', import.meta.url))
const harnessRequire = createRequire(shellRequire.resolve('@deepseek-ai/dsh/package.json'))
const runtimePath = harnessRequire.resolve('@deepseek-ai/dsh-subprocess-local')
const { Context } = await import(createRequire(runtimePath).resolve('@deepseek-ai/cordis'))
const { LocalSubprocessRuntime } = await import(runtimePath)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function fixture (t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preview-projects-')))
  const context = new Context()
  const runtime = new LocalSubprocessRuntime(context)
  const events = []
  const sessions = ['one', 'two', 'three'].map(id => ({ header: { id, cwd: join(root, id) } }))
  for (const { header } of sessions) {
    await mkdir(header.cwd)
    await writeFile(join(header.cwd, 'server.cjs'), `const http=require('node:http');const s=http.createServer((q,r)=>r.end(${JSON.stringify(header.id)}));s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));`)
  }
  const ctx = { subprocess: runtime, sessions: { list: () => sessions } }
  const manager = createPreviewProjects(ctx, { publish: event => events.push(event) })
  t.after(async () => { await manager.dispose(); await runtime.disposeManagedProcesses(); await context.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const request = (id, action = 'start') => ({ sessionId: id, action, cwd: join(root, id), command: `${JSON.stringify(process.execPath)} server.cjs` })
  async function ready (id) {
    for (let i = 0; i < 200; i++) {
      const state = await manager.read(id)
      if (state.status === 'ready') return state
      if (state.status === 'exited') throw Error(state.error + '\n' + state.output)
      await delay(25)
    }
    throw Error('Server did not become ready: ' + JSON.stringify(await manager.read(id)))
  }
  return { root, manager, request, ready, events, ctx }
}

test('three chats own distinct arbitrary-port servers; stop/restart never affect neighbours', async t => {
  const { manager, request, ready, events, ctx } = await fixture(t)
  await Promise.all(['one', 'two', 'three'].map(id => manager.change(request(id))))
  const states = await Promise.all(['one', 'two', 'three'].map(ready))
  assert.equal(new Set(states.map(s => s.url)).size, 3)
  for (const state of states) {
    assert.equal(await (await fetch(state.url)).text(), state.sessionId)
    assert.ok(events.some(e => e.sessionId === state.sessionId && e.url === state.url))
  }
  await manager.change(request('two', 'stop'))
  assert.equal((await manager.read('two')).status, 'stopped')
  await assert.rejects(fetch(states[1].url))
  assert.equal(await (await fetch(states[0].url)).text(), 'one')
  assert.equal(await (await fetch(states[2].url)).text(), 'three')
  await Promise.all([manager.change(request('two')), manager.change(request('two'))])
  await ready('two')
  await manager.change(request('one', 'restart'))
  await ready('one')
  await manager.dispose()
  const restarted = createPreviewProjects(ctx, { publish () {} })
  assert.equal((await restarted.read('one')).status, 'stopped', 'Restart never adopts an old PID or URL')
  await restarted.dispose()
})

test('folder fence is tied to the chat, including symlinks; bad restart preserves working process', async t => {
  const { root, manager, request, ready } = await fixture(t)
  await manager.change(request('one'))
  const first = await ready('one')
  await assert.rejects(manager.change({ ...request('one', 'restart'), cwd: join(root, 'two') }), /inside this chat/)
  await symlink(join(root, 'two'), join(root, 'one', 'escape'))
  await assert.rejects(manager.change({ ...request('one', 'restart'), cwd: join(root, 'one', 'escape') }), /inside this chat/)
  await assert.rejects(manager.change({ ...request('one'), command: '' }), /launch command/)
  await assert.rejects(manager.read('missing'), /no project folder/)
  await assert.rejects(manager.change(null), /must be an object/)
  assert.equal(await (await fetch(first.url)).text(), 'one')
})

test('failed commands expose exit/output and can be started again; tool uses execution chat identity', async t => {
  const { manager, request, ready } = await fixture(t)
  await manager.change({ ...request('one'), command: 'printf "launch failed\\n"; exit 7' })
  for (let i = 0; i < 100 && (await manager.read('one')).status !== 'exited'; i++) await delay(20)
  const failed = await manager.read('one')
  assert.equal(failed.status, 'exited'); assert.match(failed.error, /7/); assert.match(failed.output, /launch failed/)
  const tool = previewServerTool(manager)
  const result = await tool.execute({ ...request('one'), sessionId: 'three' }, { agent: { session: { header: { id: 'one' } } } })
  assert.equal(result.ok, true)
  await ready('one')
  assert.equal((await manager.read('three')).status, 'stopped')
})

test('URL discovery accepts local arbitrary ports, excludes remote origins and credentials', () => {
  assert.equal(localPreviewURL('Local: http://0.0.0.0:55023/'), 'http://127.0.0.1:55023/')
  assert.equal(localPreviewURL('https://example.com:443/'), null)
  assert.equal(localPreviewURL('http://me:secret@localhost:3000/'), null)
})

test('a restored, inactive chat can start without creating an agent', async t => {
  const { ctx, root, request } = await fixture(t)
  const manager = createPreviewProjects({ ...ctx, sessions: { list: () => [] },
    sessionPersistence: { list: async () => [{ id: 'one', cwd: join(root, 'one') }] } }, { publish () {} })
  t.after(() => manager.dispose())
  assert.equal((await manager.read('one')).status, 'stopped')
  assert.equal((await manager.change(request('one'))).status, 'starting')
  await manager.change(request('one', 'stop'))
})
