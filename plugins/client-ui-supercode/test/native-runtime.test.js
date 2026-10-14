import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createNativeRuntime } from '../lib/native-runtime.js'

function fixture() {
  const hooks = new Map(), agents = new Map(), stored = new Set(), catalog = new Map()
  const writes = [], creations = [], requests = [], jobRows = [], presentations = [], emitted = []
  const room = {
    id: 'room', runId: 'run-1', leadId: 'lead', permissionPreset: 'workspace-write', workspace: { cwd: '/tmp/project' },
    members: [
      { id: 'lead', name: 'Lead', role: 'lead', provider: 'fixture', model: 'lead-model' },
      { id: 'reviewer', name: 'Reviewer', role: 'reviewer', provider: 'fixture', model: 'review-model', effort: 'high' },
    ],
  }
  let allow = true, flushes = 0, waitJob, work, cancelled = 0
  const emit = async (name, ...args) => { for (const fn of hooks.get(name) || []) await fn(...args) }
  const ctx = {
    on(name, fn) {
      if (!hooks.has(name)) hooks.set(name, new Set())
      hooks.get(name).add(fn)
      return () => hooks.get(name).delete(fn)
    },
    tools: { guard: () => () => {}, presentAs: mode => { presentations.push(mode) } },
    systemPrompt: { section: () => () => {} },
    agentPresets: { mount: async () => {} },
    permissionPresets: { set: (_, preset) => { assert.equal(preset, 'workspace-write') } },
    sessionPersistence: { stat: async id => stored.has(id) ? {} : undefined },
    sessions: { flush: async () => { flushes++ } },
    jobs: {
      list: id => jobRows.filter(job => job.owner === id),
      kill: id => { const job = jobRows.find(row => row.id === id); job.status = 'stopping' },
      wait: async id => waitJob ? waitJob(id) : Object.assign(jobRows.find(row => row.id === id), { status: 'killed' }),
    },
  }
  async function create(options, resumed = false) {
    const id = options.sessionId || options.resumeSessionId
    assert.ok(room.members.some(member => member.sessionId === id), 'identity must be saved before creation')
    const session = { id, header: { id, cwd: '/tmp/project', ...options.meta } }
    const agent = {
      ctx, session, options: options.agentOptions, status: 'idle', turn: 0,
      pending: Promise.resolve(),
      removed: new Set(),
      inbox: { remove(id) { agent.removed.add(id) } },
      cancel() { cancelled++ },
      whenIdle() { return this.pending },
      followup(message) {
        if (message.source?.origin === 'supercode-host') assert.equal(message.role, 'user', 'Host followups must remain valid on native journal replay')
        this.pending = drive(this, message)
      },
    }
    await options.setup?.(ctx, agent)
    agents.set(id, agent)
    await emit('agent/created', { agent, source: resumed ? 'resume' : 'startup' })
    stored.add(id)
    creations.push({ id, options, resumed })
    return { agent, dispose: async () => agents.delete(id) }
  }
  async function drive(agent, message) {
    message.id ||= randomUUID()
    await emit('agent/inbox/inserted', { agent, message })
    if (agent.removed.has(message.id)) return
    agent.status = 'running'
    agent.turn++
    const pre = [...hooks.get('agent/pre-step')][0]
    const admitted = await pre({ agent, turn: agent.turn, messages: [message] }, async () => ({ kind: 'enter', messages: [message] }))
    if (admitted.kind === 'reject') { agent.status = 'idle'; return }
    const stream = [...hooks.get('llm/stream')][0]
    for await (const value of stream({ sessionId: agent.session.id, ...agent.options }, async function* () { yield 'ok' })) requests.push(value)
    await work?.(agent, message)
    await emit('session/event', agent.session, { type: 'assistant/message', data: { turn: agent.turn, message: { id: randomUUID(), content: [{ type: 'text', text: agent.options.model + ': done' }] }, usage: { inputTokens: 2, outputTokens: 3 } } })
    await emit('session/event', agent.session, { type: 'turn/end', data: { turn: agent.turn, reason: { kind: 'completed' } } })
    agent.status = 'idle'
  }
  ctx.agents = { get: id => agents.get(id), create, resume: options => create(options, true), currentInitiator: () => undefined }
  ctx.subagents = {
    listChildren: async id => catalog.get(id) || [],
    startContinuable: async spec => {
      const depth = (spec.request.parent.session.header.delegationDepth || 0) + 1
      assert(depth <= spec.request.maxDepth, `subagent depth ${depth} exceeds maxDepth ${spec.request.maxDepth}`)
      const handle = await create({ sessionId: spec.childId, agentOptions: spec.request.agentOptions,
        meta: { delegationDepth: depth, parentSession: spec.request.parent.session.id, origin: 'subagent' } })
      catalog.set(spec.request.parent.session.id, [...(catalog.get(spec.request.parent.session.id) || []), { id: spec.childId }])
      handle.agent.followup({ source: { kind: 'user' }, content: spec.request.prompt })
      return { childId: spec.childId }
    },
    sendMessage: async (parent, id, content) => {
      if (!agents.has(id)) await create({ resumeSessionId: id, agentOptions: room.members.find(member => member.sessionId === id).id === 'reviewer' ? { provider: 'fixture', model: 'review-model' } : {} }, true)
      agents.get(id).followup({ source: { kind: 'agent-message', senderSessionId: parent.session.id }, content })
    },
    drainContinuableDescendants: async () => {},
    drainContinuableChildren: async () => {},
  }
  const options = {
    ctx, getRoom: () => room,
    persistMemberSession: (_, memberId, sessionId) => { writes.push(sessionId); room.members.find(member => member.id === memberId).sessionId = sessionId },
    admission: () => allow,
    reserveCall: async () => {},
    emit: (roomId, event) => emitted.push({ roomId, ...event }),
  }
  const runtime = createNativeRuntime(options)
  return {
    runtime, options, room, ctx, hooks, creations, requests, writes, agents, catalog, jobRows, presentations, emitted, emit,
    get flushes() { return flushes }, get cancelled() { return cancelled },
    pause: () => { allow = false }, setWork: fn => { work = fn }, setJobWait: fn => { waitJob = fn },
  }
}

