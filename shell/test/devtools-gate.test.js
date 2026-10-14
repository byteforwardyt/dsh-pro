import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require_ = createRequire(import.meta.url)

// devtools.cjs can screenshot the window to a chosen directory, dump the DOM,
// and click controls by their visible text — including the provider sign-in
// buttons. It used to be gated on an environment variable alone, which meant it
// was a remote-control surface on every shipped copy rather than a development
// convenience. It now also requires a demonstrably unpackaged build.
//
// These tests run outside Electron, where `require('electron')` throws. That is
// the fail-closed path, and asserting it here is deliberate: a build we cannot
// identify must be treated as packaged.

test('the gate stays shut when the build cannot be identified as unpackaged', () => {
  const devtools = require_('../src/devtools.cjs')
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DSH_DESKTOP_CAPTURE')
  const previous = process.env.DSH_DESKTOP_CAPTURE
  process.env.DSH_DESKTOP_CAPTURE = '1'
  try {
    assert.equal(devtools.enabled(), false,
      'the env var alone opened the automation surface')
  } finally {
    if (had) process.env.DSH_DESKTOP_CAPTURE = previous
    else delete process.env.DSH_DESKTOP_CAPTURE
  }
})

test('every helper refuses while the gate is shut, not just the screenshot ones', () => {
  const devtools = require_('../src/devtools.cjs')
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DSH_DESKTOP_CAPTURE')
  const previous = process.env.DSH_DESKTOP_CAPTURE
  process.env.DSH_DESKTOP_CAPTURE = '1'
  try {
    // A window double that would record any real call. Reaching it at all is
    // the failure; the helpers that mattered most here were the ones that
    // click, not the ones that capture.
    let touched = 0
    const win = {
      isDestroyed: () => { touched += 1; return false },
      webContents: { executeJavaScript: () => { touched += 1; return Promise.resolve(null) } },
    }
    for (const [name, fn] of Object.entries(devtools)) {
      if (name === 'enabled') continue
      assert.equal(fn(win, 'Sign in'), null, `${name} answered while the gate was shut`)
    }
    assert.equal(touched, 0, 'a helper reached the window despite the gate')
  } finally {
    if (had) process.env.DSH_DESKTOP_CAPTURE = previous
    else delete process.env.DSH_DESKTOP_CAPTURE
  }
})

test('the fence is on the export table, so a new helper inherits it', () => {
  // A per-function check is a rule someone can write a helper without noticing.
  // This asserts the structural property rather than the current helper list.
  const source = readFileSync(new URL('../src/devtools.cjs', import.meta.url), 'utf8')
  assert.match(source, /const surface = \{/,
    'the helpers are no longer collected into a single guarded table')
  assert.match(source, /enabled\(\) \? fn\(\.\.\.args\) : null/,
    'the export table no longer wraps each helper in the gate')
  assert.equal(/^module\.exports = \{ capture/m.test(source), false,
    'the helpers are exported directly again, bypassing the gate')
})

test('the gate requires the build to be unpackaged, not merely to look like it', () => {
  const source = readFileSync(new URL('../src/devtools.cjs', import.meta.url), 'utf8')
  // `isPackaged === false` rather than `!isPackaged`: the latter is also true
  // for undefined, which is exactly what a failed require would produce.
  assert.match(source, /isPackaged === false/,
    'the packaged check accepts a missing value as unpackaged')
  assert.match(source, /catch \{ return false \}/,
    'a failure to identify the build no longer fails closed')
})
