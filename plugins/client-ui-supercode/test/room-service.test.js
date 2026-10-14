import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoomStore } from '../lib/room-store.js'
import { RoomService } from '../lib/room-service.js'
import { createRoom, changeTask, reviewTask, roster } from '../lib/room-state.js'
import { registerTeamTools } from '../lib/tools.js'
import { RoomScheduler } from '../lib/scheduler.js'

const members = ['lead', 'builder', 'reviewer'].map(id => ({ id, name: id, role: id, provider: 'fixture', model: id }))
const input = (extra = {}) => ({ goal: 'Add a tested greeting.', members, leadId: 'lead', ...extra })
const workspace = { id: 'fixture', cwd: '/tmp/supercode-project', name: 'Fixture' }
function harness(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supercode-state-'))
  const store = new RoomStore(dir), service = new RoomService({ store, ...options })
  service.scheduler.start = () => {}
  service.attach({ registerRoom() {}, cancel: async () => {}, dispose: async () => {} })
  t.after(async () => { await service.dispose(); fs.rmSync(dir, { recursive: true, force: true }) })
  return { dir, store, service }
}
let request = 0
const command = (action, extra = {}) => ({ requestId: `request-${++request}`, action, ...extra })
function propose(service, id) {
  return service.tool(id, 'lead', 'supercode_task', { operation: 'propose', title: 'Greeting', ownerId: 'builder', criteria: 'Greeting test passes.' }).task
}

test('app disposal pauses teardown-blocked work, retains its diagnostic and closes model admission', async t => {
  const { service, dir } = harness(t)
  const room = await service.create(input(), workspace)
  service.change(room.id, 'teardown-fixture', next => { next.status = 'blocked'; next.reason = 'Native turn cancelled during shutdown.' })
  await service.dispose()
  const restored = new RoomStore(dir).get(room.id)
  assert.equal(restored.status, 'paused')
  assert.match(restored.reason, /Native turn cancelled during shutdown/)
  assert.match(service.admission(room.id, 'lead'), /app is closing/)
  assert.equal(restored.tasks.length, 0)
})
async function planned(service, extra) {
  const room = await service.create(input(extra), workspace)
  await service.command(room.id, command('plan'))
  const task = propose(service, room.id)
  service.tool(room.id, 'lead', 'supercode_plan_ready', {})
  service.settleOutcome(room.id, 'lead', { ok: true })
  return { id: room.id, task }
}
async function running(service, extra) {
  const room = await planned(service, extra)
  await service.command(room.id, command('approve', { revision: service.get(room.id).revision }))
  return room
}

test('two to five distinct identities are required; same model is allowed', () => {
  assert.throws(() => roster(members.slice(0, 1), 'lead'), /two and five/)
  assert.throws(() => roster([...members, ...members], 'lead'), /two and five/)
  assert.throws(() => roster([members[0], members[0]], 'lead'), /unique/)
  assert.throws(() => roster(members, 'missing'), /lead/)
  assert.equal(roster(members.map(m => ({ ...m, model: 'same' })), 'lead').length, 3)
})

test('room creation retries and concurrent validation share one durable chat identity', async t => {
  const { service, store } = harness(t, { validateModels: async () => { await new Promise(resolve => setImmediate(resolve)) } })
  const values = input({ requestId: 'create-one' })
  const [a, b] = await Promise.all([service.create(values, workspace), service.create(values, workspace)])
  assert.equal(a.id, b.id); assert.equal(store.list().length, 1)
  assert.equal((await service.create(values, workspace)).id, a.id)
  await assert.rejects(service.create({ ...values, goal: 'Another goal' }, workspace), /another conversation/)
})

test('actual native defineTool schemas compile; identity is not supplied by the model', async () => {
  const definitions = []
  registerTeamTools({ tools: { register(tool) { definitions.push(tool); return () => {} } } }, { runtime: { identify: () => null } })
  assert.equal(definitions.length, 7)
  assert.equal(definitions[1].parameters?.senderId, undefined)
})

test('journal persists events, cleared keys and deduplicated user requests', async t => {
  const { service, dir } = harness(t)
  const room = await service.create(input(), workspace)
  const message = command('message', { text: 'Keep it small.' })
  await service.command(room.id, message); await service.command(room.id, message)
  service.change(room.id, 'old-reason', next => { next.reason = 'Old error.' })
  await service.command(room.id, command('message', { text: 'This clears the old reason.' }))
  assert.equal(service.get(room.id).reason, undefined)
  const restored = new RoomStore(dir).get(room.id)
  assert.equal(restored.messages.filter(m => m.text === 'Keep it small.').length, 1)
  assert.match(restored.reason, /app restarted/)
  assert.doesNotMatch(restored.reason, /Old error/)
  assert.equal(restored.revision, service.get(room.id).revision + 1)
})