test('native root uses the chosen model, saves identity first, flushes, and continues its session', async () => {
  const f = fixture()
  const first = await f.runtime.run('room', 'lead', 'Inspect the task', { mode: 'read' })
  const second = await f.runtime.run('room', 'lead', 'Continue', { mode: 'write' })
  assert.equal(first.diagnostic.ok, true)
  assert.equal(first.assistantText, 'lead-model: done')
  assert.deepEqual(first.usage, { inputTokens: 2, outputTokens: 3, input: 2, output: 3, cost: null })
  assert.equal(first.sessionId, second.sessionId)
  assert.equal(f.creations.length, 1)
  assert.equal(f.flushes, 2)
  assert.equal(f.requests.length, 2)
  await f.runtime.dispose()
})

test('first teammate creates an unbilled lead then a continuable child with its own model', async () => {
  const f = fixture()
  const output = await f.runtime.run('room', 'reviewer', 'Review files')
  assert.equal(output.assistantText, 'review-model: done')
  assert.equal(f.creations.length, 2)
  assert.equal(f.requests.length, 1)
  assert.equal(f.creations[1].options.agentOptions.reasoningEffort, 'high')
  assert.deepEqual(f.presentations, ['native', 'native'])
  await f.runtime.run('room', 'reviewer', 'Review again')
  assert.equal(f.creations.length, 2)
  assert.equal(f.requests.length, 2)
  await f.runtime.dispose()
})

test('follow-up teammates fit the hidden run-lead lineage while retaining the canonical chat identity', async () => {
  const f = fixture()
  const original = await f.runtime.prepare('room')
  f.room.chatSessionId = original.id
  await f.runtime.run('room', 'reviewer', 'Investigate first goal')
  f.room.runId = 'run-2'
  f.room.members = f.room.members.map(({ sessionId, ...member }) => member)
  const result = await f.runtime.run('room', 'reviewer', 'Investigate follow-up goal')
  assert.equal(result.diagnostic.ok, true)
  assert.equal(f.room.chatSessionId, original.id)
  const nextLead = f.creations.find(row => row.options.meta?.parentSession === original.id && row.options.agentOptions.model === 'lead-model')
  assert.equal(nextLead.options.meta.origin, 'subagent')
  assert.equal(nextLead.options.meta.delegationDepth, 1)
  const teammate = f.creations.find(row => row.id === result.sessionId)
  assert.equal(teammate.options.meta.parentSession, nextLead.id)
  assert.equal(teammate.options.meta.delegationDepth, 2)
  assert.equal(f.requests.length, 2)
  await f.runtime.dispose()
})

