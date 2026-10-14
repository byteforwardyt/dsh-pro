import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The tray is a three-file joint with no type between the halves. A renamed
// channel, a dropped attachTray call, or a feed cap that drifted between the
// page and main all fail the same way: the menu bar is empty and nothing
// throws. These assertions are the only link.

const SRC = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(join(SRC, rel), 'utf8')
const MAIN = read('../src/main.cjs')
const PRELOAD = read('../src/preload.cjs')
const HOST = read('../src/tray-host.cjs')
const NOTIFY = read('../../plugins/client-ui-notify/lib/client.js')

test('the page publishes on the channel main listens for', () => {
  assert.match(PRELOAD, /publishSessions: \(state\) => \{ ipcRenderer\.send\('dsh:sessions-state', state\) \}/)
  assert.match(MAIN, /ipcMain\.on\('dsh:sessions-state'/
  )
  assert.match(NOTIFY, /bridge\.publishSessions\(next\)/)
})

test('the sender fence is the same one the other desktop channels use', () => {
  // Copied from registerNotifyHandler / registerMenuStateHandler. A weaker
  // check here would be the only IPC that a <webview> guest could reach.
  assert.match(MAIN, /function registerSessionsHandler \(\) \{\s*ipcMain\.on\('dsh:sessions-state', \(event, state\) => \{\s*if \(!isHostUrl\(event\.senderFrame\?\.url \?\? ''\) \|\| event\.senderFrame !== event\.sender\.mainFrame\) return/s)
})

test('the tray is created on ready and destroyed on quit', () => {
  assert.match(MAIN, /trayHost = attachTray\(\{/)
  assert.match(MAIN, /iconPath: path\.join\(__dirname, 'assets', 'trayTemplate\.png'\)/)
  assert.match(MAIN, /openApp: focusApp/)
  assert.match(MAIN, /if \(trayHost !== null\) \{ try \{ trayHost\.destroy\(\) \} catch \{\} ; trayHost = null \}/)
  assert.match(MAIN, /registerSessionsHandler\(\)/)
})

test('the two feed caps are the same number', () => {
  const host = /const FEED_CAP = (\d+)/.exec(HOST)
  const page = /const FEED_CAP = (\d+)/.exec(NOTIFY)
  assert.ok(host && page, 'a FEED_CAP declaration is gone')
  assert.equal(host[1], page[1], 'page cap ' + page[1] + ' vs host cap ' + host[1])
  assert.equal(Number(host[1]), 32)
})

test('notifications off is not allowed to gate the tray', () => {
  // The feed is built even when notify is missing, and publishSessions is not
  // inside a pref.value check. If someone later wraps it in the preference,
  // this is the assertion that fails.
  assert.match(NOTIFY, /const canFeed = typeof bridge\.publishSessions === "function"/)
  assert.match(NOTIFY, /const feed = canFeed \? createSessionFeed\(\) : null/)
  const publish = NOTIFY.slice(NOTIFY.indexOf('function sync()'), NOTIFY.indexOf('function pushEnabled'))
  assert.match(publish, /bridge\.publishSessions\(next\)/)
  assert.doesNotMatch(publish, /pref\.value/)
})
