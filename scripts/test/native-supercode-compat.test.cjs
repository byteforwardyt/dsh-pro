const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { normalizeLegacySuperCodeEvent: normalize, transform, MARKER } = require('../native-supercode-compat.cjs')
const legacy = () => ({ type: 'user/message', seq: 8, data: { id: 'message-1', source: { kind: 'user', origin: 'supercode-host', roomId: 'room-1', memberId: 'lead', rpcId: 'supercode:room-1:run-1:message-1' }, content: [{ type: 'text', text: '[SuperCode host task]\nRoom: room-1\nMember: Lead\nSay hi.' }] } })

test('legacy SuperCode messages gain their event-discriminator role only in the decoded copy', () => {
  const event = legacy(), original = JSON.stringify(event), next = normalize(event)
  assert.equal(next.data.role, 'user'); assert.equal(next.seq, event.seq)
  assert.equal(next.data.id, event.data.id); assert.equal(JSON.stringify(event), original)
  assert.equal(normalize(next), next)
})
test('ordinary malformed messages, conflicting roles and mismatched ownership envelopes remain rejected by native validation', () => {
  for (const mutate of [e => { e.data.role = 'assistant' }, e => { e.data.role = null }, e => { e.type = 'assistant/message' },
    e => { delete e.data.source.origin }, e => { e.data.source.rpcId = 'unrelated' }, e => { e.data.content[0].text = 'unrelated' },
    e => { e.data.source.roomId = 'other-room' }, e => { e.data.source.memberId = '' }]) {
    const event = legacy(); mutate(event); assert.equal(normalize(event), event)
  }
})
test('the persistence patch is pinned to the stored-event decoder and leaves new-event validation intact', () => {
  const store = path.resolve(__dirname, '../../node_modules/.pnpm')
  const dir = fs.readdirSync(store).find(name => name.startsWith('@deepseek-ai+dsh-session-persistence@0.2.0-rc.2'))
  const source = fs.readFileSync(path.join(store, dir, 'node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js'), 'utf8')
  const output = transform(source)
  assert(output.includes(MARKER)); assert(output.includes('adoptSessionEvent(normalizeLegacySuperCodeEvent(event))'))
  assert.equal(transform(output), output)
  assert.throws(() => transform('unknown upstream format'), /compatibility anchor/)
})