test('a native chat viewer can load a stored member without gaining any execution grant', async () => {
  const f = fixture()
  f.room.members[0].sessionId = 'known-session'
  f.runtime.registerRoom(f.room)
  const observer = { session: { id: 'known-session' }, ctx: f.ctx, cancel() {}, whenIdle: async () => {} }
  await f.emit('agent/created', { agent: observer })
  assert.equal(f.runtime.identify(observer), null)
  assert.equal((await [...f.hooks.get('agent/pre-step')][0]({ agent: observer, turn: 1, messages: [] }, async () => assert.fail('Viewer ran a model'))).kind, 'reject')
  await f.runtime.dispose()
})

test('another surface cannot replace a member in an active scheduled turn', async () => {
  const f = fixture()
  f.setWork(async agent => {
    await assert.rejects(f.emit('agent/created', { agent: { session: agent.session, ctx: f.ctx } }), /scheduled turn/)
  })
  const result = await f.runtime.run('room', 'lead', 'Say hello', { mode: 'chat' })
  assert.equal(result.diagnostic.ok, true); assert.equal(f.requests.length, 1)
  await f.runtime.dispose()
})

test('paused admission makes no model request', async () => {
  const f = fixture()
  f.pause()
  await assert.rejects(f.runtime.run('room', 'lead', 'Do work'), /paused|approval/)
  assert.equal(f.requests.length, 0)
  await f.runtime.dispose()
})

test('cancel waits for an in-flight task to reach quiescence', async () => {
  const f = fixture()
  let finish, started
  const entered = new Promise(resolve => { started = resolve })
  f.setWork(() => { started(); return new Promise(resolve => { finish = resolve }) })
  const running = f.runtime.run('room', 'lead', 'Edit', { mode: 'write' })
  await entered
  assert.equal(f.runtime.isBusy('room'), true)
  let stopped = false
  const cancelling = f.runtime.cancel('room').then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  finish()
  assert.equal((await running).diagnostic.ok, false)
  await cancelling
  assert.equal(stopped, true)
  assert.equal(f.runtime.isBusy('room'), false)
  await f.runtime.dispose()
})

test('cancel does not reflush a continuable child already durably closed by native disposal', async () => {
  const f = fixture()
  let finish, started, closed = false
  const entered = new Promise(resolve => { started = resolve })
  const flush = f.ctx.sessions.flush
  f.ctx.sessions.get = id => f.agents.get(id)?.session
  f.ctx.sessions.flush = async session => {
    assert.ok(f.agents.has(session.id), 'A detached native Session cannot be flushed again')
    await flush(session)
  }
  f.setWork(agent => {
    agent.cancel = () => { closed = true; f.agents.delete(agent.session.id) }
    started()
    return new Promise(resolve => { finish = resolve })
  })
  const running = f.runtime.run('room', 'reviewer', 'Read')
  await entered
  const cancellation = f.runtime.cancel('room')
  finish()
  await running
  await cancellation
  assert.equal(closed, true)
  await f.runtime.dispose()
})

test('failure to flush a still-live session retains writer ownership and rejects pause', async () => {
  const f = fixture()
  f.ctx.sessions.flush = async () => { throw Error('Persistence unavailable') }
  const result = await f.runtime.run('room', 'lead', 'Edit', { mode: 'write' })
  assert.equal(result.diagnostic.ok, false)
  assert.equal(f.runtime.isBusy('room'), true)
  await assert.rejects(f.runtime.cancel('room'), /Persistence unavailable/)
  await assert.rejects(f.runtime.run('room', 'reviewer', 'Edit', { mode: 'write' }), /writer slot/)
  f.ctx.sessions.flush = async () => {}
  await f.runtime.dispose()
})

