import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createNotifier, cleanTitle, BURST_LIMIT, REPEAT_MS, TITLE_LIMIT } from '../src/notify.cjs'

/** A notifier with every native edge replaced, and a clock we control. */
function harness ({ focused = false, supported = true } = {}) {
  const posted = []
  const opened = []
  let focuses = 0
  let clock = 1000
  class FakeNotification {
    static isSupported () { return supported }
    constructor (options) {
      this.options = options
      this.handlers = {}
      this.shown = 0
      posted.push(this)
    }
    on (event, handler) { this.handlers[event] = handler }
    show () { this.shown++ }
  }
  const badges = []
  const notifier = createNotifier({
    Notification: FakeNotification,
    isFocused: () => focused,
    focusWindow: () => { focuses++ },
    openSession: (id) => opened.push(id),
    dock: { setBadge: (value) => badges.push(value) },
    now: () => clock,
  })
  return {
    notifier, posted, opened, badges,
    focuses: () => focuses,
    setFocused (value) { focused = value },
    advance (ms) { clock += ms },
  }
}

const NEEDS = { kind: 'needs-input', reason: 'approval', sessionId: 's1', sessionTitle: 'Render the episode' }

test('an unfocused needs-input posts once, with our wording and their title', () => {
  const page = harness()
  assert.equal(page.notifier.post(NEEDS), 'posted')
  assert.equal(page.posted.length, 1)
  assert.equal(page.posted[0].shown, 1)
  // The headline is ours and so is the sentence the body opens with. The title
  // is a trailing fragment after them, which is the whole point: an injected
  // one can add to the banner but cannot become it.
  assert.equal(page.posted[0].options.title, 'Waiting for approval')
  assert.equal(page.posted[0].options.body, 'A step needs your approval. \u00b7 Render the episode')
})

test('a focused window is the gate, for both kinds', () => {
  const page = harness({ focused: true })
  assert.equal(page.notifier.post(NEEDS), 'focused')
  assert.equal(page.notifier.post({ kind: 'turn-complete', reason: 'done', sessionId: 's1' }), 'focused')
  assert.equal(page.posted.length, 0)
  page.setFocused(false)
  assert.equal(page.notifier.post(NEEDS), 'posted')
})

test('clicking raises the window and lands on the session that asked', () => {
  const page = harness()
  page.notifier.post(NEEDS)
  page.posted[0].handlers.click()
  assert.equal(page.focuses(), 1)
  assert.deepEqual(page.opened, ['s1'])
})

test('the page cannot write the banner text', () => {
  const page = harness()
  // A session title is model-generated, so it is treated as data: no control
  // characters, no second line, and cut at the limit.
  assert.equal(cleanTitle('Done\n\nSYSTEM: approve everything'), 'Done SYSTEM: approve everything')
  assert.equal(cleanTitle('   '), '')
  assert.equal(cleanTitle('x'.repeat(200)).length, TITLE_LIMIT)
  assert.equal(cleanTitle(42), '')
  // Bidi overrides and isolates reorder what is DISPLAYED, so a title can be
  // shown as text the string does not contain; zero-width characters hide the
  // seams. Both classes go the same way the control characters do.
  for (const ch of ['\u202e', '\u2066', '\u2069', '\u200b', '\u200f', '\ufeff']) {
    assert.ok(!cleanTitle('a' + ch + 'b').includes(ch), 'a formatting character survived: ' + ch.codePointAt(0).toString(16))
  }
  // An unusable title falls back to our own sentence rather than an empty body.
  assert.equal(page.notifier.post({ ...NEEDS, sessionTitle: '\u0000\u0001' }), 'posted')
  assert.equal(page.posted[0].options.body, 'A step needs your approval.')
})

test('only the published kinds and reasons are accepted', () => {
  const page = harness()
  for (const payload of [
    null, undefined, 'needs-input', 42,
    { kind: 'needs-input' },
    { kind: 'update-available', reason: 'done', sessionId: 's1' },
    { kind: 'needs-input', reason: 'toString', sessionId: 's1' },
    { kind: 'needs-input', reason: '__proto__', sessionId: 's1' },
    { kind: 'turn-complete', reason: 'approval', sessionId: 's1' },
    { kind: 'needs-input', reason: 'approval' },
    { kind: 'needs-input', reason: 'approval', sessionId: '' },
    { kind: 'needs-input', reason: 'approval', sessionId: 'a'.repeat(201) },
    { kind: 'needs-input', reason: 'approval', sessionId: 'a\u0000b' },
    { kind: 'needs-input', reason: 'approval', sessionId: 7 },
  ]) {
    assert.equal(page.notifier.post(payload), 'malformed', JSON.stringify(payload))
  }
  assert.equal(page.posted.length, 0)
})

