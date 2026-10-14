'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { transform, MARKER } = require('../native-conversation-delegate.cjs')
const store = path.resolve(__dirname, '../../node_modules/.pnpm')
const packageDirectory = fs.readdirSync(store).find(name => name.startsWith('@deepseek-ai+dsh-client-ui-conversation@0.2.0-rc.2'))
assert(packageDirectory, 'Pinned native conversation package must be installed')
const installedBundle = fs.readFileSync(path.join(store, packageDirectory, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'), 'utf8')
const bundle = installedBundle.includes(MARKER) ? fs.readFileSync(path.resolve(__dirname, '../../node_modules/.cache/dsh-conversation-upstream-0.2.0-rc.2.js'), 'utf8') : installedBundle

test('native delegate patch fails closed on incompatible upstream and is repeatable', () => {
  const output = transform(bundle)
  assert(output.includes(MARKER))
  assert.equal(transform(output), output)
  assert.throws(() => transform(bundle.replace('async sendSession(', 'async incompatibleSend(')), /compatibility anchor/)
  assert(output.includes('if (viewId === "chat" && delegate?.active)'))
  assert(output.includes('inputTriggers: () => dshDelegateFor(session.sessionId) ? undefined'))
  assert(output.includes('await delegate.submit(text, { session, signal })'))
  assert(output.includes('await delegate.cancel?.()'))
  assert(output.includes('className: clsx(InputBar_module_css_default.card'))
  assert(output.includes('className: clsx(ConversationRoot_module_css_default.header'))
})

test('delegate registration is session scoped, observable and fully disposable', () => {
  const output = transform(bundle), start = output.indexOf(MARKER), end = output.indexOf('//#region', start)
  const context = vm.createContext({ exports: {}, react: { useSyncExternalStore() {} } })
  vm.runInContext(output.slice(start, end) + '\nglobalThis.port = { dshDelegates, dshDelegateFor, dshDelegateSubscribe };', context)
  let notify, renders = 0
  context.port.dshDelegateSubscribe(() => renders++)
  const dispose = context.port.dshDelegates.register({ resolve: id => id === 'team' ? { active: true } : undefined, subscribe: fn => { notify = fn; return () => { notify = null } } })
  assert.equal(context.port.dshDelegateFor('ordinary'), undefined)
  assert.equal(context.port.dshDelegateFor('team').active, true)
  notify(); assert.equal(renders, 2)
  dispose(); assert.equal(notify, null); assert.equal(context.port.dshDelegateFor('team'), undefined)
  assert.equal(renders, 3)
})