test('public assistant messages are durable before settlement and replay without aggregate duplicates', async t => {
  const { service, dir } = harness(t), { id } = await running(service)
  service.persistMemberSession(id, 'builder', 'native-builder')
  const base = { type: 'assistant', memberId: 'builder', runId: service.get(id).runId, sessionId: 'native-builder' }
  const first = { ...base, messageId: 'message-1', text: 'I found the existing greeting API.' }
  const second = { ...base, messageId: 'message-2', text: 'The tests cover its current behavior.' }
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  service.runtime.run = async (_id, _member, prompt) => {
    assert.match(prompt, /public assistant text appears/)
    assert.match(prompt, /never private reasoning/)
    service.emit(id, first); entered()
    await new Promise(resolve => { release = resolve })
    return { assistantText: first.text + '\n\n' + second.text, assistantMessages: [first, second], diagnostic: { ok: true } }
  }
  const turn = service.scheduler.turn(id, 'builder', 'Inspect')
  await started
  assert.equal(service.get(id).memberStates.builder, 'Reviewing')
  assert.equal(service.get(id).messages.filter(entry => entry.nativeMessageId === 'message-1').length, 1)
  assert.ok(fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8').includes(first.text))
  release(); await turn
  const delivered = service.get(id).messages.filter(entry => entry.nativeMessageId)
  assert.deepEqual(delivered.map(entry => entry.text), [first.text, second.text])
  assert.equal(service.get(id).messages.some(entry => entry.text === first.text + '\n\n' + second.text), false)
  await service.pause(id)
  const restored = new RoomStore(dir)
  assert.deepEqual(restored.get(id).messages.filter(entry => entry.nativeMessageId), delivered)
  const resumed = new RoomService({ store: restored })
  t.after(() => resumed.dispose())
  const revision = restored.get(id).revision
  resumed.emit(id, first)
  assert.equal(restored.get(id).revision, revision, 'Journal replay should not append a duplicate')
})

test('public message projection refuses stale run and mismatched native member identities', async t => {
  const { service } = harness(t), { id } = await running(service)
  service.persistMemberSession(id, 'builder', 'native-builder')
  const event = { type: 'assistant', memberId: 'builder', runId: service.get(id).runId, sessionId: 'native-builder', messageId: 'public', text: 'Useful result.' }
  const revision = service.get(id).revision
  for (const change of [{ runId: 'old-run' }, { sessionId: 'native-lead' }, { memberId: 'unknown' }, { messageId: '' }]) service.emit(id, { ...event, ...change })
  assert.equal(service.get(id).revision, revision)
  service.emit(id, event)
  service.emit(id, { ...event, text: 'Changed replay must not replace original text.' })
  assert.equal(service.get(id).messages.filter(entry => entry.nativeMessageId).length, 1)
  assert.equal(service.get(id).messages.at(-1).text, event.text)
})

test('explicit peer questions persist recipient attribution and use the existing scheduled queue', async t => {
  const { service, dir } = harness(t), { id } = await running(service)
  service.tool(id, 'builder', 'supercode_post', { text: 'Reviewer, does this preserve the existing API?', recipient: 'reviewer' })
  const entry = service.get(id).messages.at(-1)
  assert.equal(entry.recipient, 'reviewer')
  assert.equal(entry.memberId, 'builder')
  assert.equal(service.get(id).queue[0].messageId, entry.id)
  assert.equal(service.get(id).usage.calls, 0)
  await service.pause(id)
  assert.equal(new RoomStore(dir).get(id).messages.at(-1).recipient, 'reviewer')
})

test('restart pauses active runs; working task is interrupted not completed', async t => {
  const { service, dir } = harness(t), { id, task } = await running(service)
  service.change(id, 'fixture-work', room => { room.tasks[0].status = 'working' })
  const restored = new RoomStore(dir).get(id)
  assert.equal(restored.status, 'paused')
  assert.equal(restored.tasks[0].id, task.id)
  assert.equal(restored.tasks[0].status, 'blocked')
  assert.equal(restored.tasks[0].interrupted, true)
  assert.equal(restored.startedAt, null)
})

test('incomplete journal tail is repaired but committed corruption fails closed', async t => {
  const { service, dir } = harness(t), room = await service.create(input(), workspace)
  const file = path.join(dir, `${room.id}.jsonl`)
  fs.appendFileSync(file, '{"incomplete":')
  assert.equal(new RoomStore(dir).list().length, 1)
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('\n'))
  fs.appendFileSync(file, 'not json\n')
  const broken = new RoomStore(dir)
  assert.equal(broken.list().length, 0)
  assert.equal(broken.errors.length, 1)
  assert.ok(fs.readFileSync(file, 'utf8').includes('not json'))
})

