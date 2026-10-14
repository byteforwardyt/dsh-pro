import { randomUUID } from 'node:crypto'

export class RoomError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}
export const RUNNABLE = new Set(['planning', 'running', 'discussing'])
export const ACTIVE = new Set([...RUNNABLE, 'pausing'])
export const TERMINAL = new Set(['completed', 'stopped'])
export const TASK_STATES = ['backlog', 'ready', 'working', 'review', 'done', 'blocked', 'cancelled']
export function check(value, message, status = 400) { if (!value) throw new RoomError(message, status) }
export function text(value, name, max = 8000) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${name} is required (maximum ${max} characters).`)
  return value.trim()
}
export function identifier(value) {
  check(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value), 'Invalid identifier.')
  return value
}
export function member(room, id) {
  const result = room.members.find(item => item.id === id)
  check(result, 'This agent is not a member of the room.', 403)
  return result
}
export function roster(input, leadId) {
  check(Array.isArray(input) && input.length >= 2 && input.length <= 5, 'Choose between two and five agents.')
  const members = input.map(item => ({
    id: identifier(item.id), name: text(item.name, 'Agent name', 60), role: text(item.role, 'Agent role', 60),
    provider: text(item.provider, 'Provider', 512), model: text(item.model, 'Model', 512),
    ...(item.effort ? { effort: text(item.effort, 'Effort', 40) } : {}),
    instructions: typeof item.instructions === 'string' ? item.instructions.slice(0, 8000) : '',
  }))
  check(new Set(members.map(item => item.id)).size === members.length, 'Agent identities must be unique.')
  check(members.some(item => item.id === leadId), 'Choose a lead from this team.')
  return members
}
export function limits(input = {}) {
  const minutes = input.minutes ?? 60, calls = input.calls ?? 200
  check(Number.isInteger(minutes) && minutes >= 1 && minutes <= 240, 'Choose a checkpoint between 1 and 240 minutes.')
  check(Number.isInteger(calls) && calls >= 1 && calls <= 1000, 'Choose a model-call checkpoint between 1 and 1000 calls.')
  return { minutes, calls }
}
export function createRoom(input, workspace, now = Date.now()) {
  const goal = text(input.goal, 'Goal', 16000)
  const members = roster(input.members, input.leadId)
  const permissionPreset = input.permissionPreset ?? 'workspace-write'
  check(['workspace-write', 'read-only', 'danger-full-access'].includes(permissionPreset), 'Invalid access preset.')
  return { version: 1, id: randomUUID(), title: goal.slice(0, 80), workspace, goal, members, leadId: input.leadId,
    permissionPreset, limits: limits(input.limits), status: 'draft', phase: 'planning', revision: 0,
    runId: randomUUID(), runNumber: 1, approved: false, tasks: [], messages: [], queue: [], history: [],
    memberStates: Object.fromEntries(members.map(item => [item.id, 'Waiting'])),
    usage: { calls: 0, input: 0, output: 0, cost: null, activeMs: 0 },
    checkpoint: { calls: 0, activeMs: 0 }, startedAt: null, createdAt: now, updatedAt: now, requests: [], failures: 0 }
}
export function message(room, kind, body, memberId = null, extra = {}) {
  const entry = { id: randomUUID(), runId: room.runId, kind, text: text(body, 'Message', 32000), memberId,
    createdAt: Date.now(), ...extra }
  room.messages.push(entry)
  return entry
}
export function compact(room, { before, limit = 20, includeTools = false } = {}) {
  check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'History limit must be between 1 and 100.')
  check(typeof includeTools === 'boolean', 'includeTools must be a boolean.')
  const history = room.messages.filter(entry => includeTools || entry.kind !== 'tool')
  const end = before === undefined ? history.length : history.findIndex(entry => entry.id === before)
  check(end >= 0, 'History cursor not found.', 404)
  const start = Math.max(0, end - limit), messages = history.slice(start, end)
  return { id: room.id, runId: room.runId, goal: room.goal, phase: room.phase, status: room.status,
    ...(room.chatOnly ? { chatOnly: true } : {}),
    members: room.members.map(({ id, name, role, model }) => ({ id, name, role, model })), leadId: room.leadId,
    tasks: room.tasks, messages, usage: room.usage,
    history: { total: history.length, hasMore: start > 0, ...(start > 0 ? { nextBefore: messages[0].id } : {}) },
    ...(room.pendingOutcome ? { pendingOutcome: room.pendingOutcome.kind, nextAction: 'End this turn now. The host will publish the outcome after tools and processes settle.' } : {}),
    ...(room.reason ? { reason: room.reason } : {}) }
}
export function elapsed(room, now = Date.now()) {
  return room.usage.activeMs + (room.startedAt === null ? 0 : Math.max(0, now - room.startedAt))
}
export function stopClock(room, now = Date.now()) { room.usage.activeMs = elapsed(room, now); room.startedAt = null }
export function dependenciesValid(room) {
  const seen = new Set(), visiting = new Set()
  const walk = id => {
    check(!visiting.has(id), 'Task dependencies cannot contain cycles.')
    if (seen.has(id)) return
    const task = room.tasks.find(item => item.id === id)
    check(task, 'A task dependency no longer exists.')
    visiting.add(id); task.dependencies.forEach(walk); visiting.delete(id); seen.add(id)
  }
  room.tasks.forEach(task => walk(task.id))
}
function evidence(input) {
  check(Array.isArray(input) && input.length > 0 && input.length <= 20, 'Attach at least one concrete result or test evidence entry.')
  return input.map(item => text(item, 'Evidence', 4000))
}
export function changeTask(room, input, actor = null, user = false) {
  const operation = input.operation || (input.id ? 'update' : 'propose')
  const lead = actor === room.leadId
  if (!user) member(room, actor)
  if (operation === 'propose') {
    check(room.tasks.length < 100, 'A run can contain at most 100 tasks.')
    const ownerId = member(room, input.ownerId).id
    const task = { id: randomUUID(), title: text(input.title, 'Task title', 200), ownerId, status: 'backlog',
      dependencies: input.dependencies ?? [], criteria: text(input.criteria, 'Acceptance criteria', 4000),
      evidence: [], revision: 0, approved: false, attempts: 0 }
    check(Array.isArray(task.dependencies) && task.dependencies.every(id => typeof id === 'string'), 'Invalid dependencies.')
    room.tasks.push(task); dependenciesValid(room)
    // New implementation scope after approval is never silently admitted.
    if (room.phase === 'execution') { room.status = 'pausing'; room.reason = 'New tasks need your approval.'; room.approved = false }
    return task
  }
  const task = room.tasks.find(item => item.id === (input.taskId || input.id))
  check(task, 'Task not found.', 404)
  check(input.revision === task.revision, 'Task changed. Read the board again before updating it.', 409)
  check(user || lead || task.ownerId === actor, 'Only this task’s owner or the lead can update it.', 403)
  if (operation === 'submit') {
    check(!user && task.ownerId === actor && task.status === 'working', 'Only the working task’s owner can submit it.')
    task.evidence = evidence(input.evidence); task.status = 'review'; delete task.review
  } else if (operation === 'accept') {
    check(lead && task.status === 'review' && task.review?.verdict === 'pass' && task.review.memberId !== task.ownerId,
      'The lead can accept only independently reviewed work.')
    task.status = 'done'
  } else if (operation === 'block') {
    task.status = 'blocked'; task.evidence = evidence(input.evidence)
  } else if (operation === 'cancel') {
    check(user || lead, 'Only the user or lead can cancel a task.', 403)
    check(task.status !== 'working', 'Pause before cancelling work in progress.', 409)
    task.status = 'cancelled'
    delete task.interrupted
  } else {
    check(operation === 'update', 'Unknown task operation.')
    check(user || lead, 'Only the user or lead may change task assignments.', 403)
    check(!['working', 'review', 'done'].includes(task.status), 'Pause or finish the active task before changing its assignment.', 409)
    if (input.title !== undefined) task.title = text(input.title, 'Task title', 200)
    if (input.ownerId !== undefined) task.ownerId = member(room, input.ownerId).id
    if (input.criteria !== undefined) task.criteria = text(input.criteria, 'Acceptance criteria', 4000)
    if (input.dependencies !== undefined) {
      check(Array.isArray(input.dependencies) && input.dependencies.every(id => typeof id === 'string'), 'Invalid dependencies.')
      task.dependencies = input.dependencies
    }
    if (input.status !== undefined) {
      check(['backlog', 'ready', 'blocked', 'cancelled'].includes(input.status), 'Completion requires submission and independent review.')
      task.status = input.status
      delete task.interrupted
    }
    if (room.phase === 'execution') { task.approved = false; room.approved = false; room.status = 'pausing'; room.reason = 'Changed task scope needs approval.' }
  }
  task.revision++; dependenciesValid(room); return task
}
export function reviewTask(room, input, actor) {
  member(room, actor)
  const task = room.tasks.find(item => item.id === input.taskId)
  check(task && task.status === 'review', 'This task is not awaiting review.')
  check(task.revision === input.revision, 'Task changed. Read it again.', 409)
  check(actor !== task.ownerId && task.reviewerId === actor, 'Only the assigned independent reviewer can submit this review.', 403)
  check(['pass', 'changes'].includes(input.verdict), 'Review must pass or request changes.')
  task.review = { memberId: actor, verdict: input.verdict, evidence: evidence(input.evidence), createdAt: Date.now() }
  if (input.verdict === 'changes') task.status = 'ready'
  task.revision++
  return task
}