test('child cleanup joins native disposal before a still-published closed handle can be flushed', async () => {
  const f = fixture()
  let disposing, release, drained = 0
  const entered = new Promise(resolve => { disposing = resolve })
  f.ctx.subagents.drainContinuableChildren = async (root, ids) => {
    assert.equal(root.session.id, f.room.members[0].sessionId)
    drained++
    if (!f.agents.has(ids[0])) return
    disposing()
    await new Promise(resolve => { release = resolve })
    f.agents.delete(ids[0])
  }
  const flush = f.ctx.sessions.flush
  f.ctx.sessions.flush = async session => {
    assert.notEqual(session.id, f.room.members[1].sessionId, 'A closing child handle must be joined, not reflushed')
    await flush(session)
  }
  const running = f.runtime.run('room', 'reviewer', 'Read')
  await entered
  assert.equal(f.runtime.isBusy('room'), true)
  release()
  assert.equal((await running).diagnostic.ok, true)
  assert.equal(f.runtime.isBusy('room'), false)
  await f.runtime.cancel('room')
  assert.ok(drained >= 2)
  await f.runtime.dispose()
})

test('native child disposal failure retains ownership instead of treating a closed handle as success', async () => {
  const f = fixture()
  f.ctx.subagents.drainContinuableChildren = async () => { throw Error('Native durable close failed') }
  const result = await f.runtime.run('room', 'reviewer', 'Write', { mode: 'write' })
  assert.equal(result.diagnostic.ok, false)
  assert.equal(f.runtime.isBusy('room'), true)
  await assert.rejects(f.runtime.cancel('room'), /Native durable close failed/)
  f.ctx.subagents.drainContinuableChildren = async () => {}
  await f.runtime.dispose()
})

test('native approval requests emit attributed metadata without arguments or private reason text', async () => {
  const f = fixture()
  f.setWork(async agent => {
    await f.emit('session/event', { id: agent.session.id }, { type: 'approval/asked', data: { toolName: 'forged' } })
    await f.emit('session/event', agent.session, { type: 'approval/asked', data: { toolName: 'bash', reason: 'private detail', arguments: 'secret' } })
  })
  const result = await f.runtime.run('room', 'lead', 'Write', { mode: 'write', taskId: 'task' })
  assert.equal(result.diagnostic.ok, false)
  assert.deepEqual(f.emitted.filter(event => event.type === 'approval'), [{ roomId: 'room', type: 'approval', memberId: 'lead', name: 'bash', state: 'asked', taskId: 'task' }])
  await f.runtime.dispose()
})

test('public native messages arrive while work is held, once, without reasoning or tool data', async () => {
  const f = fixture()
  let release, started
  const entered = new Promise(resolve => { started = resolve })
  f.setWork(async agent => {
    const event = { type: 'assistant/message', data: { turn: agent.turn, message: { id: 'public-progress', content: [
      { type: 'reasoning', text: 'PRIVATE_REASONING' },
      { type: 'text', text: 'I found the validation path; checking its tests next.' },
      { type: 'tool_call', arguments: 'PRIVATE_TOOL_ARGUMENTS' },
    ] }, stream: [{ type: 'reasoning', text: 'PRIVATE_STREAM' }], usage: { outputTokens: 1 } } }
    await f.emit('session/event', agent.session, { ...event, type: 'assistant/attempt' })
    await f.emit('session/event', { id: agent.session.id }, event)
    await f.emit('session/event', agent.session, { ...event, data: { ...event.data, turn: agent.turn - 1 } })
    await f.emit('session/event', agent.session, event)
    await f.emit('session/event', agent.session, event)
    started()
    await new Promise(resolve => { release = resolve })
  })
  let settled = false
  const running = f.runtime.run('room', 'lead', 'Inspect').then(result => { settled = true; return result })
  await entered
  assert.equal(settled, false)
  const progress = f.emitted.filter(event => event.type === 'assistant')
  assert.equal(progress.length, 1)
  assert.equal(progress[0].messageId, 'public-progress')
  assert.equal(progress[0].runId, f.room.runId)
  assert.equal(progress[0].sessionId, f.room.members[0].sessionId)
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_/)
  release()
  const result = await running
  assert.equal(result.assistantMessages.length, 2)
  assert.equal(result.usage.output, 4, 'Duplicate native event must not double count usage')
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/)
  await f.runtime.dispose()
})

