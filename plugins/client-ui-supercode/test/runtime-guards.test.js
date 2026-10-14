import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installRuntimeGuards, toolAccess } from '../lib/runtime-guards.js'

function fixture() {
  const hooks = new Map(), guards = []
  const records = new Map()
  let calls = 0, allowed = true, initiator
  const events = []
  const ctx = {
    agents: { currentInitiator: () => initiator },
    tools: { guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) } },
    on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name) },
  }
  const runtime = installRuntimeGuards({
    ctx, lookup: value => records.get(typeof value === 'string' ? value : value?.session.id),
    admission: () => allowed || 'Room is paused.', reserveCall: async () => { if (++calls > 2) throw Error('Checkpoint') },
    emit: (...args) => events.push(args),
  })
  function member(id, roomId = 'room') {
    const record = { roomId, memberId: id, sessionId: id, agent: { session: { id } } }
    records.set(id, record)
    return record
  }
  const begin = (record, mode = 'read') => runtime.begin(record, { mode, signal: new AbortController().signal })
  const exec = (record, name, args = {}) => ({ token: Symbol(), agent: record.agent, name, arguments: args, signal: record.grant?.signal })
  async function tool(record, name, body, args) {
    const call = exec(record, name, args)
    for (const guard of guards) {
      const reason = guard(call)
      if (reason) throw Error(reason)
    }
    return hooks.get('tools/execute')(call, body)
  }
  async function model(record, purpose) {
    const stream = hooks.get('llm/stream')({ sessionId: record.sessionId, purpose }, async function* () { yield 'response' })
    const output = []
    for await (const chunk of stream) output.push(chunk)
    return output
  }
  return { runtime, member, begin, tool, exec, model, hooks, events, get calls() { return calls }, pause: () => { allowed = false }, setInitiator: value => { initiator = value } }
}

test('read grants allow inspected capabilities, but deny shell, MCP and scoped unknown tools', async () => {
  const f = fixture(), reader = f.member('reader')
  f.begin(reader)
  assert.equal(await f.tool(reader, 'read', async () => 'file'), 'file')
  for (const tool of ['bash', 'run_code', 'computer_call', 'mcp__browser__click', 'write', 'arbitraryScopedTool']) {
    await assert.rejects(f.tool(reader, tool, () => assert.fail('mutation ran')), /writer/)
  }
  for (const tool of ['supercode_post', 'supercode_task', 'supercode_plan_ready']) assert.equal(toolAccess(tool), 'read')
})

test('conversation grants deny even read-only workspace tools without rewriting native requests', async () => {
  const f = fixture(), lead = f.member('lead'); f.begin(lead, 'chat')
  for (const name of ['read', 'read_image', 'glob', 'grep', 'bash', 'run_code', 'web_search', 'mcp__files__read', 'supercode_task', 'supercode_finish']) {
    await assert.rejects(f.tool(lead, name, () => assert.fail('Workspace or task access ran')), /conversation-only/)
  }
  assert.equal(await f.tool(lead, 'supercode_post', async () => 'chat'), 'chat')
  const options = Object.freeze({ sessionId: lead.sessionId, tools: Object.freeze([{ name: 'read' }, { name: 'supercode_post' }]) })
  const stream = f.hooks.get('llm/stream')(options, async function* () { yield 'reply' })
  for await (const _ of stream) {}
  assert.equal(f.calls, 1); f.runtime.end(lead)
})

test('writer is exclusive across members but readers and unrelated rooms can overlap', () => {
  const f = fixture(), writer = f.member('writer'), second = f.member('second'), reader = f.member('reader'), other = f.member('other', 'other-room')
  f.begin(writer, 'write'); f.begin(reader); f.begin(other, 'write')
  assert.throws(() => f.begin(second, 'write'), /owns the writer slot/)
  f.runtime.end(writer)
  f.begin(second, 'write')
})

test('dispatch rechecks a paused room even after preparation succeeded', async () => {
  const f = fixture(), writer = f.member('writer')
  f.begin(writer, 'write')
  const call = f.exec(writer, 'write')
  f.pause()
  await assert.rejects(f.hooks.get('tools/execute')(call, () => assert.fail('body ran')), /paused/)
})

test('writer slot remains held through an aborted but still-running body', async () => {
  const f = fixture(), writer = f.member('writer'), other = f.member('other')
  f.begin(writer, 'write')
  let finish
  const body = new Promise(resolve => { finish = resolve })
  const pending = f.tool(writer, 'write', () => body)
  f.runtime.close(writer)
  assert.throws(() => f.runtime.end(writer), /quiescence/)
  assert.throws(() => f.begin(other, 'write'), /writer slot/)
  finish('settled')
  await pending
  f.runtime.end(writer)
  f.begin(other, 'write')
})

test('raw Node PTC is denied before any read-grant code or nested endpoint executes', async () => {
  const f = fixture(), reader = f.member('reader')
  f.begin(reader)
  await assert.rejects(f.tool(reader, 'run_code', () => assert.fail('Raw Node code executed in a read grant')), /writer/)
  assert.equal(reader.grant.calls.size, 0)
  f.runtime.end(reader)
  f.begin(reader, 'write')
  assert.equal(await f.tool(reader, 'run_code', async () => 'writer only'), 'writer only')
})

test('independent delegation and persistent background tools remain denied to writers', async () => {
  const f = fixture(), writer = f.member('writer')
  f.begin(writer, 'write')
  for (const name of ['subagent', 'subagent_fork', 'send_message', 'dispatch', 'workflow', 'ralph', 'create_goal', 'terminal', 'preview_server', 'schedule_create', 'schedule_update', 'schedule_delete', 'webhook_create']) {
    await assert.rejects(f.tool(writer, name, () => assert.fail()), /independent delegation/)
  }
  await assert.rejects(f.tool(writer, 'bash', () => assert.fail(), { run_in_background: true }), /foreground/)
})

