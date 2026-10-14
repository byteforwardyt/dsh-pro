import { randomUUID } from 'node:crypto'
import { ACTIVE, RUNNABLE, TERMINAL, RoomError, check, text, member, compact, createRoom, roster, limits,
  message, elapsed, stopClock, changeTask, reviewTask, dependenciesValid } from './room-state.js'
import { RoomScheduler } from './scheduler.js'

export class RoomService {
  constructor({ store, validateModels = async () => {}, now = Date.now }) {
    this.store = store; this.validateModels = validateModels; this.now = now; this.runtime = null; this.pauses = new Map()
    this.scheduler = new RoomScheduler(this)
    this.onStoreFault = id => { void this.runtime?.cancel(id).catch(() => {}) }
    store.on('fault', this.onStoreFault)
    this.timer = setInterval(() => {
      for (const room of store.list()) if (!store.failed.has(room.id) && ACTIVE.has(room.status) && room.status !== 'pausing' && elapsed(room, this.now()) - room.checkpoint.activeMs >= room.limits.minutes * 60000) {
        void this.pause(room.id, 'Runtime checkpoint reached. Review progress and Resume.').catch(() => {})
      }
    }, 1000)
    this.timer.unref?.()
  }
  attach(runtime) { this.runtime = runtime; this.store.list().forEach(room => runtime.registerRoom(room)) }
  get(id) { return this.store.get(id) }
  view(id) {
    const room = this.get(id); room.usage.activeMs = elapsed(room, this.now())
    if (this.store.failed.has(id)) {
      room.usage.activeMs = elapsed(this.get(id), room.updatedAt); room.startedAt = null
      room.status = 'pausing'; room.reason = 'Journal write failed. Further work is disabled. Restart the app before resuming this room.'
    }
    return room
  }
  change(id, kind, fn) { return this.store.change(id, null, kind, fn) }
  async create(input, workspace) {
    if (input.requestId) {
      const existing = this.store.list().find(room => room.createRequestId === input.requestId)
      if (existing) {
        check(existing.workspace.id === workspace.id && existing.goal === input.goal, 'Creation request already belongs to another conversation.', 409)
        return existing
      }
    }
    const room = createRoom(input, workspace, this.now())
    if (input.requestId) room.createRequestId = text(input.requestId, 'Request identity', 100)
    await this.validateModels(room.members)
    // Validation may yield. A concurrent retry that committed while it was
    // pending owns this creation identity; do not append a second room.
    if (input.requestId) {
      const existing = this.store.list().find(row => row.createRequestId === input.requestId)
      if (existing) {
        check(existing.workspace.id === workspace.id && existing.goal === input.goal, 'Creation request already belongs to another conversation.', 409)
        return existing
      }
    }
    message(room, 'user', room.goal)
    return this.store.add(room)
  }
  ensureWorkspace(room) {
    check(!this.store.list().some(other => other.id !== room.id && other.workspace.cwd === room.workspace.cwd
      && (ACTIVE.has(other.status) || this.scheduler.running.has(other.id))),
      'Another SuperCode run is active in this workspace. Pause it first.', 409)
  }
  limitReason(room) {
    if (room.usage.calls - room.checkpoint.calls >= room.limits.calls) return 'Model-call checkpoint reached. Review progress and Resume to grant the next checkpoint.'
    if (elapsed(room, this.now()) - room.checkpoint.activeMs >= room.limits.minutes * 60000) return 'Runtime checkpoint reached. Review progress and Resume to grant the next checkpoint.'
    return null
  }
  admission(id, memberId, { mode, kind } = {}) {
    if (this.closing) return 'The app is closing. Continue this conversation after restart.'
    if (this.store.failed.has(id)) return 'Journal write failed. Further work is disabled until app restart.'
    const room = this.get(id)
    if (!room.members.some(item => item.id === memberId)) return 'Unknown team member.'
    if (!RUNNABLE.has(room.status)) return 'SuperCode is not running.'
    if (mode === 'write' && room.status === 'discussing') return 'Discussion does not grant permission to implement.'
    if (['model-reserved', 'tool', 'step'].includes(kind)) {
      if (elapsed(room, this.now()) - room.checkpoint.activeMs >= room.limits.minutes * 60000) return 'Runtime checkpoint reached.'
    } else if (this.limitReason(room)) return this.limitReason(room)
    if (mode === 'write' && (room.phase !== 'execution' || !room.approved)) return 'The user must approve this plan before implementation.'
    if (mode === 'write' && room.permissionPreset === 'read-only') return 'This run has read-only access.'
    return true
  }
  async reserveCall(id, memberId) {
    const reason = this.admission(id, memberId, { kind: 'model' })
    if (reason !== true) {
      if (RUNNABLE.has(this.get(id).status)) void this.pause(id, reason).catch(() => {})
      throw new RoomError(reason, 409)
    }
    this.change(id, 'model-call-reserved', room => { room.usage.calls++ })
  }
  persistMemberSession(id, memberId, sessionId) {
    this.change(id, 'member-session', room => { member(room, memberId).sessionId = sessionId })
  }
  emit(id, event) {
    if (event.type === 'assistant') {
      const room = this.get(id), actor = room.members.find(item => item.id === event.memberId)
      if (event.runId !== room.runId || !actor?.sessionId || actor.sessionId !== event.sessionId ||
        typeof event.messageId !== 'string' || !event.messageId || typeof event.text !== 'string' || !event.text.trim()) return
      // Stable native identity survives scheduler settlement, reconnect and
      // journal reload. Old messages need no migration or synthetic identity.
      if (room.messages.some(entry => entry.runId === event.runId && entry.memberId === event.memberId &&
        entry.nativeSessionId === event.sessionId && entry.nativeMessageId === event.messageId)) return
      if (!ACTIVE.has(room.status)) return
      this.change(id, 'agent-message', next => {
        message(next, 'agent', event.text.trim().slice(0, 32000), event.memberId, {
          nativeSessionId: event.sessionId, nativeMessageId: event.messageId,
          ...(event.taskId ? { taskId: event.taskId } : {}),
        })
      })
      return
    }
    if (event.type === 'approval') {
      const room = this.get(id)
      if (!RUNNABLE.has(room.status)) return
      const name = member(room, event.memberId).name
      const reason = `${name} needs separate permission for ${String(event.name || 'a tool').slice(0, 100)}. No permission was granted. Handle this action yourself or revise the task to stay within current access, then Resume. Plan approval does not expand tool permissions.`
      this.change(id, 'approval-required', next => { message(next, 'system', reason) })
      void this.pause(id, reason, 'blocked').catch(() => {})
      return
    }
    if (event.type === 'tool') this.change(id, 'tool-activity', room => {
      message(room, 'tool', String(event.text || event.name || 'Tool activity').slice(0, 2000), event.memberId,
        { ...(event.taskId ? { taskId: event.taskId } : {}), name: String(event.name || '') })
    })
  }
  settleOutcome(id, actor, diagnostic) {
    const current = this.get(id)
    if (!current.pendingOutcome) return
    if (current.pendingOutcome.kind === 'planning') {
      if (diagnostic?.ok !== true || current.status !== 'discussing') {
        this.change(id, 'planning-request-aborted', room => { delete room.pendingOutcome }); return
      }
      if (actor === current.leadId) this.change(id, 'planning-request-verified', room => { room.pendingOutcome.verified = true })
      const ready = this.get(id)
      if (!ready.pendingOutcome.verified || ready.queue.length || this.runtime?.isBusy?.(id)) return
      this.change(id, 'conversation-to-planning', room => {
        const user = room.messages.findLast(entry => entry.kind === 'user' && entry.runId === room.runId)
        check(user?.id === room.pendingOutcome.messageId && !room.tasks.length && !room.approved, 'The user request changed before planning. Send the current request again.', 409)
        room.goal = user.text; room.status = 'planning'; room.phase = 'planning'; delete room.chatOnly
        delete room.pendingOutcome; delete room.discussionReturn; delete room.reason; delete room.chatInFlight
      })
      return
    }
    // This runs only after native model/tool execution and job drainage settle.
    if (diagnostic?.ok !== true || !['planning', 'running'].includes(current.status)) {
      this.change(id, 'outcome-aborted', room => { delete room.pendingOutcome })
      return
    }
    // A plan/result cannot outrun unanswered questions. The lead must see the
    // responses before its outcome is accepted.
    if (current.queue.length) return
    if (actor === current.leadId) this.change(id, 'outcome-verified', room => { room.pendingOutcome.verified = true })
    if (!this.get(id).pendingOutcome.verified || this.runtime?.isBusy?.(id)) return
    this.change(id, 'outcome-settled', room => {
      const pending = room.pendingOutcome; delete room.pendingOutcome
      if (pending.kind === 'approval') {
        room.status = 'awaiting-approval'
        message(room, 'system', 'The proposed task board is ready. Review it, then approve to start implementation.')
      } else {
        check(room.approved && room.tasks.length && room.tasks.every(task => ['done', 'cancelled'].includes(task.status)) && room.tasks.some(task => task.status === 'done'), 'The board changed before completion.')
        room.status = 'completed'; message(room, 'agent', pending.summary, actor)
      }
      stopClock(room, this.now())
    })
  }
  pause(id, reason = 'Paused by you.', target = 'paused') {
    const existing = this.pauses.get(id)
    if (existing) {
      if (target === 'stopped') { existing.target = target; existing.reason = reason }
      else if (this.closing && existing.target !== 'stopped') { existing.target = 'paused'; existing.reason = reason }
      return existing.promise
    }
    const pending = { target, reason, promise: null }
    const operation = (async () => {
      const current = this.get(id)
      if (TERMINAL.has(current.status)) return current
      if (current.status !== 'pausing') this.change(id, 'pausing', room => { stopClock(room, this.now()); room.status = 'pausing'; room.reason = reason })
      await this.runtime?.cancel(id)
      await this.scheduler.idle(id)
      if (this.get(id).status === 'pausing') this.change(id, pending.target, room => {
        room.status = pending.target; room.reason = pending.reason; stopClock(room, this.now())
        for (const task of room.tasks) if (task.status === 'working') { task.status = 'blocked'; task.interrupted = true; task.revision++ }
        Object.keys(room.memberStates).forEach(key => { room.memberStates[key] = 'Waiting' })
      })
      return this.view(id)
    })()
    pending.promise = operation
    this.pauses.set(id, pending)
    operation.finally(() => this.pauses.delete(id)).catch(() => {})
    return operation
  }
  async command(id, input) {
    check(input && typeof input === 'object', 'Command required.')
    const requestId = text(input.requestId, 'Request identity', 100)
    let room = this.get(id)
    if (room.requests.includes(requestId)) return this.view(id)
    const action = input.action
    if (action === 'team') {
      check(input.revision === room.revision, 'Room changed. Refresh and try again.', 409)
      check(!ACTIVE.has(room.status), 'Wait for the active response to finish before changing models.', 409)
      const leadId = input.leadId || room.leadId, members = roster(input.members, leadId)
      await this.validateModels(members)
      return this.store.change(id, input.revision, 'team-configured', next => {
        check(!ACTIVE.has(next.status), 'The team started working. Wait before changing models.', 409)
        next.nextTeam = { members, leadId }; next.requests.push(requestId)
      }).room
    }
    if (['task', 'approve', 'new-run'].includes(action)) check(input.revision === room.revision, 'Room changed. Refresh and try again.', 409)
    const noBoard = value => !value.approved && !value.tasks.length && ['draft', 'paused', 'blocked'].includes(value.status)
    const discussion = action === 'message' && (noBoard(room) || ['awaiting-approval', 'completed', 'stopped'].includes(room.status))
    if (['start', 'plan', 'approve', 'resume', 'message'].includes(action)) check(!room.nextTeam, 'Your new models are saved. Replan with selected models or start a New goal before continuing.', 409)
    if (['start', 'plan', 'approve', 'resume'].includes(action) || discussion) {
      this.ensureWorkspace(room); await this.validateModels(room.members)
      room = this.get(id); this.ensureWorkspace(room)
    }
    if (action === 'new-run') {
      check(TERMINAL.has(room.status), 'Stop or finish this run before starting another.')
      const selected = input.members ? { members: input.members, leadId: input.leadId } : room.nextTeam || { members: room.members, leadId: room.leadId }
      const members = roster(selected.members, selected.leadId)
      await this.validateModels(members)
      return this.store.change(id, input.revision, action, next => {
        next.history.push({ runId: next.runId, goal: next.goal, leadId: next.leadId, members: next.members, tasks: next.tasks, usage: next.usage, status: next.status })
        next.members = members; next.leadId = selected.leadId; delete next.nextTeam
        next.limits = limits(input.limits || next.limits); next.goal = text(input.goal, 'Goal', 16000)
        next.title = next.goal.slice(0, 80); next.runId = randomUUID(); next.runNumber++
        next.tasks = []; next.queue = []; next.approved = false; next.phase = 'planning'; next.status = 'draft'
        next.usage = { calls: 0, input: 0, output: 0, cost: null, activeMs: 0 }; next.checkpoint = { calls: 0, activeMs: 0 }
        next.startedAt = null; next.failures = 0; delete next.reason; delete next.pendingOutcome; delete next.discussionReturn; delete next.chatOnly; delete next.chatInFlight
        next.memberStates = Object.fromEntries(members.map(item => [item.id, 'Waiting']))
        next.requests.push(requestId); message(next, 'user', next.goal)
      }).room
    }
    this.store.change(id, ['task', 'approve'].includes(action) ? input.revision : null, `user-${action}`, next => {
      if (action === 'start') {
        check(next.status === 'draft' && !next.tasks.length && !next.chatOnly, 'This conversation has already started.', 409)
        next.conversationEntry = 1; next.chatOnly = true; next.discussionReturn = 'draft'; next.status = 'discussing'; next.startedAt = this.now()
        const first = next.messages.findLast(entry => entry.kind === 'user')
        this.enqueue(next, 'lead', first.text, null, first.id)
      } else if (action === 'plan') {
        check(next.status === 'draft', 'This room already has a plan or active run.')
        next.status = 'planning'; next.startedAt = this.now(); delete next.chatOnly
      } else if (action === 'approve') {
        check(['awaiting-approval', 'paused', 'blocked'].includes(next.status), 'Wait for the proposed plan before approving.')
        check(next.tasks.length && next.tasks.some(task => !['done', 'cancelled'].includes(task.status)), 'The team must propose actionable tasks first.')
        dependenciesValid(next)
        next.tasks.forEach(task => { task.approved = true; if (task.status === 'backlog') { task.status = 'ready'; task.revision++ } })
        next.approved = true; next.phase = 'execution'; next.status = 'running'; next.startedAt = this.now()
        message(next, 'system', 'Plan approved. The team can now implement within the selected access policy.')
      } else if (action === 'resume') {
        check(['paused', 'blocked'].includes(next.status), 'Only a paused or blocked room can resume.')
        if (!next.conversationEntry && !next.approved && !next.tasks.length && next.phase === 'planning' && !next.chatOnly && !next.discussionReturn) {
          next.conversationEntry = 1; next.chatOnly = true; next.discussionReturn = 'draft'; next.queue = []
          const latest = next.messages.findLast(entry => entry.kind === 'user' && entry.runId === next.runId)
          this.enqueue(next, latest.recipient || 'lead', latest.text, null, latest.id)
        }
        if (next.chatOnly) {
          const queued = new Set(next.queue.map(item => item.id))
          next.queue.unshift(...Object.values(next.chatInFlight || {}).flat().filter(item => !queued.has(item.id)))
          delete next.chatInFlight
        }
        next.status = next.discussionReturn ? 'discussing' : next.phase === 'planning' ? 'planning' : next.approved ? 'running' : 'awaiting-approval'
        next.checkpoint = { calls: next.usage.calls, activeMs: next.usage.activeMs }; next.startedAt = next.status === 'awaiting-approval' ? null : this.now()
        next.failures = 0; delete next.pendingOutcome
        next.tasks.forEach(task => {
          task.checkpointAttempts = task.attempts
          if (task.interrupted && task.status === 'blocked') { task.status = 'ready'; task.revision++; delete task.interrupted }
        })
      } else if (action === 'pause' || action === 'stop') {
        check(!TERMINAL.has(next.status), 'This run has already ended.')
        stopClock(next, this.now()); next.status = 'pausing'; next.reason = action === 'stop' ? 'Stopped by you. Existing edits are preserved.' : 'Paused by you.'
      } else if (action === 'message') {
        check(!ACTIVE.has(next.status) || RUNNABLE.has(next.status), 'Wait for the current cancellation to finish.', 409)
        if (noBoard(next) || ['awaiting-approval', 'completed', 'stopped'].includes(next.status)) {
          const limit = this.limitReason(next)
          if (noBoard(next)) { next.conversationEntry = 1; next.chatOnly = true; next.queue = []; delete next.pendingOutcome; delete next.chatInFlight }
          next.discussionReturn = next.chatOnly ? 'draft' : next.status
          next.status = limit ? 'paused' : 'discussing'; next.startedAt = limit ? null : this.now()
          if (limit) next.reason = limit
        }
        const body = text(input.text, 'Message', 16000), entry = message(next, 'user', body, null, { recipient: input.recipient || 'lead' })
        if (next.pendingOutcome?.kind === 'planning') delete next.pendingOutcome
        this.enqueue(next, input.recipient || 'lead', body, null, entry.id)
      } else if (action === 'task') {
        check(!ACTIVE.has(next.status), 'Pause before editing the task board.', 409)
        changeTask(next, input.task || {}, null, true)
        if (next.status === 'pausing') { next.status = 'awaiting-approval'; stopClock(next, this.now()) }
      } else throw new RoomError('Unknown SuperCode command.')
      if (!['pause', 'stop', 'task', 'message'].includes(action) || (action === 'message' && (RUNNABLE.has(next.status) || next.status === 'draft'))) delete next.reason
      next.requests.push(requestId)
    })
    if (action === 'pause' || action === 'stop') return this.pause(id, this.get(id).reason, action === 'stop' ? 'stopped' : 'paused')
    this.scheduler.start(id)
    return this.view(id)
  }
  enqueue(room, recipient, body, actor, messageId) {
    if (room.pendingOutcome) delete room.pendingOutcome.verified
    const ids = recipient === 'team' ? room.members.map(item => item.id).filter(id => id !== actor)
      : [recipient === 'lead' ? room.leadId : member(room, recipient).id]
    check(room.queue.length + ids.length <= 40, 'The team already has too many queued messages. Let it catch up.', 409)
    ids.filter(id => id !== actor).forEach(memberId => room.queue.push({ id: randomUUID(), memberId, text: body, senderId: actor, messageId }))
  }
  tool(id, actor, name, args) {
    member(this.get(id), actor)
    if (name === 'supercode_room_read') return { ok: true, room: compact(this.get(id), args) }
    const result = this.change(id, name, room => {
      check(RUNNABLE.has(room.status), 'This room is not running.', 409)
      if (room.chatOnly) check(['supercode_post', 'supercode_start_plan'].includes(name), 'This turn is conversation-only. Request planning before changing tasks.', 409)
      if (room.status === 'discussing') check(name === 'supercode_post' || (room.chatOnly && name === 'supercode_start_plan') ||
        (room.discussionReturn === 'awaiting-approval' && name === 'supercode_task' && ['propose', 'update', 'cancel'].includes(args.operation)),
        'This is a read-only conversation. Start a New goal to implement more work.', 409)
      if (name === 'supercode_start_plan') {
        check(actor === room.leadId && room.chatOnly && room.status === 'discussing' && !room.tasks.length && !room.approved, 'Only the lead can request planning from a conversation.', 403)
        const user = room.messages.findLast(entry => entry.kind === 'user' && entry.runId === room.runId)
        check(user && user.id === args.messageId, 'Choose the current user message, not a peer message or older request.', 409)
        room.pendingOutcome = { kind: 'planning', messageId: user.id }
      } else if (name === 'supercode_post') {
        const entry = message(room, 'agent', text(args.text, 'Message', 16000), actor, {
          ...(args.taskId ? { taskId: args.taskId } : {}), ...(args.recipient ? { recipient: args.recipient } : {}),
        })
        if (args.recipient) this.enqueue(room, args.recipient, entry.text, actor, entry.id)
      } else if (name === 'supercode_task') return changeTask(room, args, actor)
      else if (name === 'supercode_review') return reviewTask(room, args, actor)
      else if (name === 'supercode_plan_ready') {
        check(actor === room.leadId && room.phase === 'planning', 'Only the lead can submit the plan.', 403)
        check(room.tasks.length, 'Propose tasks before submitting the plan.')
        dependenciesValid(room); room.pendingOutcome = { kind: 'approval' }
      } else if (name === 'supercode_finish') {
        check(actor === room.leadId && room.phase === 'execution' && room.approved, 'Only the lead can complete an approved run.', 403)
        check(room.tasks.length && room.tasks.every(task => ['done', 'cancelled'].includes(task.status)) && room.tasks.some(task => task.status === 'done'), 'Tasks still need implementation, review, or acceptance.')
        room.pendingOutcome = { kind: 'complete', summary: text(args.summary, 'Completion summary', 16000) }
      } else throw new RoomError('Unknown team tool.')
    })
    return { ok: true, ...(result.result ? { task: result.result } : {}), room: compact(result.room) }
  }
  async dispose() {
    this.closing = true
    clearInterval(this.timer)
    // Upstream teardown can cancel a native member before this plugin's
    // disposer runs. Keep that diagnostic, but restore the unfinished chat
    // paused rather than classifying shutdown as a new model failure.
    await Promise.allSettled(this.store.list().filter(room => ACTIVE.has(room.status) || room.status === 'blocked')
      .map(room => this.pause(room.id, 'App closed. Continue when ready.' + (room.reason ? ' Previous status: ' + room.reason : ''))))
    try { await this.runtime?.dispose() } finally { this.store.off('fault', this.onStoreFault) }
  }
}