test('plan approval cannot bypass read-only access or optimistic revisions', async t => {
  const { service } = harness(t), { id } = await planned(service, { permissionPreset: 'read-only' })
  assert.notEqual(service.admission(id, 'builder', { mode: 'write' }), true)
  const revision = service.get(id).revision
  await assert.rejects(service.command(id, command('approve', { revision: revision - 1 })), /changed/)
  await service.command(id, command('approve', { revision }))
  assert.match(service.admission(id, 'builder', { mode: 'write' }), /read-only/)
})

test('approval rechecks revision after async model validation', async t => {
  const { service } = harness(t), { id } = await planned(service)
  let unblock; service.validateModels = () => new Promise(resolve => { unblock = resolve })
  const approving = service.command(id, command('approve', { revision: service.get(id).revision }))
  service.change(id, 'concurrent-edit', room => { room.tasks[0].criteria = 'New criteria.' })
  unblock()
  await assert.rejects(approving, /changed/)
  assert.equal(service.get(id).approved, false)
})

test('task transitions require owner, evidence, independent review and lead acceptance', () => {
  const room = createRoom(input(), workspace)
  const task = changeTask(room, { operation: 'propose', title: 'Greeting', ownerId: 'builder', criteria: 'Test greeting.' }, 'lead')
  assert.throws(() => changeTask(room, { operation: 'update', taskId: task.id, revision: 0, status: 'done' }, null, true), /Completion requires/)
  task.status = 'working'
  assert.throws(() => changeTask(room, { operation: 'submit', taskId: task.id, revision: 0, evidence: [] }, 'builder'), /evidence/)
  changeTask(room, { operation: 'submit', taskId: task.id, revision: 0, evidence: ['node test.js: PASS'] }, 'builder')
  assert.throws(() => changeTask(room, { operation: 'accept', taskId: task.id, revision: 1 }, 'lead'), /independently/)
  task.reviewerId = 'reviewer'
  assert.throws(() => reviewTask(room, { taskId: task.id, revision: 1, verdict: 'pass', evidence: ['Self review'] }, 'builder'), /independent/)
  reviewTask(room, { taskId: task.id, revision: 1, verdict: 'pass', evidence: ['Read greeting implementation and test; result matches.'] }, 'reviewer')
  assert.throws(() => changeTask(room, { operation: 'accept', taskId: task.id, revision: 1 }, 'lead'), /changed/)
  changeTask(room, { operation: 'accept', taskId: task.id, revision: 2 }, 'lead')
  assert.equal(task.status, 'done')
})

test('two concurrent task edits cannot overwrite one revision', async t => {
  const { service } = harness(t), { id, task } = await planned(service)
  const base = { revision: service.get(id).revision, task: { operation: 'update', taskId: task.id, revision: task.revision, title: 'Edited' } }
  const result = await Promise.allSettled([service.command(id, command('task', base)), service.command(id, command('task', base))])
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(result.filter(r => r.status === 'rejected').length, 1)
})

test('workspace stays owned until cancellation drains; Stop wins over a pending pause', async t => {
  const { service } = harness(t), { id } = await running(service)
  const second = await service.create(input(), workspace)
  await assert.rejects(service.command(second.id, command('plan')), /Another SuperCode/)
  let release; service.runtime.cancel = () => new Promise(resolve => { release = resolve })
  const pause = service.pause(id, 'Checkpoint reached.')
  const stop = service.command(id, command('stop'))
  assert.equal(service.get(id).status, 'pausing')
  await assert.rejects(service.command(second.id, command('plan')), /Another SuperCode/)
  release(); await Promise.all([pause, stop])
  assert.equal(service.get(id).status, 'stopped')
  service.runtime.cancel = async () => {}
  await service.command(second.id, command('plan'))
})

