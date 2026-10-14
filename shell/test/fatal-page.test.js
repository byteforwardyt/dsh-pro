'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { isFatalPage, crashRestartPlan, unexpectedStopTitle } = require('../src/fatal-page.cjs')

const errorPage = path.join('/app', 'shell', 'src', 'ui', 'error.html')

test('only the bundled error document is the fatal page', () => {
  assert.equal(isFatalPage('file://' + errorPage, errorPage), true)
  assert.equal(isFatalPage('file://' + errorPage + '?title=The%20harness%20stopped%20unexpectedly%20(exit%201)', errorPage), true)
  assert.equal(isFatalPage('file://' + errorPage + '#top', errorPage), true)
  assert.equal(isFatalPage('http://127.0.0.1:5051/', errorPage), false)
  assert.equal(isFatalPage('http://127.0.0.1:5051/error.html', errorPage), false)
  assert.equal(isFatalPage('file://' + errorPage + '.evil', errorPage), false)
  assert.equal(isFatalPage('file:///tmp/error.html', errorPage), false)
  assert.equal(isFatalPage('file://' + path.join('/app', 'shell', 'src', 'ui', 'error.html.bak'), errorPage), false)
  assert.equal(isFatalPage('', errorPage), false)
  assert.equal(isFatalPage('not a url', errorPage), false)
  assert.equal(isFatalPage('file://' + errorPage, ''), false)
})

test('two silent restarts then the fatal screen', () => {
  assert.deepEqual(crashRestartPlan(0), { action: 'retry', delayMs: 800 })
  assert.deepEqual(crashRestartPlan(1), { action: 'retry', delayMs: 2400 })
  assert.deepEqual(crashRestartPlan(2), { action: 'fatal' })
  assert.deepEqual(crashRestartPlan(9), { action: 'fatal' })
  assert.deepEqual(crashRestartPlan(-1), { action: 'fatal' })
  assert.deepEqual(crashRestartPlan('nope'), { action: 'fatal' })
})

test('the fatal title names the exit', () => {
  assert.equal(unexpectedStopTitle(1), 'The harness stopped unexpectedly (exit 1)')
  assert.equal(unexpectedStopTitle(0), 'The harness stopped unexpectedly (exit 0)')
  assert.equal(unexpectedStopTitle(null, 'SIGTERM'), 'The harness stopped unexpectedly (SIGTERM)')
  assert.equal(unexpectedStopTitle(1, 'SIGTERM'), 'The harness stopped unexpectedly (exit 1)')
})
