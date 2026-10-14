import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../src/ui/loading.html', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main.cjs', import.meta.url), 'utf8')
function soundPage ({ reduced = false, rejected = false } = {}) {
  let audio, tick, now = 0, cleared = false
  class Audio {
    constructor () { audio = this; this.currentTime = 0; this.listeners = {} }
    addEventListener (name, fn) { this.listeners[name] = fn }
    removeEventListener (name) { delete this.listeners[name] }
    play () { return rejected ? Promise.reject(new Error('blocked')) : Promise.resolve() }
    pause () { this.paused = true }
    emit (name) { this.listeners[name]?.() }
  }
  const context = { window: {}, Audio, matchMedia: () => ({ matches: reduced }),
    performance: { now: () => now }, setInterval: fn => { tick = fn; return 1 },
    clearInterval: () => { cleared = true } }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context)
  return { promise: context.window.startupSoundFinished, audio,
    advance (ms) { now += ms; tick?.() }, get cleared () { return cleared } }
}

test('sound gate waits for ended, not play() or elapsed duration', async () => {
  const page = soundPage()
  assert.equal(typeof page.promise?.then, 'function')
  let done = false
  page.promise.then(() => { done = true })
  await Promise.resolve()
  assert.equal(done, false)
  for (let i = 0; i < 20; i++) {
    page.audio.currentTime += 1; page.audio.emit('timeupdate'); page.advance(1000)
  }
  await Promise.resolve()
  assert.equal(done, false, 'healthy playback must not be cut off by a fixed timeout')
  page.audio.emit('ended')
  assert.equal(await page.promise, 'ended')
  assert.equal(page.cleared, true)
})

test('skipped, rejected, failed and stalled audio cannot block startup', async () => {
  assert.equal(await soundPage({ reduced: true }).promise, 'skipped')
  assert.equal(await soundPage({ rejected: true }).promise, 'unavailable')
  const failed = soundPage(); failed.audio.emit('error')
  assert.equal(await failed.promise, 'unavailable')
  const stalled = soundPage(); stalled.advance(10000)
  assert.equal(await stalled.promise, 'stalled')
  assert.equal(stalled.audio.paused, true)
})

test('ready host navigation awaits sound and refuses stale or destroyed windows', async () => {
  const source = main.match(/async function revealBootedHost \(win, url, launchUrl = hostLaunchUrl \|\| url\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(source, 'startup needs a shared sound-aware navigation gate')
  let resolve, loaded = [], destroyed = false
  const audio = new Promise(r => { resolve = r })
  const context = { hostUrl: 'http://localhost:1234', hostLaunchUrl: null, quitting: false, fatalShown: false,
    path: { join: () => '/loading.html' }, __dirname: '/',
    pathToFileURL: () => ({ href: 'file:///loading.html' }), recordLog () {},
    seedCapabilityCookie: async () => {} }
  vm.createContext(context); vm.runInContext(source, context)
  const win = { isDestroyed: () => destroyed, webContents: {
    getURL: () => 'file:///loading.html', executeJavaScript: () => audio },
    loadURL: async url => { loaded.push(url) } }
  const navigation = context.revealBootedHost(win, context.hostUrl)
  await Promise.resolve(); assert.equal(loaded.length, 0)
  resolve('ended'); await navigation
  assert.deepEqual(loaded, [context.hostUrl])
  destroyed = true; await context.revealBootedHost(win, context.hostUrl)
  destroyed = false; context.hostUrl = 'http://localhost:5678'
  await context.revealBootedHost(win, 'http://localhost:1234')
  assert.equal(loaded.length, 1)
  assert.match(main, /await revealBootedHost\(win, started\.url, started\.launchUrl\)/)
  assert.match(main, /await revealBootedHost\(win, hostUrl\)/)
})
