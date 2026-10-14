import test from 'node:test'
import assert from 'node:assert/strict'
import { createChatSessions } from '../lib/chat-sessions.js'

function fixture(extra = {}) {
  let room = { id: 'room', title: 'Build feature', members: [{ id: 'lead', sessionId: 'lead-session' }], leadId: 'lead', workspace: { id: 'workspace', cwd: '/project', name: 'Project' }, ...extra }
  const calls = [], warnings = []
  const workspace = { id: 'workspace', attachSession: async id => calls.push(['attach', id]) }
  const ctx = { sessionPersistence: { stat: async () => ({ header: { cwd: '/project' } }) },
    workspaceRegistry: { get: () => workspace, create: async () => workspace },
    sessionTitle: { rename: (session, title) => calls.push(['title', session.id, title]) },
    sessions: { flush: async session => calls.push(['flush', session.id]) } }
  const service = { store: { list: () => [room] }, get: () => structuredClone(room), view: () => structuredClone(room),
    change: (_id, kind, fn) => { fn(room); calls.push([kind]) } }
  const runtime = { prepare: async () => { calls.push(['prepare']); return { id: 'lead-session' } } }
  return { ctx, service, runtime, calls, warnings, chats: createChatSessions({ ctx, service, runtime }) }
}
test('native lead is durably titled, attached, and linked without a model dispatch; retries share preparation', async () => {
  const f = fixture()
  const [a, b] = await Promise.all([f.chats.prepare('room'), f.chats.prepare('room')])
  assert.equal(a.chatSessionId, 'lead-session'); assert.equal(b.chatSessionId, a.chatSessionId)
  assert.equal(f.calls.filter(call => call[0] === 'prepare').length, 1)
  assert.deepEqual(f.calls.slice(0, 4), [['prepare'], ['title', 'lead-session', 'SuperCode · Build feature'], ['flush', 'lead-session'], ['attach', 'lead-session']])
})
test('legacy chat recovery attaches the existing lead through headers and never resumes a paid agent', async () => {
  const f = fixture()
  assert.deepEqual(await f.chats.recover(), [])
  assert.equal(f.service.get().chatSessionId, 'lead-session')
  assert.equal(f.calls.some(call => call[0] === 'prepare' || call[0] === 'title'), false)
})
test('missing native records fail closed and retain the room rather than fabricating a session', async () => {
  const f = fixture(); f.ctx.sessionPersistence.stat = async () => null
  assert.equal((await f.chats.recover()).length, 1)
  assert.equal(f.service.get().chatSessionId, undefined)
  assert.equal(f.calls.length, 0)
})
