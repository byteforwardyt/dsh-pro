/** SuperCode admission is enforced here, independently of model instructions. */
export const ROOM_TOOLS = Object.freeze([
  'supercode_room_read', 'supercode_post', 'supercode_task', 'supercode_review',
  'supercode_plan_ready', 'supercode_finish', 'supercode_start_plan',
])
export const CHAT_TOOLS = Object.freeze(['supercode_room_read', 'supercode_post', 'supercode_start_plan'])

const READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'skill',
  'job_list', 'job_output', ...ROOM_TOOLS,
])
const FORBIDDEN = new Set([
  'dispatch', 'send_message', 'interrupt_agent', 'workflow', 'ralph',
  'create_goal', 'update_goal', 'terminal', 'preview_server',
  'enter_plan_mode', 'exit_plan_mode', 'get_goal',
])

export class SuperCodeAdmissionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SuperCodeAdmissionError'
    this.code = 'SUPERCODE_ADMISSION_DENIED'
  }
}

export function toolAccess(name, args = {}) {
  if (FORBIDDEN.has(name) || /^(subagent|schedule_|webhook_|mcp__claude_code)/.test(name)) return 'forbidden'
  // The native Node PTC runtime also exposes raw filesystem/network/process
  // APIs, so its envelope is a writer capability even if inner tools are reads.
  if (READ_TOOLS.has(name)) return 'read'
  if (name === 'str_replace_editor' && args?.command === 'view') return 'read'
  return 'write'
}

function denial(value) {
  if (value && typeof value.then === 'function') return 'SuperCode admission must be synchronous.'
  return value === false ? 'SuperCode is paused or requires approval.' : typeof value === 'string' ? value : undefined
}

/**
 * lookup accepts either a live Agent or a persisted session id, including known
 * sessions that currently have no live Agent. A record has roomId/memberId,
 * sessionId, agent and an optional active grant. Unknown ordinary chats pass.
 */
export function installRuntimeGuards({ ctx, lookup, admission, reserveCall, emit = () => {} }) {
  const writers = new Map()
  const disposers = []
  let disposed = false
  let epoch = 0

  function reason(record, kind, toolName, args) {
    if (!record) return undefined
    const grant = record.grant
    if (disposed || !grant || grant.closed || grant.signal.aborted) return 'This SuperCode member has no active scheduled turn.'
    if (record.acceptMessage && !grant.deliveryAdmitted && kind !== 'step') return 'The scheduled SuperCode host assignment has not entered its native turn.'
    const policy = denial(admission(record.roomId, record.memberId, {
      kind, mode: grant.mode, taskId: grant.taskId, toolName, sessionId: record.sessionId,
    }))
    if (policy) return policy
    if (kind !== 'tool') return undefined
    if (grant.mode === 'chat' && !CHAT_TOOLS.includes(toolName)) return 'This is a conversation-only turn. Workspace investigation and task tools are not available.'
    const access = toolAccess(toolName, args)
    if (access === 'forbidden') return 'Use SuperCode room tools; independent delegation and persistent background work are disabled.'
    if ((toolName === 'bash' || toolName === 'pwsh') && args?.run_in_background === true) return 'SuperCode commands must run in the foreground.'
    if (access === 'write' && (grant.mode !== 'write' || writers.get(record.roomId) !== grant)) return 'Only the current SuperCode writer may use this tool.'
    return undefined
  }

  function assert(record, kind, toolName, args) {
    const message = reason(record, kind, toolName, args)
    if (message) throw new SuperCodeAdmissionError(message)
  }

  disposers.push(ctx.tools.guard(exec => reason(lookup(exec.agent), 'tool', exec.name, exec.arguments)))
  disposers.push(ctx.on('tools/execute', async (exec, next) => {
    const record = lookup(exec.agent)
    if (!record) return next()
    // Guard preparation can precede actual dispatch; recheck the exact grant.
    assert(record, 'tool', exec.name, exec.arguments)
    const grant = record.grant
    grant.calls.add(exec.token)
    try {
      return await next()
    } finally {
      grant.calls.delete(exec.token)
    }
  }))
  disposers.push(ctx.on('tools/result', (exec, result) => {
    const record = lookup(exec.agent)
    if (!record?.grant) return
    emit(record.roomId, {
      type: 'tool', memberId: record.memberId, taskId: record.grant.taskId,
      name: exec.name, text: result.isError ? 'Tool failed or was denied.' : 'Tool completed.',
      ok: !result.isError,
    })
  }))
  disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
    const record = lookup(payload.agent)
    if (!record) return next()
    if (reason(record, 'step')) return { kind: 'reject' }
    if (record.acceptMessage && payload.messages?.some(message => !record.acceptMessage(message))) return { kind: 'reject' }
    const grant = record.grant
    if (record.acceptMessage) {
      const hasDelivery = payload.messages?.some(message => record.acceptMessage(message))
      if (!grant.deliveryAdmitted) {
        // Clearing an idle native wake still opens an empty turn. It must not
        // borrow a grant opened while that old wake assembled its context.
        if (!hasDelivery) return { kind: 'reject' }
        grant.deliveryAdmitted = true
        grant.nativeTurn = payload.turn
      } else if (payload.turn !== grant.nativeTurn) return { kind: 'reject' }
    }
    const decision = await next()
    return record.grant !== grant || reason(record, 'step') ? { kind: 'reject' } : decision
  }))
  disposers.push(ctx.on('llm/stream', async function* (options, next) {
    const initiator = ctx.agents.currentInitiator?.()
    const attributed = lookup(initiator)
    const record = options.sessionId ? lookup(options.sessionId) : attributed
    if (!record) {
      if (attributed) throw new SuperCodeAdmissionError('SuperCode model request has a mismatched session identity.')
      yield* next()
      return
    }
    if (attributed && attributed !== record) throw new SuperCodeAdmissionError('SuperCode model request has a mismatched member identity.')
    if (options.purpose === 'session-title') throw new SuperCodeAdmissionError('SuperCode does not start auxiliary title-generation requests.')
    assert(record, 'model')
    const grant = record.grant
    await reserveCall(record.roomId, record.memberId, {
      provider: options.provider, model: options.model, purpose: options.purpose,
      signal: options.signal || grant.signal,
    })
    assert(record, 'model-reserved')
    if (record.grant !== grant) throw new SuperCodeAdmissionError('SuperCode turn changed before model dispatch.')
    yield* next()
  }))

  return {
    begin(record, { mode = 'read', taskId, signal }) {
      if (disposed || record.grant) throw new SuperCodeAdmissionError('This SuperCode member is already running or unavailable.')
      if (!['chat', 'read', 'write'].includes(mode)) throw new TypeError('Invalid SuperCode run mode.')
      if (!signal) throw new TypeError('SuperCode requires a cancellation signal.')
      if (mode === 'write' && writers.has(record.roomId)) throw new SuperCodeAdmissionError('Another SuperCode member owns the writer slot.')
      const grant = { epoch: ++epoch, mode, taskId, signal, calls: new Set(), closed: false }
      record.grant = grant
      if (mode === 'write') writers.set(record.roomId, grant)
      try { assert(record, 'step') } catch (error) { this.end(record); throw error }
      return grant
    },
    close(record) { if (record.grant) record.grant.closed = true },
    end(record) {
      const grant = record.grant
      if (!grant) return
      if (grant.calls.size) throw new SuperCodeAdmissionError('SuperCode tools have not reached quiescence.')
      if (writers.get(record.roomId) === grant) writers.delete(record.roomId)
      delete record.grant
    },
    assert,
    dispose() {
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}