test('call cap reserves exactly N dispatches and Resume starts the next checkpoint', async t => {
  const { service } = harness(t), { id } = await running(service, { limits: { calls: 2, minutes: 60 } })
  await service.reserveCall(id, 'lead'); await service.reserveCall(id, 'builder')
  assert.equal(service.admission(id, 'builder', { kind: 'model-reserved' }), true)
  await assert.rejects(service.reserveCall(id, 'reviewer'), /checkpoint/)
  await service.pause(id)
  assert.equal(service.get(id).usage.calls, 2)
  await service.command(id, command('resume'))
  await service.reserveCall(id, 'reviewer')
  assert.equal(service.get(id).usage.calls, 3)
})

test('active-time cap excludes pauses and never implies completion', async t => {
  let now = 1000
  const { service } = harness(t, { now: () => now }), { id } = await running(service, { limits: { minutes: 1, calls: 200 } })
  now += 60000
  assert.match(service.admission(id, 'lead'), /Runtime checkpoint/)
  await service.pause(id, service.limitReason(service.get(id)))
  now += 3600000
  assert.equal(service.view(id).usage.activeMs, 60000)
  assert.equal(service.get(id).status, 'paused')
})

test('failed process drainage retains the workspace lock until an explicit retry succeeds', async t => {
  const { service } = harness(t), { id } = await running(service)
  const second = await service.create(input(), workspace)
  service.runtime.cancel = async () => { throw new Error('Owned job still running') }
  await assert.rejects(service.pause(id), /Owned job/)
  assert.equal(service.get(id).status, 'pausing')
  await assert.rejects(service.command(second.id, command('plan')), /Another SuperCode/)
  service.runtime.cancel = async () => {}
  await service.command(id, command('stop'))
  assert.equal(service.get(id).status, 'stopped')
})

test('last admitted model response may finish tools but cannot dispatch another model call', async t => {
  const { service } = harness(t), { id } = await running(service, { limits: { calls: 1, minutes: 60 } })
  await service.reserveCall(id, 'builder')
  assert.equal(service.admission(id, 'builder', { kind: 'tool', mode: 'write' }), true)
  assert.equal(service.admission(id, 'builder', { kind: 'step', mode: 'write' }), true)
  await assert.rejects(service.reserveCall(id, 'builder'), /checkpoint/)
})

