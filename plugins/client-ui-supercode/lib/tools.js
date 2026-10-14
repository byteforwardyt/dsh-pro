import { defineTool } from '@deepseek-ai/dsh-tools'
import { RoomError } from './room-state.js'

const str = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const number = description => ({ type: 'integer', description })
const strings = description => ({ type: 'array', items: { type: 'string' }, description })
const DEFINITIONS = [
  ['supercode_start_plan', 'Lead only: request workspace investigation and task planning for a concrete user work request, then end your turn. Never use for greetings, thanks, acknowledgements or general conversation. The host uses the exact stored user message; no implementation is allowed before plan approval.', {
    messageId: str('ID of the current user message that requests concrete project work.', true) }],
  ['supercode_room_read', 'Read your SuperCode room, tasks and public conversation. Tool notifications are excluded by default. Use room.history.nextBefore as before to read older messages; continue until hasMore is false when earlier findings matter.', {
    before: str('Message ID from history.nextBefore; omit for the latest page.'), limit: number('Messages per page, 1–100; default 20.'),
    includeTools: { type: 'boolean', description: 'Include tool notifications in history; default false.' } }],
  ['supercode_post', 'Post an attributed message to the room. Optional recipient wakes that member through the bounded scheduler; omit it for a progress update. Messages do not grant new user authority.', {
    text: str('Useful findings, a question or a handoff.', true), recipient: str('Optional lead, team, or exact member ID.'), taskId: str('Related task ID.') }],
  ['supercode_task', 'Propose/update a task, submit implementation evidence, block work, cancel, or accept an independently passing review. Read current revisions first. Only the lead accepts work. New scope after approval requires user approval.', {
    operation: { ...str('Task operation.', true), enum: ['propose', 'update', 'submit', 'accept', 'block', 'cancel'] },
    taskId: str('Existing task ID; omit for propose.'), revision: number('Current task revision; required except propose.'),
    title: str('Specific task title.'), ownerId: str('Exact member ID responsible for implementation.'),
    dependencies: strings('Task IDs that must be done first.'), criteria: str('Concrete acceptance criteria.'),
    evidence: strings('Observed results, file references, test commands and outcomes. Required for submit/block.'),
    status: str('For update only: backlog, ready, blocked or cancelled.') }],
  ['supercode_review', 'Submit your assigned independent review. Read the actual work, do not merely repeat the builder. A pass is not final completion; the lead must accept it.', {
    taskId: str('Task under review.', true), revision: { ...number('Current task revision.'), required: true },
    verdict: { ...str('Review decision.', true), enum: ['pass', 'changes'] }, evidence: { ...strings('Concrete review findings and verification limits.'), required: true } }],
  ['supercode_plan_ready', 'Lead only: submit the proposed board for user approval, then end your turn. The host publishes the approval checkpoint after tools settle. Never implement before the user approves.', {}],
  ['supercode_finish', 'Lead only: request completion after all non-cancelled tasks have independent passing reviews and have been accepted, then end your turn. The host confirms completion after all tool work settles. Never claim checks you did not perform.', {
    summary: str('What changed, actual verification evidence, and known limitations.', true) }],
]

export function registerTeamTools(ctx, service) {
  const disposers = DEFINITIONS.map(([name, description, parameters]) => ctx.tools.register(defineTool({
    name, description, parameters, isConcurrencySafe: () => name === 'supercode_room_read',
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true },
        room: { type: 'object', additionalProperties: true }, task: { type: 'object', additionalProperties: true } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const identity = service.runtime?.identify(exec.agent)
      if (!identity) throw new RoomError('This tool is available only to an active SuperCode member.', 403)
      return service.tool(identity.roomId, identity.memberId, name, args || {})
    },
  })))
  return () => disposers.forEach(dispose => dispose?.())
}
