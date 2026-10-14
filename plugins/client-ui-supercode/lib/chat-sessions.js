import { check } from './room-state.js'

/** Public native Session/Workspace bridge. Never edits native journal bodies. */
export function createChatSessions({ ctx, service, runtime }) {
  const pending = new Map()
  async function attach(room, sessionId) {
    const stored = await ctx.sessionPersistence.stat(sessionId)
    check(stored?.header?.cwd === room.workspace.cwd, 'SuperCode chat workspace does not match its native session.', 409)
    const workspace = ctx.workspaceRegistry.get(room.workspace.id) || await ctx.workspaceRegistry.create(room.workspace.cwd, room.workspace.name)
    await workspace.attachSession(sessionId)
    if (room.chatSessionId !== sessionId || room.workspace.id !== String(workspace.id)) service.change(room.id, 'native-chat-linked', next => {
      next.chatSessionId = sessionId; next.workspace.id = String(workspace.id)
    })
    return service.view(room.id)
  }
  async function prepare(id) {
    if (pending.has(id)) return pending.get(id)
    const operation = (async () => {
      let room = service.get(id)
      if (room.chatSessionId) return attach(room, room.chatSessionId)
      const session = await runtime.prepare(id)
      ctx.sessionTitle.rename(session, 'SuperCode · ' + room.title)
      await ctx.sessions.flush(session)
      room = service.get(id)
      return attach(room, session.id)
    })()
    pending.set(id, operation)
    try { return await operation } finally { pending.delete(id) }
  }
  async function recover() {
    const warnings = []
    for (const room of service.store.list()) {
      const lead = room.members.find(member => member.id === room.leadId)
      const sessionId = room.chatSessionId || lead?.sessionId
      if (!sessionId) continue
      try { await attach(room, sessionId) }
      catch { warnings.push({ roomId: room.id, message: 'This SuperCode chat could not be attached to its workspace. Its history is preserved. Restore the workspace folder to continue.' }) }
    }
    return warnings
  }
  return { prepare, recover }
}
