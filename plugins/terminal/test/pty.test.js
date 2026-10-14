import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPtySessions } from '../lib/pty-sessions.js'
import { workspaceRoots } from '../lib/roots.js'

function fixture(context = {}) {
  const writes = [], sizes = [], specs = []
  let finish, terminated = 0
  const handle = { output: new PassThrough(), done: new Promise(resolve => { finish = resolve }),
    write: async data => writes.push(data), terminal: { resize: (...size) => sizes.push(size) },
    terminate: async () => { terminated++; finish({ exitCode: 0 }); handle.output.end() } }
  const sessions = createPtySessions({ workspaceRegistry: { list: () => [{ path: process.cwd() }] },
    ...context,
    subprocess: { resolveExecutable: async () => '/usr/bin/env', spawnTerminal: async spec => { specs.push(spec); return handle } } })
  return { sessions, handle, writes, sizes, specs, get terminated() { return terminated } }
}
test('PTY preserves cursor sequences and ordered input, resizes the real terminal, and cleans up', async () => {
  const f = fixture()
  try {
    const session = await f.sessions.open({ cwd: process.cwd(), cols: 100, rows: 30 })
    assert.deepEqual(f.specs[0].argv.slice(-2), ['-l', '-i'])
    assert.equal(f.specs[0].argv[1], 'TERM=xterm-256color')
    assert.equal(f.specs[0].env.TERM, 'xterm-256color')
    const first = [], second = []
    f.sessions.subscribe(session.id, null, e => first.push(e))
    f.sessions.subscribe(session.id, null, e => second.push(e))
    f.handle.output.write('\x1b[2J\x1b[Hhello\rworld')
    assert.equal(first.at(-1).text, '\x1b[2J\x1b[Hhello\rworld')
    assert.equal(first.at(-1).seq, second.at(-1).seq)
    await f.sessions.write(session.id, '\x1b[A')
    await f.sessions.write(session.id, '\x03')
    assert.deepEqual(f.writes, ['\x1b[A', '\x03'])
    f.sessions.resize(session.id, 120, 40)
    assert.deepEqual(f.sizes, [[120, 40]])
    assert.throws(() => f.sessions.resize(session.id, 0, 40), { status: 400 })
    await assert.rejects(f.sessions.write(session.id, 'x'.repeat(65537)), { status: 400 })
    await f.sessions.close(session.id)
    assert.equal(f.terminated, 1)
    assert.equal(f.sessions.list().length, 0)
  } finally { await f.sessions.dispose() }
})
test('PTY refuses outside workspaces and closed service allocations', async () => {
  const f = fixture()
  await assert.rejects(f.sessions.open({ cwd: '/etc' }), { status: 403 })
  assert.equal(f.specs.length, 0)
  await f.sessions.dispose()
  await assert.rejects(f.sessions.open({ cwd: process.cwd() }), { status: 503 })
})
test('PTY can reopen a live conversation folder without registering it or admitting unrelated paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pty-live-chat-'))
  const chat = join(dir, 'chat'), outside = join(dir, 'outside')
  await mkdir(chat); await mkdir(outside)
  await symlink(outside, join(chat, 'escape'))
  const context = { workspaceRegistry: { list: () => [] }, sessions: { list: () => [
    { header: { cwd: chat } }, { cwd: chat }, { cwd: '/' }, { cwd: '/tmp/..' }, { cwd: 'relative' }, {},
  ] } }
  const f = fixture(context)
  try {
    assert.deepEqual(workspaceRoots(context), [process.cwd(), chat])
    const terminal = await f.sessions.open({ cwd: chat })
    assert.equal(f.specs[0].cwd, await realpath(chat))
    await assert.rejects(f.sessions.open({ cwd: outside }), { status: 403 })
    await assert.rejects(f.sessions.open({ cwd: join(chat, 'escape') }), { status: 403 })
    assert.equal(f.specs.length, 1)
    await f.sessions.close(terminal.id)
    context.sessions.list = () => { throw new Error('unavailable') }
    assert.deepEqual(workspaceRoots(context), [process.cwd()])
  } finally { await f.sessions.dispose(); await rm(dir, { recursive: true, force: true }) }
})
