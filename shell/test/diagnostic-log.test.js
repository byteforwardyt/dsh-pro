import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { createDiagnosticLog, redactDiagnostic, DAY_MS } = require('../src/diagnostic-log.cjs')
const MAIN = readFileSync(new URL('../src/main.cjs', import.meta.url), 'utf8')
const MENU = readFileSync(new URL('../src/menu.cjs', import.meta.url), 'utf8')

test('diagnostics are reachable from Help and include app, preview, and tool failures', () => {
  assert.match(MENU, /Open Last 24 Hours of Diagnostics/)
  assert.match(MAIN, /onRevealDiagnostics: revealDiagnosticLog/)
  assert.match(MAIN, /'did-attach-webview'/)
  assert.match(MAIN, /'dsh:diagnostic'/)
  assert.match(MAIN, /'uncaughtExceptionMonitor'/)
})

test('diagnostics keep only the last 24 hours and are private', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'diagnostics-24h.log')
  let clock = Date.UTC(2026, 8, 24, 12)
  const log = createDiagnosticLog({ file, now: () => clock })
  assert.equal(log.write('info', 'app', 'old event'), true)
  clock += DAY_MS + 1
  assert.equal(log.write('error', 'tool:bash', 'new event'), true)
  const body = readFileSync(log.revealPath(), 'utf8')
  assert.doesNotMatch(body, /old event/)
  assert.match(body, /new event/)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('diagnostics redact common secrets and never permit forged lines', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'diagnostics-24h.log')
  const log = createDiagnosticLog({ file })
  log.write('error', 'renderer', 'authorization: Bearer eyJprivate\napi_key=abc123 https://example.test/a?token=secret')
  const body = readFileSync(file, 'utf8')
  assert.doesNotMatch(body, /eyJprivate|abc123|token=secret/)
  assert.match(body, /\[error\] \[renderer\]/)
  assert.equal(body.trim().split('\n').length, 1)
  assert.equal(redactDiagnostic('password="hunter2"'), 'password=[redacted]')
  assert.doesNotMatch(redactDiagnostic('"api_key":"json-secret" Cookie: a=1; b=2'), /json-secret|a=1|b=2/)
})

test('diagnostics discard oldest entries when the size cap is reached', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-diagnostics-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'diagnostics-24h.log')
  const log = createDiagnosticLog({ file, maxBytes: 120 })
  log.write('info', 'app', 'first event')
  log.write('info', 'app', 'second event')
  log.write('error', 'app', 'latest event')
  const body = readFileSync(log.revealPath(), 'utf8')
  assert.match(body, /latest event/)
  assert.doesNotMatch(body, /first event/)
  assert.ok(Buffer.byteLength(body) <= 120)
})
