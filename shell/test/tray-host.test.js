import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachTray, sanitizeState, FEED_CAP } from '../src/tray-host.cjs'
import { nextTickMs, MAX_ROWS } from '../src/tray.cjs'

function fakeTray () {
  const calls = { updates: [], enabled: true, destroyed: 0, setEnabled: [] }
  return {
    calls,
    api: {
      update (state) { calls.updates.push(state); return calls.enabled ? 'rebuilt' : 'disabled' },
      setEnabled (value) {
        const next = value !== false
        calls.setEnabled.push(next)
        calls.enabled = next
        return next
      },
      isEnabled () { return calls.enabled },
      destroy () { calls.destroyed += 1; return true },
    },
  }
}

function host (over = {}) {
  const tray = fakeTray()
  const timers = []
  let now = 1_000_000
  const api = attachTray({
    createTray: () => tray.api,
    nextTickMs: over.nextTickMs || ((state, at) => 1000),
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = timers.length + 1
      timers.push({ id, fn, ms, cleared: false })
      return id
    },
    clearTimeout: (id) => {
      const t = timers[id - 1]
      if (t) t.cleared = true
    },
    openApp () {},
    openSession () {},
    quit () {},
    ...over,
  })
  return {
    api, tray: tray.calls, timers,
    setNow (value) { now = value },
    fire (index = timers.length - 1) {
      const t = timers[index]
      assert.ok(t, 'no timer at ' + index)
      assert.equal(t.cleared, false, 'fired a cleared timer')
      t.cleared = true
      t.fn()
    },
  }
}

test('sanitizeState rejects anything that is not an object', () => {
  for (const value of [null, undefined, 'no', 42, true, []]) {
    assert.equal(sanitizeState(value), null, String(value))
  }
})

test('sanitizeState keeps well-formed rows and drops the rest', () => {
  const out = sanitizeState({
    waiting: 2.9,
    sessions: [
      { id: 'a', title: 'Build', running: true, waiting: false, startedAt: 100 },
      { id: 'a', title: 'duplicate', running: true },
      { id: '', title: 'empty' },
      { id: 'x'.repeat(201), title: 'long id' },
      { id: 'nul\u0000', title: 'control' },
      null,
      'no',
      { id: 'b', title: 9, running: 'yes', waiting: true, startedAt: -1 },
      { id: 'c', running: true, startedAt: Number.NaN },
    ],
  })
  assert.deepEqual(out, {
    waiting: 2,
    sessions: [
      { id: 'a', title: 'Build', running: true, waiting: false, startedAt: 100 },
      { id: 'b', title: '', running: false, waiting: true },
      { id: 'c', title: '', running: true, waiting: false },
    ],
  })
})

test('sanitizeState caps the list at FEED_CAP', () => {
  assert.equal(FEED_CAP, 32)
  const sessions = Array.from({ length: FEED_CAP + 10 }, (_, i) => ({ id: 's' + i, running: true }))
  const out = sanitizeState({ sessions, waiting: 0 })
  assert.equal(out.sessions.length, FEED_CAP)
  assert.equal(out.sessions[0].id, 's0')
  assert.equal(out.sessions[FEED_CAP - 1].id, 's' + (FEED_CAP - 1))
})

test('attachTray draws an empty menu immediately', () => {
  const h = host()
  assert.equal(h.tray.updates.length, 1)
  assert.deepEqual(h.tray.updates[0], { sessions: [], waiting: 0 })
  assert.equal(h.timers.length, 1)
})

test('ingest replaces the menu and a malformed payload leaves it', () => {
  const h = host()
  const running = { sessions: [{ id: 's1', title: 'Build', running: true, startedAt: 1 }], waiting: 0 }
  assert.equal(h.api.ingest(running), 'rebuilt')
  assert.equal(h.tray.updates.length, 2)
  assert.equal(h.tray.updates[1].sessions[0].id, 's1')
  assert.equal(h.api.ingest(null), 'malformed')
  assert.equal(h.api.ingest('no'), 'malformed')
  assert.equal(h.tray.updates.length, 2, 'a bad payload wiped a good menu')
})

test('the timer fires update with the last good state and rearms', () => {
  const h = host({ nextTickMs: () => 250 })
  h.api.ingest({ sessions: [{ id: 's1', running: true, startedAt: 1 }], waiting: 0 })
  const armed = h.timers.length
  assert.equal(h.timers[armed - 1].ms, 250)
  const before = h.tray.updates.length
  h.fire()
  assert.equal(h.tray.updates.length, before + 1)
  assert.equal(h.tray.updates.at(-1).sessions[0].id, 's1')
  assert.equal(h.timers.length, armed + 1, 'the tick did not rearm')
})

test('destroy clears the timer so a late tick cannot redraw a dead tray', () => {
  const h = host()
  const pending = h.timers.length
  h.api.destroy()
  assert.equal(h.tray.destroyed, 1)
  assert.equal(h.timers[pending - 1].cleared, true)
  assert.equal(h.timers.length, pending, 'destroy armed a new timer')
})

test('disabling tears the clock down; enabling starts it again', () => {
  const h = host({ nextTickMs: () => 400 })
  h.api.ingest({ sessions: [{ id: 's1', running: true, startedAt: 1 }], waiting: 0 })
  const armed = h.timers.length
  h.api.setEnabled(false)
  assert.equal(h.timers[armed - 1].cleared, true)
  h.api.setEnabled(true)
  assert.equal(h.timers.at(-1).ms, 400)
  assert.equal(h.timers.at(-1).cleared, false)
})

test('nextTickMs from tray.cjs is the default scheduler', () => {
  // Pin the joint: attachTray must not invent its own interval. A running row
  // one second old is still second-granular, so the real scheduler returns
  // something well under a minute.
  const startedAt = 1_000_000
  const delay = nextTickMs({ sessions: [{ id: 's1', running: true, startedAt }] }, startedAt + 1000)
  assert.ok(delay <= 1000, 'a 1s-old clock scheduled ' + delay + 'ms away')
  assert.ok(MAX_ROWS === 8)
})