test('late previous-turn public messages cannot borrow a new assignment or publish after cancellation', async () => {
  const f = fixture()
  await f.runtime.run('room', 'lead', 'First')
  let release, started, current
  const entered = new Promise(resolve => { started = resolve })
  f.setWork(async agent => {
    current = agent
    await f.emit('session/event', agent.session, { type: 'assistant/message', data: { turn: agent.turn - 1, message: { id: 'late', content: [{ type: 'text', text: 'Stale prior turn' }] } } })
    started(); await new Promise(resolve => { release = resolve })
  })
  const running = f.runtime.run('room', 'lead', 'Second')
  await entered
  const cancelling = f.runtime.cancel('room')
  const canceledEvent = { type: 'assistant/message', data: { turn: current.turn, message: { id: 'cancelled', content: [{ type: 'text', text: 'Late cancelled output' }] }, usage: { outputTokens: 2 } } }
  await f.emit('session/event', current.session, canceledEvent)
  await f.emit('session/event', current.session, canceledEvent)
  release(); const result = await running; await cancelling
  assert.deepEqual(f.emitted.filter(event => event.type === 'assistant').map(event => event.text), ['lead-model: done'])
  assert.equal(result.usage.output, 5, 'Admitted canceled usage is still counted once without publishing its text')
  await f.runtime.dispose()
})

test('a background process is killed and awaited before writer ownership ends', async () => {
  const f = fixture()
  let finishJob, jobWaiting
  const waiting = new Promise(resolve => { jobWaiting = resolve })
  f.setWork(agent => { f.jobRows.push({ id: 'job-1', owner: agent.session.id, status: 'running' }) })
  f.setJobWait(() => { jobWaiting(); return new Promise(resolve => { finishJob = () => resolve(Object.assign(f.jobRows[0], { status: 'killed' })) }) })
  let finished = false
  const running = f.runtime.run('room', 'lead', 'Edit', { mode: 'write' }).then(result => { finished = true; return result })
  await waiting
  assert.equal(finished, false)
  assert.equal(f.jobRows[0].status, 'stopping')
  await assert.rejects(f.runtime.run('room', 'reviewer', 'Another edit', { mode: 'write' }), /writer slot/)
  finishJob()
  assert.equal((await running).diagnostic.drainedJobs, 1)
  await f.runtime.dispose()
})

test('writer ownership is retained if a background process cannot be drained', async () => {
  const f = fixture()
  f.setWork(agent => { f.jobRows.push({ id: 'job-1', owner: agent.session.id, status: 'running' }) })
  f.setJobWait(async () => f.jobRows[0])
  const output = await f.runtime.run('room', 'lead', 'Edit', { mode: 'write' })
  assert.equal(output.diagnostic.ok, false)
  assert.match(output.diagnostic.message, /has not stopped/)
  await assert.rejects(f.runtime.run('room', 'reviewer', 'Another edit', { mode: 'write' }), /writer slot/)
  await assert.rejects(f.runtime.cancel('room'), /has not stopped/)
  f.jobRows[0].status = 'killed'
  await f.runtime.cancel('room')
  await f.runtime.dispose()
})

test('native roots resume after runtime restart without allocating replacement identity', async () => {
  const f = fixture()
  const first = await f.runtime.run('room', 'lead', 'One')
  await f.runtime.dispose()
  const resumed = createNativeRuntime(f.options)
  resumed.registerRoom(f.room)
  const second = await resumed.run('room', 'lead', 'Two')
  assert.equal(first.sessionId, second.sessionId)
  assert.equal(f.creations[1].resumed, true)
  assert.equal(f.writes.length, 1)
  await resumed.dispose()
})


test('other resume errors never rotate native identities', async () => {
  const f = fixture(); const original = await f.runtime.run('room', 'lead', 'One')
  await f.runtime.dispose(); f.agents.clear()
  f.ctx.agents.resume = async () => { throw Error('Provider unavailable') }
  const resumed = createNativeRuntime(f.options)
  resumed.registerRoom(f.room)
  const result = await resumed.run('room', 'lead', 'Two', { mode: 'chat' })
  assert.equal(result.diagnostic.ok, false); assert.equal(f.room.members[0].sessionId, original.sessionId)
  assert.equal(f.requests.length, 1); await resumed.dispose()
})