test('native hidden wakeups cannot make requests without a scheduled turn', async () => {
  const f = fixture(), reader = f.member('reader')
  const result = await f.hooks.get('agent/pre-step')({ agent: reader.agent }, () => assert.fail('downstream pre-step ran'))
  assert.deepEqual(result, { kind: 'reject' })
  await assert.rejects(f.model(reader), /no active scheduled turn/)
  assert.equal(f.calls, 0)
})

test('restored or foreign inbox input cannot borrow an active scheduled grant', async () => {
  const f = fixture(), reader = f.member('reader')
  reader.acceptMessage = message => message.id === 'authorized-host-message'
  f.begin(reader)
  const result = await f.hooks.get('agent/pre-step')({ agent: reader.agent, messages: [{ id: 'ordinary-chat' }] }, () => assert.fail('Foreign message reached model preparation'))
  assert.deepEqual(result, { kind: 'reject' })
  assert.equal(f.calls, 0)
})

test('an empty old native wake cannot borrow a new grant, and continuations stay on its admitted turn', async () => {
  const f = fixture(), reader = f.member('reader')
  reader.acceptMessage = message => message.id === 'host-delivery'
  f.begin(reader)
  const pre = (turn, messages) => f.hooks.get('agent/pre-step')({ agent: reader.agent, turn, messages }, async () => ({ kind: 'enter', messages }))
  assert.deepEqual(await pre(4, []), { kind: 'reject' })
  await assert.rejects(f.model(reader), /has not entered/)
  assert.equal((await pre(5, [{ id: 'host-delivery' }])).kind, 'enter')
  assert.deepEqual(await f.model(reader), ['response'])
  assert.equal((await pre(5, [])).kind, 'enter')
  assert.deepEqual(await pre(6, []), { kind: 'reject' })
})

test('every model dispatch including compaction reserves a slot before forwarding', async () => {
  const f = fixture(), reader = f.member('reader')
  f.begin(reader)
  assert.deepEqual(await f.model(reader), ['response'])
  assert.deepEqual(await f.model(reader, 'compaction'), ['response'])
  await assert.rejects(f.model(reader), /Checkpoint/)
  f.runtime.end(reader)
  await assert.rejects(f.model(reader), /no active scheduled turn/)
})

test('auxiliary title generation is denied even during an active assignment', async () => {
  const f = fixture(), reader = f.member('reader')
  f.begin(reader)
  await assert.rejects(f.model(reader, 'session-title'), /auxiliary title/)
  assert.equal(f.calls, 0)
})

test('mismatched member identity cannot escape through an unrelated model session', async () => {
  const f = fixture(), reader = f.member('reader')
  f.begin(reader); f.setInitiator(reader.agent)
  await assert.rejects(f.model({ sessionId: 'ordinary-chat' }), /mismatched session/)
})

test('tool diagnostics do not copy arguments, output or error contents', () => {
  const f = fixture(), writer = f.member('writer')
  f.begin(writer, 'write')
  f.hooks.get('tools/result')(f.exec(writer, 'bash', { command: 'credential' }), { isError: true, content: ['secret'], error: { message: 'secret' } })
  assert.equal(JSON.stringify(f.events).includes('secret'), false)
  assert.equal(JSON.stringify(f.events).includes('credential'), false)
})

test('request 200 actually dispatches after reservation while request 201 is denied', async () => {
  const hooks = new Map()
  const record = { roomId: 'room', memberId: 'lead', sessionId: 'lead' }
  let count = 199, dispatched = 0
  const guard = installRuntimeGuards({
    ctx: { tools: { guard: () => () => {} }, agents: {}, on: (name, fn) => { hooks.set(name, fn); return () => {} } },
    lookup: id => id === 'lead' ? record : undefined,
    admission: (_, __, { kind }) => kind === 'model-reserved' || count < 200 || 'Checkpoint',
    reserveCall: async () => { count++ },
  })
  guard.begin(record, { mode: 'read', signal: new AbortController().signal })
  async function dispatch() {
    for await (const chunk of hooks.get('llm/stream')({ sessionId: 'lead' }, async function* () { dispatched++; yield 'ok' })) assert.equal(chunk, 'ok')
  }
  await dispatch()
  assert.equal(count, 200)
  assert.equal(dispatched, 1)
  await assert.rejects(dispatch(), /Checkpoint/)
  assert.equal(count, 200)
  guard.dispose()
})

test('a reservation that finishes after cancellation never dispatches its model', async () => {
  const hooks = new Map(), signal = new AbortController()
  const record = { roomId: 'room', memberId: 'lead', sessionId: 'lead' }
  let release, entered, dispatched = false
  const started = new Promise(resolve => { entered = resolve })
  const pending = new Promise(resolve => { release = resolve })
  const guard = installRuntimeGuards({
    ctx: { tools: { guard: () => () => {} }, agents: {}, on: (name, fn) => { hooks.set(name, fn); return () => {} } },
    lookup: id => id === 'lead' ? record : undefined, admission: () => true,
    reserveCall: async () => { entered(); await pending },
  })
  guard.begin(record, { mode: 'read', signal: signal.signal })
  const run = (async () => {
    for await (const _ of hooks.get('llm/stream')({ sessionId: 'lead' }, async function* () { dispatched = true; yield 'response' })) {}
  })()
  await started
  signal.abort(); guard.close(record); release()
  await assert.rejects(run, /no active scheduled turn/)
  assert.equal(dispatched, false)
  guard.end(record); guard.dispose()
})