test('journal write failure immediately closes admission and does not spin the scheduler', async t => {
  const { service, store } = harness(t), { id } = await running(service)
  let cancelled = 0
  service.runtime.cancel = async () => { cancelled++ }
  const write = fs.writeSync
  try {
    fs.writeSync = () => { throw new Error('Disk unavailable') }
    assert.throws(() => service.change(id, 'failed-write', room => { room.reason = 'Uncommitted' }), /Could not save/)
  } finally { fs.writeSync = write }
  assert.equal(store.failed.has(id), true)
  assert.equal(cancelled, 1)
  for (const kind of ['model', 'model-reserved', 'step', 'tool']) assert.match(service.admission(id, 'builder', { mode: 'write', kind }), /Journal write failed/)
  const scheduler = new RoomScheduler(service)
  let starts = 0; scheduler.loop = async () => { starts++ }
  scheduler.start(id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(starts, 0)
  assert.match(service.view(id).reason, /Restart/)
})

test('explicit cancellation of interrupted work survives a later approval and Resume', async t => {
  const { service } = harness(t), { id, task } = await running(service)
  service.change(id, 'test-start', room => { room.tasks[0].status = 'working' })
  await service.pause(id)
  await service.command(id, command('task', { revision: service.get(id).revision, task: { operation: 'cancel', taskId: task.id, revision: service.get(id).tasks[0].revision } }))
  await service.command(id, command('task', { revision: service.get(id).revision, task: { operation: 'propose', title: 'Remaining authorized task', ownerId: 'builder', criteria: 'Verified result.' } }))
  await service.command(id, command('approve', { revision: service.get(id).revision }))
  await service.pause(id)
  await service.command(id, command('resume'))
  assert.equal(service.get(id).tasks[0].status, 'cancelled')
})

test('directed guidance is answered once before approval and not repeated after approval', async t => {
  const { service } = harness(t), { id } = await planned(service)
  const prompts = []
  service.runtime.run = async (_id, _member, prompt) => { prompts.push(prompt); return { diagnostic: { ok: true } } }
  await service.command(id, command('message', { recipient: 'builder', text: 'Keep the existing API unchanged.' }))
  assert.equal(service.get(id).queue.length, 1)
  await service.scheduler.loop(id)
  assert.equal(service.get(id).status, 'awaiting-approval')
  await service.command(id, command('approve', { revision: service.get(id).revision }))
  assert.match(prompts[0], /Addressed room messages.*\nuser .*Keep the existing API unchanged\./s)
  assert.equal(service.get(id).queue.length, 0)
  await service.scheduler.turn(id, 'builder', 'Inspect your task again.')
  assert.doesNotMatch(prompts[1], /Addressed room messages/)
})

test('unavailable selected model fails visibly without substitution or startup', async t => {
  const { service } = harness(t), { id } = await planned(service)
  service.validateModels = async () => { throw new Error('Selected model unavailable') }
  await assert.rejects(service.command(id, command('approve', { revision: service.get(id).revision })), /unavailable/)
  assert.equal(service.get(id).status, 'awaiting-approval')
  assert.equal(service.get(id).members[0].model, 'lead')
})

test('continued room archives identities and creates fresh native session ownership', async t => {
  const { service, dir } = harness(t), { id } = await running(service)
  service.persistMemberSession(id, 'lead', 'native-old')
  await service.command(id, command('stop'))
  const oldRunId = service.get(id).runId
  const changed = members.map(m => ({ ...m, name: `${m.name} II`, model: `${m.model}-next` }))
  await service.command(id, command('new-run', { revision: service.get(id).revision, goal: 'Second goal', members: changed, leadId: 'lead' }))
  const room = new RoomStore(dir).get(id)
  assert.notEqual(room.runId, oldRunId)
  assert.equal(room.members[0].sessionId, undefined)
  assert.equal(room.members[0].model, 'lead-next')
  assert.equal(room.history[0].members[0].sessionId, 'native-old')
  assert.equal(room.history[0].members[0].name, 'lead')
  assert.equal(room.status, 'draft')
})

test('a successful model response alone cannot complete or submit a task', async t => {
  const { service } = harness(t), { id } = await running(service)
  service.runtime.run = async () => ({ assistantText: 'Everything is done!', diagnostic: { ok: true }, usage: {} })
  // Drive the actual scheduler loop, not the disabled automatic start.
  await service.scheduler.loop(id)
  await service.pause(id)
  assert.equal(service.get(id).status, 'blocked')
  assert.equal(service.get(id).tasks[0].status, 'blocked')
  assert.throws(() => service.tool(id, 'lead', 'supercode_finish', { summary: 'Done' }), /not running/)
})

test('plan and completion outcomes wait for every native grant and fail closed on interruption', async t => {
  const { service } = harness(t), room = await service.create(input(), workspace)
  const second = await service.create(input(), workspace)
  await service.command(room.id, command('plan'))
  propose(service, room.id)
  service.tool(room.id, 'lead', 'supercode_plan_ready', {})
  assert.equal(service.get(room.id).status, 'planning')
  await assert.rejects(service.command(second.id, command('plan')), /Another SuperCode/)
  let busy = true; service.runtime.isBusy = () => busy
  service.settleOutcome(room.id, 'lead', { ok: true })
  assert.equal(service.get(room.id).status, 'planning')
  busy = false; service.settleOutcome(room.id, 'reviewer', { ok: true })
  assert.equal(service.get(room.id).status, 'awaiting-approval')
  await service.command(room.id, command('approve', { revision: service.get(room.id).revision }))
  service.change(room.id, 'verified-fixture', next => { next.tasks[0].status = 'done' })
  service.tool(room.id, 'lead', 'supercode_finish', { summary: 'Verified.' })
  assert.equal(service.get(room.id).status, 'running')
  service.settleOutcome(room.id, 'lead', { ok: false })
  assert.equal(service.get(room.id).status, 'running')
  assert.equal(service.get(room.id).pendingOutcome, undefined)
  assert.equal(service.get(room.id).messages.some(entry => entry.text === 'Verified.'), false)
  service.tool(room.id, 'lead', 'supercode_finish', { summary: 'Verified.' })
  service.settleOutcome(room.id, 'lead', { ok: true })
  assert.equal(service.get(room.id).status, 'completed')
})

test('approval-required work becomes visible and blocked without granting permission', async t => {
  const { service } = harness(t), { id } = await running(service)
  let cancelled = false; service.runtime.cancel = async () => { cancelled = true }
  service.emit(id, { type: 'approval', memberId: 'builder', name: 'bash' })
  await service.pauses.get(id).promise
  assert.equal(cancelled, true)
  assert.equal(service.get(id).status, 'blocked')
  assert.match(service.get(id).reason, /builder needs separate permission for bash/)
  assert.match(service.get(id).reason, /No permission was granted/)
  assert.equal(service.get(id).permissionPreset, 'workspace-write')
})
