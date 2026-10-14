import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openrouterSnapshot, kimiSnapshot } from '../lib/poll-usage.js'

test('openrouter: a keyed limit yields a percent', () => {
  const snap = openrouterSnapshot({ data: { limit: 100, limit_remaining: 25, usage: 75 } })
  assert.equal(Math.round(snap.primary.usedPercent), 75)
})

test('openrouter: a limitless key yields NO snapshot — no invented denominator', () => {
  assert.equal(openrouterSnapshot({ data: { limit: null, limit_remaining: null, usage: 12.3 } }), null)
})

test('openrouter: overspent clamps to 100, refunds clamp to 0', () => {
  assert.equal(openrouterSnapshot({ data: { limit: 100, limit_remaining: -5 } }).primary.usedPercent, 100)
  assert.equal(openrouterSnapshot({ data: { limit: 100, limit_remaining: 105 } }).primary.usedPercent, 0)
})

test('openrouter: malformed payloads are null, never a throw', () => {
  for (const bad of [null, {}, { data: null }, { data: { limit: 'x', limit_remaining: 1 } }, { data: { limit: 0, limit_remaining: 0 } }]) {
    assert.equal(openrouterSnapshot(bad), null)
  }
})

test('kimi: limit/remaining yield a percent with window and reset', () => {
  const inTwoHours = new Date(Date.now() + 2 * 3600_000).toISOString()
  const snap = kimiSnapshot({
    usage: { limit: 200, remaining: 50, resetTime: inTwoHours },
    limits: [{ window: { duration: 18000 } }],
  })
  assert.equal(snap.primary.usedPercent, 75)
  assert.equal(snap.primary.windowMinutes, 300)
  assert.ok(snap.primary.resetAfterSeconds > 7000 && snap.primary.resetAfterSeconds <= 7200)
})

test('kimi: a reset in the past is omitted rather than negative', () => {
  const snap = kimiSnapshot({ usage: { limit: 10, remaining: 1, resetTime: '2020-01-01T00:00:00Z' } })
  assert.equal(snap.primary.resetAfterSeconds, undefined)
})

test('kimi: the reverse-engineered shape changing means null, never a throw', () => {
  for (const bad of [null, {}, { usage: null }, { usage: { limit: 'x' } }, { usage: { limit: 0, remaining: 0 } }]) {
    assert.equal(kimiSnapshot(bad), null)
  }
})
