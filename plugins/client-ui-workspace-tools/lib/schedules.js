/** The UI manages the harness's durable reminders through its guarded tools. */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { scheduleView } from '@deepseek-ai/dsh-schedule'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

export function createSchedules (ctx) {
  async function sessions (signal) {
    const records = (await ctx.sessionQuery.listSessions(signal)).filter(row => !row.header.parentSession)
    // The picker is paged by recent history; a selected older session remains
    // addressable through knownSession without creating or resuming an agent.
    const recent = records.slice(0, 100)
    const titles = await ctx.sessionQuery.readTitleSnapshots(recent.map(row => row.header.id), signal)
    return { sessions: recent.map((row, i) => {
      const id = row.header.id
      const result = titles[i]
      const title = result?.status === 'fulfilled' ? result.value.title?.title : undefined
      return { id, title: title || `${basename(row.header.cwd || '') || 'Session'} · ${String(id).slice(0, 8)}`,
        workspace: row.header.cwd || '', live: Boolean(ctx.agents.get(id)) }
    }), hasMore: records.length > recent.length }
  }
  async function knownSession (id, signal) {
    if (typeof id !== 'string' || id.length > 200 || !id) throw fail('Choose a conversation.')
    const records = await ctx.sessionQuery.listSessions(signal)
    if (!records.some(row => row.header.id === id && !row.header.parentSession)) throw fail('Conversation is no longer available.', 404)
    return ctx.agents.get(id)
  }
  async function list (id, signal) {
    const agent = await knownSession(id, signal)
    const records = await ctx.schedule.list({ sessionId: id })
    return { items: records.map(record => scheduleView(record, Date.now())), live: Boolean(agent),
      manageable: Boolean(agent && ctx.tools.resolveExecution('schedule_create', agent, false)),
      message: !agent ? 'Open this conversation and send a message to activate its schedules.'
        : !ctx.tools.resolveExecution('schedule_create', agent, false) ? 'Manage schedules from this conversation’s chat in Code mode.' : null }
  }
  async function change (body, signal) {
    if (!body || !['create', 'delete'].includes(body.operation)) throw fail('Invalid schedule operation.')
    const agent = await knownSession(body.session, signal)
    if (!agent) throw fail('Open this conversation and send a message before scheduling a task.', 409)
    const name = body.operation === 'create' ? 'schedule_create' : 'schedule_delete'
    if (!ctx.tools.resolveExecution(name, agent, false)) throw fail('Manage schedules from this conversation’s chat in Code mode.', 409)
    let args
    if (body.operation === 'delete') {
      if (typeof body.id !== 'string' || body.id.length > 100 || !body.id.trim()) throw fail('Choose a schedule to delete.')
      args = { id: body.id }
    } else {
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 8000) throw fail('Enter a task of up to 8,000 characters.')
      if (!['after', 'every'].includes(body.kind) || !Number.isSafeInteger(body.minutes) || body.minutes < (body.kind === 'every' ? 5 : 1) || body.minutes > 525600) {
        throw fail('Use whole minutes: at least 5 for repeating tasks, or 1 for a one-time task (up to one year).')
      }
      args = { title: body.prompt.trim().slice(0, 120), prompt: body.prompt.trim(), [body.kind === 'every' ? 'every_seconds' : 'after_seconds']: body.minutes * 60 }
    }
    const result = await ctx.tools.execute({ name, arguments: args, callId: `desktop-schedule-${randomUUID()}`, agent, signal })
    if (result.isError) throw fail(result.error?.message || 'Schedule could not be saved.', 409)
    if (result.value?.code && result.value.deleted !== false) throw fail(result.value.message || 'Schedule could not be saved.', 409)
    return result.value
  }
  return { sessions, list, change }
}