test('a persisted teammate resumes through native lineage authorization even when its parent catalog append was lost', async () => {
  const f = fixture()
  const first = await f.runtime.run('room', 'reviewer', 'Inspect')
  await f.runtime.dispose(); f.agents.clear(); f.catalog.clear()
  const resumed = createNativeRuntime(f.options)
  resumed.registerRoom(f.room)
  const second = await resumed.run('room', 'reviewer', 'Continue after the crash')
  assert.equal(second.diagnostic.ok, true)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.assistantText, 'review-model: done')
  assert.equal(f.writes.length, 2, 'Do not replace either native team identity')
  assert.equal(f.creations.at(-1).resumed, true)
  await resumed.dispose()
})

test('orphan recovery never falls back to creating a child when native lineage authorization rejects it', async () => {
  const f = fixture()
  await f.runtime.run('room', 'reviewer', 'Inspect')
  await f.runtime.dispose(); f.agents.clear(); f.catalog.clear()
  const requests = f.requests.length
  f.ctx.subagents.sendMessage = async () => { throw new Error('Native lineage authorization rejected this child') }
  const resumed = createNativeRuntime(f.options)
  resumed.registerRoom(f.room)
  const result = await resumed.run('room', 'reviewer', 'Continue')
  assert.equal(result.diagnostic.ok, false)
  assert.match(result.diagnostic.message, /lineage authorization rejected/)
  assert.equal(f.requests.length, requests)
  assert.equal(f.writes.length, 2)
  await resumed.dispose()
})

test('new run replaces the root/model and keeps historical sessions blocked after restart', async () => {
  const f = fixture()
  const first = await f.runtime.run('room', 'lead', 'One')
  f.room.history = [{ runId: f.room.runId, members: f.room.members }]
  f.room.runId = 'run-2'
  f.room.members = f.room.members.map(member => ({ ...member, sessionId: undefined, model: 'new-model' }))
  const second = await f.runtime.run('room', 'lead', 'Two')
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(f.agents.has(first.sessionId), false)
  assert.equal(second.assistantText, 'new-model: done')
  await f.runtime.dispose()
  const restarted = createNativeRuntime(f.options)
  restarted.registerRoom(f.room)
  const historical = { session: { id: first.sessionId }, ctx: f.ctx, cancel() {}, whenIdle: async () => {} }
  await f.emit('agent/created', { agent: historical })
  assert.equal(restarted.identify(historical), null)
  const rejected = await [...f.hooks.get('agent/pre-step')][0]({ agent: historical, turn: 1, messages: [] }, async () => assert.fail('Historical work resumed'))
  assert.equal(rejected.kind, 'reject')
  await restarted.dispose()
})

test('ordinary chat and native settlement messages cannot wake an idle room member', async () => {
  const f = fixture()
  const first = await f.runtime.run('room', 'lead', 'One')
  const agent = f.agents.get(first.sessionId)
  for (const kind of ['user', 'subagent-settled', 'agent-message', 'supercode-host']) {
    agent.followup({ source: { kind }, content: [{ type: 'text', text: 'Unscheduled task' }] })
    await agent.whenIdle()
  }
  assert.equal(f.requests.length, 1)
  assert.equal(agent.removed.size, 4)
  await f.runtime.dispose()
})

test('root host assignment preserves scoped human authority without accepting ordinary chat messages', async () => {
  const f = fixture()
  f.setWork(async (agent, message) => {
    assert.equal(message.source.kind, 'user')
    assert.match(message.source.rpcId, /^supercode:room:run-1:/)
    const injected = { id: 'forged', source: { kind: 'user', rpcId: 'ordinary-ui' }, content: message.content }
    await f.emit('agent/inbox/inserted', { agent, message: injected })
    assert.equal(agent.removed.has('forged'), true)
  })
  assert.equal((await f.runtime.run('room', 'lead', 'Scoped authorized work')).diagnostic.ok, true)
  assert.equal(f.requests.length, 1)
  await f.runtime.dispose()
})
