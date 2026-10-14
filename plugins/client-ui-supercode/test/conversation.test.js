import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomService } from '../lib/room-service.js'
import { RoomStore } from '../lib/room-store.js'
const members = ['lead', 'builder', 'reviewer'].map(id => ({ id, name: id, role: id, provider: 'fixture', model: id }))
let serial = 0
const command = (action, extra = {}) => ({ action, requestId: `conversation-${++serial}`, ...extra })
const tick = () => new Promise(resolve => setImmediate(resolve))
function propose(s, id) { return s.tool(id, 'lead', 'supercode_task', { operation: 'propose', title: 'Tested add', ownerId: 'builder', criteria: 'Numeric assertions pass.' }).task }
async function fixture(t, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supercode-conversation-'))
  const s = new RoomService({ store: new RoomStore(dir) }), calls = []
  s.attach({ registerRoom() {}, cancel: async () => {}, dispose: async () => {}, run: async (id, actor, prompt, options) => {
    await s.reserveCall(id, actor)
    calls.push({ actor, prompt, ...options })
    await run?.(s, id, actor, prompt, options)
    return { diagnostic: { ok: true } }
  } })
  const room = await s.create({ goal: 'Implement a tested add function.', members, leadId: 'lead' }, { id: dir, cwd: dir, name: 'Test' })
  t.after(async () => { await s.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { s, id: room.id, dir, calls }
}
async function idle(s, id) { await s.scheduler.idle(id); await tick(); if (s.pauses.has(id)) await s.pauses.get(id).promise }
function plan(s, id, actor) { if (actor === 'lead') { if (!s.get(id).tasks.length) propose(s, id); s.tool(id, actor, 'supercode_plan_ready', {}) } }

test('pre-approval questions receive a read-only reply without granting implementation', async t => {
  const f = await fixture(t, (s, id, actor) => {
    if (s.get(id).status === 'discussing') {
      assert.match(s.admission(id, actor, { mode: 'write' }), /Discussion/)
      s.tool(id, actor, 'supercode_post', { text: 'We will preserve the public API.' })
    } else plan(s, id, actor)
  })
  await f.s.command(f.id, command('plan')); await idle(f.s, f.id)
  const before = f.calls.length
  await f.s.command(f.id, command('message', { text: 'Will the API change?', recipient: 'lead' })); await idle(f.s, f.id)
  const room = f.s.get(f.id)
  assert.equal(room.status, 'awaiting-approval'); assert.equal(room.approved, false)
  assert.equal(f.calls.length, before + 1); assert.equal(f.calls.at(-1).mode, 'read')
  assert.equal(room.messages.at(-1).text, 'We will preserve the public API.'); assert.equal(room.queue.length, 0)
})

test('planning drains peer questions before the lead synthesizes the plan', async t => {
  const f = await fixture(t, (s, id, actor, prompt) => {
    if (actor === 'reviewer' && !prompt.includes('Answer the addressed')) s.tool(id, actor, 'supercode_post', { text: 'Builder: can the existing API accept negatives?', recipient: 'builder' })
    if (actor === 'builder' && prompt.includes('Answer the addressed')) s.tool(id, actor, 'supercode_post', { text: 'Yes: negative numeric inputs are supported.', recipient: 'reviewer' })
    if (actor === 'lead') { assert.match(prompt, /negative numeric inputs are supported/); plan(s, id, actor) }
  })
  await f.s.command(f.id, command('plan')); await idle(f.s, f.id)
  assert.deepEqual(f.calls.map(c => c.actor), ['builder', 'reviewer', 'builder', 'reviewer', 'lead'])
  assert.equal(f.s.get(f.id).queue.length, 0); assert.equal(f.s.get(f.id).status, 'awaiting-approval')
})

test('distinct clarification exchanges do not count as three failed task attempts', async t => {
  let replies = 0
  const f = await fixture(t, (s, id, actor) => {
    if (s.get(id).status !== 'discussing') return plan(s, id, actor)
    replies++
    s.tool(id, actor, 'supercode_post', { text: 'Distinct finding ' + replies, ...(replies < 6 ? { recipient: actor === 'lead' ? 'reviewer' : 'lead' } : {}) })
  })
  await f.s.command(f.id, command('plan')); await idle(f.s, f.id)
  await f.s.command(f.id, command('message', { text: 'Clarify six edge cases.', recipient: 'lead' })); await idle(f.s, f.id)
  assert.equal(replies, 6); assert.equal(f.s.get(f.id).status, 'awaiting-approval')
  assert.equal(f.s.get(f.id).queue.length, 0)
})

test('repeated identical peer exchanges still stop at a coordination checkpoint', async t => {
  const f = await fixture(t, (s, id, actor) => {
    if (s.get(id).status !== 'discussing') return plan(s, id, actor)
    s.tool(id, actor, 'supercode_post', { text: 'Can you confirm?', recipient: actor === 'lead' ? 'reviewer' : 'lead' })
  })
  await f.s.command(f.id, command('plan')); await idle(f.s, f.id)
  await f.s.command(f.id, command('message', { text: 'Discuss.', recipient: 'lead' })); await idle(f.s, f.id)
  assert.equal(f.s.get(f.id).status, 'blocked'); assert.match(f.s.get(f.id).reason, /repeated the same peer message/)
  assert(f.calls.length < 15)
})

test('follow-up questions preserve a completed goal and cannot mutate completed work', async t => {
  const f = await fixture(t, (s, id, actor) => {
    assert.equal(s.get(id).status, 'discussing')
    assert.throws(() => propose(s, id), /read-only conversation/)
    assert.throws(() => s.tool(id, actor, 'supercode_finish', { summary: 'Pretend done' }), /read-only conversation/)
    s.tool(id, actor, 'supercode_post', { text: 'The completed change added a pure add function.' })
  })
  f.s.change(f.id, 'completed-fixture', room => { room.status = 'completed'; room.phase = 'execution'; room.approved = true })
  const before = f.s.get(f.id)
  await f.s.command(f.id, command('message', { text: 'What changed?', recipient: 'reviewer' })); await idle(f.s, f.id)
  const after = f.s.get(f.id)
  assert.equal(after.status, 'completed'); assert.equal(after.runId, before.runId)
  assert.equal(after.goal, before.goal); assert.deepEqual(after.tasks, before.tasks)
  assert.equal(after.history.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].actor, 'reviewer')
})

test('discussion cannot bypass an exhausted model-call checkpoint', async t => {
  const f = await fixture(t)
  f.s.change(f.id, 'spent-fixture', room => { room.status = 'completed'; room.usage.calls = room.limits.calls })
  await f.s.command(f.id, command('message', { text: 'Explain the result.' })); await idle(f.s, f.id)
  assert.equal(f.s.get(f.id).status, 'paused'); assert.equal(f.calls.length, 0)
  assert.match(f.s.get(f.id).reason, /checkpoint/)
  await f.s.command(f.id, command('resume')); await idle(f.s, f.id)
  assert.equal(f.calls.length, 1); assert.equal(f.s.get(f.id).status, 'completed')
})

test('history excludes noisy tool activity and can page back to every earlier finding', async t => {
  const f = await fixture(t)
  f.s.change(f.id, 'planning-fixture', room => { room.status = 'planning' })
  for (let i = 0; i < 35; i++) f.s.tool(f.id, 'reviewer', 'supercode_post', { text: 'Finding ' + i })
  for (let i = 0; i < 25; i++) f.s.emit(f.id, { type: 'tool', memberId: 'builder', name: 'read', text: 'Tool completed.' })
  const first = f.s.tool(f.id, 'lead', 'supercode_room_read', {}).room
  assert(first.messages.every(m => m.kind !== 'tool')); assert.equal(first.messages.at(-1).text, 'Finding 34')
  assert(first.history.hasMore)
  const second = f.s.tool(f.id, 'lead', 'supercode_room_read', { before: first.history.nextBefore }).room
  assert(second.messages.some(m => m.text === 'Finding 0')); assert.equal(second.history.hasMore, false)
  assert.equal(new Set([...first.messages, ...second.messages].map(m => m.id)).size, 36)
  assert.throws(() => f.s.tool(f.id, 'lead', 'supercode_room_read', { before: 'missing' }), /cursor not found/)
  assert.throws(() => f.s.tool(f.id, 'lead', 'supercode_room_read', { limit: 101 }), /between 1 and 100/)
  const all = f.s.tool(f.id, 'lead', 'supercode_room_read', { includeTools: true, limit: 100 }).room
  assert.equal(all.messages.length, 61)
})

test('restart restores an interrupted discussion paused rather than dispatching models', async t => {
  const f = await fixture(t)
  f.s.change(f.id, 'discussion-fixture', room => { room.status = 'discussing'; room.discussionReturn = 'completed'; room.startedAt = Date.now() })
  const restored = new RoomStore(f.dir).get(f.id)
  assert.equal(restored.status, 'paused'); assert.equal(restored.discussionReturn, 'completed')
  assert.equal(f.calls.length, 0)
})

test('builder yields to a peer and resumes the same task without a false failed attempt', async t => {
  let writes = 0
  const f = await fixture(t, (s, id, actor, prompt, options) => {
    const room = s.get(id)
    if (room.phase === 'planning') return plan(s, id, actor)
    if (options.mode === 'write') {
      if (++writes === 1) s.tool(id, actor, 'supercode_post', { text: 'Reviewer, confirm negatives are valid before I implement.', recipient: 'reviewer' })
      else {
        assert.match(prompt, /Negatives are valid/)
        s.tool(id, actor, 'supercode_task', { operation: 'submit', taskId: room.tasks[0].id, revision: room.tasks[0].revision, evidence: ['Verified numeric fixtures.'] })
      }
    } else if (prompt.includes('Answer the addressed')) {
      if (actor === 'reviewer') s.tool(id, actor, 'supercode_post', { text: 'Negatives are valid.', recipient: 'builder' })
    } else if (actor === 'reviewer') s.tool(id, actor, 'supercode_review', { taskId: room.tasks[0].id, revision: room.tasks[0].revision, verdict: 'pass', evidence: ['Independently inspected fixtures.'] })
    else {
      s.tool(id, actor, 'supercode_task', { operation: 'accept', taskId: room.tasks[0].id, revision: room.tasks[0].revision })
      s.tool(id, actor, 'supercode_finish', { summary: 'Implemented after peer clarification and independent review.' })
    }
  })
  await f.s.command(f.id, command('plan')); await idle(f.s, f.id)
  await f.s.command(f.id, command('approve', { revision: f.s.get(f.id).revision })); await idle(f.s, f.id)
  assert.equal(writes, 2); assert.equal(f.s.get(f.id).status, 'completed')
  assert.equal(f.s.get(f.id).tasks[0].attempts, 1)
  assert.equal(f.s.get(f.id).tasks[0].status, 'done')
})

test('saving model choices is durable, dispatch-free, and never rewrites historical identities', async t => {
  const f = await fixture(t)
  f.s.change(f.id, 'old-team', room => { room.status = 'stopped'; room.members[0].sessionId = 'old-native-lead' })
  const before = f.s.get(f.id)
  const next = before.members.map(member => ({ ...member, provider: 'chosen-provider', model: member.id + '-chosen', effort: 'high' }))
  const request = command('team', { revision: before.revision, members: next, leadId: 'lead' })
  await f.s.command(f.id, request); await f.s.command(f.id, request)
  const saved = new RoomStore(f.dir).get(f.id)
  assert.deepEqual(saved.members, before.members)
  assert.equal(saved.usage.calls, 0); assert.equal(f.calls.length, 0)
  assert.equal(saved.nextTeam.members[0].model, 'lead-chosen')
  assert.equal(saved.nextTeam.members[0].sessionId, undefined)
  await assert.rejects(f.s.command(f.id, command('message', { text: 'Do not use the old model' })), /new models are saved/)
  await f.s.command(f.id, command('new-run', { revision: saved.revision, goal: 'Use the chosen team.' }))
  const started = f.s.get(f.id)
  assert.deepEqual(started.members.map(member => member.model), ['lead-chosen', 'builder-chosen', 'reviewer-chosen'])
  assert.equal(started.members[0].provider, 'chosen-provider')
  assert.equal(started.members[0].effort, 'high')
  assert.equal(started.members[0].sessionId, undefined)
  assert.deepEqual(started.history[0].members, before.members)
  assert.equal(started.nextTeam, undefined); assert.equal(f.calls.length, 0)
})

test('model changes reject active runs, invalid connections and stale revisions', async t => {
  const f = await fixture(t)
  const draft = f.s.get(f.id)
  f.s.change(f.id, 'active-fixture', room => { room.status = 'running' })
  await assert.rejects(f.s.command(f.id, command('team', { revision: f.s.get(f.id).revision, members, leadId: 'lead' })), /active response/)
  await f.s.pause(f.id)
  await assert.rejects(f.s.command(f.id, command('team', { revision: draft.revision, members, leadId: 'lead' })), /Room changed/)
  f.s.validateModels = async () => { throw Error('Chosen model unavailable') }
  await assert.rejects(f.s.command(f.id, command('team', { revision: f.s.get(f.id).revision, members, leadId: 'lead' })), /unavailable/)
  assert.equal(f.s.get(f.id).nextTeam, undefined); assert.equal(f.calls.length, 0)
})