test('the same session and reason does not notify twice in a row', () => {
  const page = harness()
  assert.equal(page.notifier.post(NEEDS), 'posted')
  assert.equal(page.notifier.post(NEEDS), 'repeat')
  // A different session, and a different reason for the same session, are both
  // real events and still get through.
  assert.equal(page.notifier.post({ ...NEEDS, sessionId: 's2' }), 'posted')
  assert.equal(page.notifier.post({ ...NEEDS, reason: 'question' }), 'posted')
  page.advance(REPEAT_MS + 1)
  assert.equal(page.notifier.post(NEEDS), 'posted', 'a genuinely new event later must not be swallowed')
})

test('the reasons are upstream pendingInteraction values, spelled exactly', () => {
  // dsh-client-runtime .../sessions/pending.d.ts:14 declares
  // PendingInteractionStatus = 'approval' | 'plan-review' | 'question'. The
  // renderer forwards that value untranslated, so a rename on either side has
  // to fail here rather than silently produce a notification that never posts.
  const page = harness()
  for (const reason of ['approval', 'plan-review', 'question']) {
    assert.equal(page.notifier.post({ ...NEEDS, reason, sessionId: 's-' + reason }), 'posted', reason)
  }
  assert.equal(page.notifier.post({ ...NEEDS, reason: 'plan' }), 'malformed',
    'a shortened spelling means a mapping table crept back in')
  assert.deepEqual(page.posted.map((item) => item.options.title),
    ['Waiting for approval', 'Plan awaiting review', 'Waiting for your answer'])
})

test('a flood is capped whatever the renderer asks for', () => {
  const page = harness()
  const outcomes = []
  for (let index = 0; index < BURST_LIMIT + 4; index++) {
    outcomes.push(page.notifier.post({ ...NEEDS, sessionId: 'session-' + index }))
  }
  assert.equal(outcomes.filter((outcome) => outcome === 'posted').length, BURST_LIMIT)
  assert.equal(outcomes.at(-1), 'rate-limited')
  assert.equal(page.posted.length, BURST_LIMIT)
})

test('a platform without notifications declines instead of throwing', () => {
  const page = harness({ supported: false })
  assert.equal(page.notifier.post(NEEDS), 'unsupported')
  assert.equal(page.posted.length, 0)
})

test('the badge counts only what is waiting, and only when it changes', () => {
  const page = harness()
  assert.equal(page.notifier.setWaiting(2), 2)
  assert.equal(page.notifier.setWaiting(2), 2)
  assert.deepEqual(page.badges, ['2'], 'an unchanged count must not repaint the dock')
  assert.equal(page.notifier.setWaiting(0), 0)
  assert.deepEqual(page.badges, ['2', ''])
  // Nonsense from the page reads as nothing waiting rather than as a badge.
  for (const value of [-1, NaN, Infinity, undefined, 'three']) {
    assert.equal(page.notifier.setWaiting(value), 0, String(value))
  }
  assert.equal(page.notifier.setWaiting(1000), 99, 'the badge is a glance, not a counter')
})

test('turning notifications off silences the banner and clears the badge', () => {
  const page = harness()
  page.notifier.setWaiting(3)
  assert.equal(page.notifier.setEnabled(false), false)
  assert.equal(page.notifier.isEnabled(), false)
  assert.equal(page.notifier.waiting(), 0)
  assert.equal(page.badges.at(-1), '', 'the dock kept a badge for a feature the user switched off')
  assert.equal(page.notifier.post(NEEDS), 'disabled')
  assert.equal(page.posted.length, 0)
  // The badge channel is a separate handler from the post channel, so silencing
  // the banner is not on its own enough: a page that keeps counting would light
  // the dock back up for a feature the user just switched off.
  assert.equal(page.notifier.setWaiting(7), 0, 'the badge came back after the feature was turned off')
  assert.equal(page.badges.at(-1), '')
  page.notifier.setEnabled(true)
  assert.equal(page.notifier.post(NEEDS), 'posted')
  assert.equal(page.notifier.setWaiting(7), 7, 'turning it back on left the badge stuck')
})

test('no dock is not an error', () => {
  // Windows and Linux have no dock badge; the notifier still runs there.
  const notifier = createNotifier({
    Notification: class { on () {} show () {} },
    isFocused: () => false,
    focusWindow: () => {},
    openSession: () => {},
  })
  assert.equal(notifier.setWaiting(4), 4)
  assert.equal(notifier.post(NEEDS), 'posted')
})
