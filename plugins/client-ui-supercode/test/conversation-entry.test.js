import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomStore } from '../lib/room-store.js'
import { RoomService } from '../lib/room-service.js'

const members = ['lead', 'builder', 'reviewer'].map(id => ({ id, name: id, role: id, provider: 'fixture', model: id }))
let serial = 0
const command = (action, extra = {}) => ({ action, requestId: `chat-${++serial}`, ...extra })
async function fixture(t, goal = 'hi') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supercode-chat-entry-'))
  const store = new RoomStore(dir), service = new RoomService({ store }), turns = []
  service.scheduler.start = () => {}
  service.attach({ registerRoom() {}, cancel: async () => {}, dispose: async () => {}, isBusy: () => false,
    run: async (id, actor, prompt, options) => {
      await service.reserveCall(id, actor); turns.push({ actor, prompt, ...options })
      return { assistantText: 'Hi! Good to see you.', diagnostic: { ok: true } }
    } })
  t.after(async () => { await service.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  const room = await service.create({ goal, members, leadId: 'lead' }, { id: 'workspace', name: 'Fixture', cwd: '/tmp/chat-project' })
  return { service, room, turns, dir }
}

test('a greeting gets one real chat reply, no investigation, board, approval or completion', async t => {
  const { service, room, turns, dir } = await fixture(t)
  await service.command(room.id, command('start'))
  await service.scheduler.loop(room.id)
  const after = service.get(room.id)
  assert.equal(turns.length, 1); assert.equal(turns[0].actor, 'lead'); assert.equal(turns[0].mode, 'chat')
  assert.match(turns[0].prompt, /greetings/i)
  assert.doesNotMatch(turns[0].prompt, /Your assigned action: Investigate/)
  assert.equal(after.status, 'draft'); assert.equal(after.chatOnly, true)
  assert.equal(after.reason, undefined); assert.equal(after.tasks.length, 0); assert.equal(after.approved, false)
  assert.equal(after.messages.at(-1).text, 'Hi! Good to see you.')
  assert.equal(new RoomStore(dir).get(room.id).status, 'draft')
})

test('thanks and ambiguous follow-ups stay conversational; @team wakes only the addressed roster', async t => {
  const { service, room, turns } = await fixture(t)
  await service.command(room.id, command('start')); await service.scheduler.loop(room.id)
  for (const text of ['thanks', 'How are you?', 'can you help?']) {
    await service.command(room.id, command('message', { text })); await service.scheduler.loop(room.id)
    assert.equal(service.get(room.id).status, 'draft')
  }
  assert.equal(turns.length, 4); assert(turns.every(turn => turn.actor === 'lead' && turn.mode === 'chat'))
  await service.command(room.id, command('message', { text: 'Hi everyone', recipient: 'team' })); await service.scheduler.loop(room.id)
  assert.deepEqual(turns.slice(4).map(turn => turn.actor), ['lead', 'builder', 'reviewer'])
  assert.equal(service.get(room.id).tasks.length, 0)
})

test('a subsequent concrete user request can enter existing investigation only after lead settlement', async t => {
  const { service, room } = await fixture(t)
  await service.command(room.id, command('start')); await service.scheduler.loop(room.id)
  await service.command(room.id, command('message', { text: 'Fix the broken login form and add a regression test.' }))
  const user = service.get(room.id).messages.at(-1)
  assert.throws(() => service.tool(room.id, 'builder', 'supercode_start_plan', { messageId: user.id }), /Only the lead/)
  assert.throws(() => service.tool(room.id, 'lead', 'supercode_start_plan', { messageId: 'fabricated' }), /current user/)
  assert.throws(() => service.tool(room.id, 'lead', 'supercode_task', { operation: 'propose' }), /conversation-only/)
  service.tool(room.id, 'lead', 'supercode_start_plan', { messageId: user.id })
  assert.equal(service.get(room.id).status, 'discussing')
  service.change(room.id, 'fixture-delivered', next => { next.queue = [] })
  service.settleOutcome(room.id, 'lead', { ok: true })
  const after = service.get(room.id)
  assert.equal(after.status, 'planning'); assert.equal(after.chatOnly, undefined)
  assert.equal(after.goal, user.text); assert.equal(after.approved, false)
  assert.match(service.admission(room.id, 'builder', { mode: 'write' }), /approve/)
})

test('failed or stale planning requests never authorize investigation or claim completion', async t => {
  const { service, room } = await fixture(t, 'Fix the login form.')
  await service.command(room.id, command('start'))
  const user = service.get(room.id).messages[0]
  service.tool(room.id, 'lead', 'supercode_start_plan', { messageId: user.id })
  service.settleOutcome(room.id, 'lead', { ok: false })
  assert.equal(service.get(room.id).pendingOutcome, undefined)
  assert.equal(service.get(room.id).status, 'discussing')
  await service.command(room.id, command('message', { text: 'Actually, just say hello.' }))
  assert.throws(() => service.tool(room.id, 'lead', 'supercode_start_plan', { messageId: user.id }), /current user/)
  assert.equal(service.get(room.id).tasks.length, 0)
})

test('legacy no-board planning failures recover by replying, without replaying old research', async t => {
  const { service, room, turns } = await fixture(t)
  service.change(room.id, 'legacy-failure', next => { next.status = 'blocked'; next.reason = 'The lead did not submit a task plan.'; next.queue = [{ memberId: 'builder', text: 'Inspect all files' }] })
  await service.command(room.id, command('message', { text: 'hi' })); await service.scheduler.loop(room.id)
  assert.equal(turns.length, 1); assert.equal(turns[0].mode, 'chat')
  assert.equal(service.get(room.id).reason, undefined); assert.equal(service.get(room.id).status, 'draft')
})

test('chat checkpoints and restart do not dispatch automatically or reset usage', async t => {
  const { service, room, turns, dir } = await fixture(t)
  await service.command(room.id, command('start')); await service.scheduler.loop(room.id)
  service.change(room.id, 'exhaust-budget', next => { next.limits.calls = 1 })
  await service.command(room.id, command('message', { text: 'hello again' }))
  assert.equal(service.get(room.id).status, 'paused'); assert.match(service.get(room.id).reason, /checkpoint/)
  assert.equal(turns.length, 1)
  const restored = new RoomStore(dir).get(room.id)
  assert.equal(restored.status, 'paused'); assert.equal(restored.usage.calls, 1); assert.equal(restored.chatOnly, true)
  await service.command(room.id, command('resume')); await service.scheduler.loop(room.id)
  assert.equal(turns.length, 2); assert.equal(service.get(room.id).usage.calls, 2)
  assert.equal(service.get(room.id).status, 'draft')
})

test('Continue on a legacy greeting-only failure returns to chat rather than repeating research', async t => {
  const { service, room, turns } = await fixture(t)
  service.change(room.id, 'legacy-paused', next => { next.status = 'paused'; next.reason = 'The lead did not submit a task plan.' })
  await service.command(room.id, command('resume')); await service.scheduler.loop(room.id)
  assert.equal(turns.length, 1); assert.equal(turns[0].mode, 'chat')
  assert.equal(service.get(room.id).status, 'draft'); assert.equal(service.get(room.id).reason, undefined)
})

test('an interrupted chat delivery is retained and retried only on explicit continuation', async t => {
  const { service, room, turns } = await fixture(t)
  const original = service.runtime.run
  service.runtime.run = async (...args) => { await original(...args); return { diagnostic: { ok: false, message: 'Provider unavailable' } } }
  await service.command(room.id, command('start')); await service.scheduler.loop(room.id)
  await service.pause(room.id, 'Provider unavailable', 'blocked')
  assert.equal(service.get(room.id).chatInFlight.lead.length, 1)
  assert.equal(service.get(room.id).messages.filter(item => item.kind === 'agent').length, 0)
  assert.equal(service.get(room.id).status, 'blocked'); assert.equal(turns.length, 1)
  service.runtime.run = original
  await service.command(room.id, command('resume'))
  assert.equal(service.get(room.id).queue.length, 1)
  await service.scheduler.loop(room.id)
  assert.equal(service.get(room.id).status, 'draft'); assert.equal(turns.length, 2)
  assert.equal(service.get(room.id).messages.filter(item => item.kind === 'agent').length, 1)
})

test('a new user message cancels a not-yet-settled planning request', async t => {
  const { service, room } = await fixture(t, 'Fix the login form.')
  await service.command(room.id, command('start'))
  service.tool(room.id, 'lead', 'supercode_start_plan', { messageId: service.get(room.id).messages[0].id })
  await service.command(room.id, command('message', { text: 'Never mind, just saying hi.' }))
  service.settleOutcome(room.id, 'lead', { ok: true })
  assert.equal(service.get(room.id).pendingOutcome, undefined)
  assert.equal(service.get(room.id).status, 'discussing'); assert.equal(service.get(room.id).chatOnly, true)
})


test('a crash between reply settlement and planning admission retains the user delivery', async t => {
  const { service, room, dir } = await fixture(t, 'Fix login.')
  await service.command(room.id, command('start'))
  const queued = service.get(room.id).queue[0]
  service.change(room.id, 'delivering', next => { next.queue = []; next.chatInFlight = { lead: [queued] } })
  service.tool(room.id, 'lead', 'supercode_start_plan', { messageId: queued.messageId })
  const restored = new RoomStore(dir).get(room.id)
  assert.equal(restored.status, 'paused'); assert.equal(restored.pendingOutcome, undefined)
  assert.equal(restored.chatInFlight.lead[0].messageId, queued.messageId)
  service.store.rooms.set(room.id, restored)
  await service.command(room.id, command('resume'))
  assert.equal(service.get(room.id).queue.length, 1)
  assert.equal(service.get(room.id).queue[0].messageId, queued.messageId)
})

test('an admitted coding plan resumes its existing investigation rather than reclassifying the request', async t => {
  const { service, room } = await fixture(t, 'Fix login.')
  await service.command(room.id, command('start'))
  const user = service.get(room.id).messages[0]
  service.tool(room.id, 'lead', 'supercode_start_plan', { messageId: user.id })
  service.change(room.id, 'delivered', next => { next.queue = [] })
  service.settleOutcome(room.id, 'lead', { ok: true })
  await service.pause(room.id)
  await service.command(room.id, command('resume'))
  assert.equal(service.get(room.id).status, 'planning')
  assert.equal(service.get(room.id).chatOnly, undefined)
})
