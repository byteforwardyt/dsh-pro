import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createBridge } from '../lib/bridge.js'
import { computerApproval, computerResultText } from '../lib/index.js'

test('private bridge matches replies, cancels, disposes and refuses a standalone host', async () => {
  const channel = new EventEmitter(), sent = []
  channel.connected = true
  channel.send = (message, cb) => { sent.push(message); cb?.() }
  const bridge = createBridge(channel)
  const result = bridge.request('status')
  channel.emit('message', { channel: 'wrong', id: sent[0].id, result: { enabled: true } })
  channel.emit('message', { channel: 'dsh-computer-result', id: sent[0].id, result: { enabled: false } })
  assert.deepEqual(await result, { enabled: false })
  const controller = new AbortController()
  const pending = bridge.request('call', {}, controller.signal)
  controller.abort()
  await assert.rejects(pending, /may already have occurred/)
  assert.equal(sent.at(-1).op, 'cancel')
  channel.connected = false
  await assert.rejects(bridge.request('call'), /requires the DSH PRO/)
  bridge.dispose()
  assert.equal(channel.listenerCount('message'), 0)
})

test('computer action always asks after an allow and preserves denials', async () => {
  assert.equal((await computerApproval({ name: 'computer_call' }, async () => ({ kind: 'allow' }))).kind, 'ask')
  const denial = { kind: 'deny', reason: 'Policy denied' }
  assert.equal(await computerApproval({ name: 'computer_call' }, async () => denial), denial)
  assert.equal((await computerApproval({ name: 'computer_tools' }, async () => ({ kind: 'allow' }))).kind, 'allow')
})

test('disabled approval prompts explain the session policy instead of reporting a user rejection', async () => {
  const result = await computerApproval({name:'computer_call'}, async () => ({kind:'allow'}), 'never')
  assert.equal(result.kind,'deny')
  assert.match(result.reason,/approval prompts are disabled/)
  assert.match(result.reason,/Computer controls/)
})

test('window discovery preserves structured IDs even when the driver includes a summary',()=>{
  const result=computerResultText({text:'Found 1 window(s).',structuredJson:JSON.stringify({windows:[{pid:42,window_id:9,title:'Disposable fixture'}]})});
  assert.match(result,/Found 1 window/);
  assert.match(result,/"window_id":9/);
  assert.match(result,/"pid":42/);
})
