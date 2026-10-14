const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const {themeCSS, conversationBundle} = require('./helpers/theme-css.cjs')

const source = fs.readFileSync(path.join(__dirname, '../../plugins/client-ui-theme-holo/lib/client.js'), 'utf8')

test('the hidden row is still the upstream passive turn status', () => {
  const bundle = conversationBundle('dsh-client-ui-chat')
  assert.match(bundle, /className:\s*ChatView_module_css_default\.running,\s*"data-chat-running": true,/,
    'upstream changed the row; inspect it before hiding this selector')
  const row = bundle.slice(bundle.indexOf('const RunningStatus ='), bundle.indexOf('//#endregion', bundle.indexOf('const RunningStatus =')))
  assert.match(row, /role: "status"/)
  assert.match(row, /children: t\("chat.deepDiving"\)/)
  assert.doesNotMatch(row, /"button"|onClick:|"input"/, 'the hidden row must not include interactive controls')
})

test('the desktop theme hides the whole status row without generating a replacement', () => {
  const css = themeCSS()
  const rule = css.split('\n').find(line => line.includes('[class~="EvIC1a_running"]') && line.includes('[data-dshd-hidden-turn-status]'))
  assert.match(rule || '', /\{display:none!important\}/)
  assert.doesNotMatch(css, /Thinking Deep|dshd-think-|dshd-think\]/)
  assert.doesNotMatch(source, /Thinking Deep|dshd-think-/)
  assert.match(css, /\[class~="uV2eYG_card"\]:has\(\[class~="uV2eYG_primary"\]>svg>rect\)::before\{opacity:1/,
    'the composer running indicator should remain')
})

test('the fallback marks only the upstream status and cleans up after it changes', () => {
  const node = ({role, text, className = ''}) => {
    const attrs = new Map(role ? [['role', role]] : [])
    return {
      nodeType: 1, className, isConnected: true,
      childNodes: [{nodeType: 3, nodeValue: text}],
      hasAttribute: name => attrs.has(name),
      getAttribute: name => attrs.get(name) ?? null,
      setAttribute: (name, value) => attrs.set(name, value),
      removeAttribute: name => attrs.delete(name),
    }
  }
  const status = node({role: 'status', text: 'Deep diving'})
  const otherStatus = node({role: 'status', text: 'Finding files...'})
  const quotedMessage = node({text: 'Deep diving'})
  const nodes = [status, otherStatus, quotedMessage]
  let observer
  let helpers
  vm.runInNewContext(source.replace('return { apply, inject:', 'return { apply, hideTurnStatus, inject:'), {
    window: {__ModuleLoader__: {load (definition) { helpers = definition.factory(() => ({})) }}},
    document: {body: {nodeType: 1}, querySelectorAll: () => nodes},
    MutationObserver: class {
      constructor (callback) { this.callback = callback; observer = this }
      observe (_root, options) { this.options = options }
      disconnect () { this.disconnected = true }
    },
  })

  const stop = helpers.hideTurnStatus()
  assert.equal(status.hasAttribute('data-dshd-hidden-turn-status'), true)
  assert.equal(otherStatus.hasAttribute('data-dshd-hidden-turn-status'), false)
  assert.equal(quotedMessage.hasAttribute('data-dshd-hidden-turn-status'), false)
  assert.equal(status.hasAttribute('aria-label'), false)
  assert.equal(observer.options.characterData, true)

  status.childNodes[0].nodeValue = 'Finished'
  observer.callback()
  assert.equal(status.hasAttribute('data-dshd-hidden-turn-status'), false)

  status.className = 'EvIC1a_running'
  observer.callback()
  assert.equal(status.hasAttribute('data-dshd-hidden-turn-status'), true)

  stop()
  assert.equal(observer.disconnected, true)
  assert.equal(status.hasAttribute('data-dshd-hidden-turn-status'), false)
})
