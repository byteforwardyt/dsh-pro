import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SRC = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')
const MAIN = read('../src/main.cjs')
const PRELOAD = read('../src/preload.cjs')
const ERROR = read('../src/ui/error.html')

test('the fatal screen offers Retry, Reveal Logs, and Copy details', () => {
  assert.match(ERROR, /id="retry"/)
  assert.match(ERROR, />Retry</)
  assert.match(ERROR, /id="logs"/)
  assert.match(ERROR, />Reveal Logs</)
  assert.match(ERROR, /id="copy"/)
  assert.match(ERROR, />Copy details</)
  assert.match(ERROR, /desktop\.retryHarness/)
  assert.match(ERROR, /desktop\.revealLogs/)
})

test('the fatal window drags its body and carves the controls back out with a descendant selector', () => {
  assert.match(ERROR, /body\s*\{[^}]*-webkit-app-region:\s*drag/s)
  assert.match(ERROR, /main \* \{[^}]*-webkit-app-region:\s*no-drag/)
  assert.doesNotMatch(ERROR, /main\s*>\s*\*/)
})

test('preload exposes retry and reveal, and main only honors them from error.html', () => {
  assert.match(PRELOAD, /retryHarness: \(\) => ipcRenderer\.invoke\('dsh:retry-harness'\)/)
  assert.match(PRELOAD, /revealLogs: \(\) => ipcRenderer\.invoke\('dsh:reveal-logs'\)/)
  assert.match(MAIN, /ipcMain\.handle\('dsh:retry-harness'/)
  assert.match(MAIN, /ipcMain\.handle\('dsh:reveal-logs'/)
  assert.match(MAIN, /function fromFatalPage \(event\) \{[\s\S]*isFatalPage\(event\.senderFrame\?\.url \?\? '', errorPagePath\(\)\)/)
  const retry = MAIN.slice(MAIN.indexOf("ipcMain.handle('dsh:retry-harness'"), MAIN.indexOf("ipcMain.handle('dsh:reveal-logs'"))
  assert.match(retry, /fromFatalPage\(event\)/)
  assert.doesNotMatch(retry, /isHostUrl/)
})

test('Retry reuses the existing window and a host crash auto-restarts twice', () => {
  assert.match(MAIN, /existingWindow\(\) \|\| createWindow\(\)/)
  assert.match(MAIN, /registerFatalHandler\(\)/)
  assert.match(MAIN, /crashRestartPlan\(consecutiveCrashes\)/)
  assert.match(MAIN, /void showFatal\(unexpectedStopTitle\(code, signal\), detail\)/)
  assert.match(MAIN, /diagnostics-24h\.log/)
  assert.match(MAIN, /return revealDiagnosticLog\(\)/)
  assert.doesNotMatch(MAIN, /persistLogLine/)
})
