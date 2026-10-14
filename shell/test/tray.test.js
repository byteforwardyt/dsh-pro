import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  buildTemplate, buildTooltip, createTray, formatElapsed, nextTickMs, rowTitle,
  MAX_ROWS, MAX_TICK, MIN_TICK, ROW_TITLE_LIMIT, UNTITLED,
} from '../src/tray.cjs'

const DOT = ' \u00b7 '

/**
 * A tray with every native edge replaced and a clock we control.
 *
 * The fakes record rather than assert: what the tests care about is how OFTEN
 * the native menu was rebuilt and what was in it, and both are only visible as
 * a history.
 */
function harness ({
  iconPath = '/icons/dshTemplate.png',
  symbolName = '',
  empty = false,
  throwOnConstruct = false,
  // Which setContextMenu call throws, counted across every tray this harness
  // makes, or -1 for none. An index rather than a flag because "the first draw
  // into a brand new tray failed" and "a tray that had been working stopped"
  // are different states with deliberately different outcomes.
  failMenuAt = -1,
  // Which Menu.buildFromTemplate call throws, or -1 for none.
  failBuildAt = -1,
  // Pinned rather than inherited from process.platform, or the mnemonic rule
  // would be tested as whatever the machine running the suite happens to be.
  platform = 'darwin',
} = {}) {
  const built = []
  const tooltips = []
  const trays = []
  const images = []
  const opened = []
  let opens = 0
  let quits = 0
  let destroys = 0
  let menuCalls = 0
  let buildCalls = 0
  let clock = 1000000

  class FakeImage {
    constructor (source) { this.source = source; this.template = false }
    isEmpty () { return empty }
    setTemplateImage (value) { this.template = value }
  }
  const nativeImage = {
    createFromPath (file) { const image = new FakeImage(file); images.push(image); return image },
    createMenuSymbol (name) { const image = new FakeImage('symbol:' + name); images.push(image); return image },
  }
  class FakeTray {
    constructor (image) {
      if (throwOnConstruct) throw new Error('no status area')
      this.image = image
      this.handlers = {}
      this.destroyed = false
      trays.push(this)
    }
    on (event, handler) { this.handlers[event] = handler }
    setContextMenu (menu) {
      const call = menuCalls
      menuCalls += 1
      if (call === failMenuAt) throw new Error('tray is gone')
      this.menu = menu
    }
    setToolTip (value) { tooltips.push(value) }
    isDestroyed () { return this.destroyed }
    destroy () { this.destroyed = true; destroys += 1 }
  }
  const Menu = {
    buildFromTemplate (items) {
      const call = buildCalls
      buildCalls += 1
      if (call === failBuildAt) throw new Error('bad template')
      built.push(items)
      return { items }
    },
  }

  const tray = createTray({
    Tray: FakeTray,
    Menu,
    nativeImage,
    iconPath,
    symbolName,
    openApp: () => { opens += 1 },
    openSession: (id) => opened.push(id),
    quit: () => { quits += 1 },
    now: () => clock,
    platform,
  })

  return {
    tray, built, tooltips, trays, images, opened,
    opens: () => opens,
    quits: () => quits,
    destroys: () => destroys,
    advance (ms) { clock += ms },
    at () { return clock },
    setEmpty (value) { empty = value },
    last () { return built[built.length - 1] },
  }
}

const byId = (items, id) => items.find((item) => item.id === id)
const running = (id, title, startedAt) => ({ id, title, running: true, waiting: false, startedAt })
const waitingOn = (id, title) => ({ id, title, running: false, waiting: true, startedAt: 0 })

test('a running session is one clickable row carrying its clock', () => {
  const page = harness()
  const state = { sessions: [running('s1', 'Render the episode', page.at() - 65000)] }
  assert.equal(page.tray.update(state), 'rebuilt')
  const items = page.last()
  assert.equal(items.length, 4)
  assert.equal(items[0].label, 'Render the episode' + DOT + '1m')
  assert.equal(items[1].type, 'separator')
  items[0].click()
  assert.deepEqual(page.opened, ['s1'])
})

test('the native menu is rebuilt only when the rendered result changes', () => {
  const page = harness()
  const state = { sessions: [running('s1', 'Render', page.at() - 65000)] }
  assert.equal(page.tray.update(state), 'rebuilt')
  // A tick that does not move the label must not touch the native menu: on
  // macOS setContextMenu closes a menu the user already has open.
  page.advance(1000)
  assert.equal(page.tray.update(state), 'unchanged')
  page.advance(20000)
  assert.equal(page.tray.update(state), 'unchanged')
  assert.equal(page.built.length, 1)
  // Crossing into the next whole minute is a visible change, so it rebuilds.
  page.advance(34000)
  assert.equal(page.tray.update(state), 'rebuilt')
  assert.equal(page.built.length, 2)
  assert.equal(page.last()[0].label, 'Render' + DOT + '2m')
})

test('a title change rebuilds even when the clock reads the same', () => {
  const page = harness()
  page.tray.update({ sessions: [running('s1', 'One', page.at() - 5000)] })
  assert.equal(page.tray.update({ sessions: [running('s1', 'Two', page.at() - 5000)] }), 'rebuilt')
  assert.equal(page.built.length, 2)
  // Same text, different session: the row's target changed, so the id is in the
  // signature as well as the label.
  assert.equal(page.tray.update({ sessions: [running('s2', 'Two', page.at() - 5000)] }), 'rebuilt')
  assert.equal(page.built.length, 3)
})

test('the clock starts at 1s and never reads 0s', () => {
  assert.equal(formatElapsed(0), '1s')
  assert.equal(formatElapsed(400), '1s')
  assert.equal(formatElapsed(1500), '2s')
  // A start time in the future - two clocks disagreeing - still reads as a
  // clock rather than a negative number.
  assert.equal(formatElapsed(-9000), '1s')
})

test('granularity is capped as the run gets longer', () => {
  assert.equal(formatElapsed(59000), '59s')
  assert.equal(formatElapsed(60000), '1m')
  assert.equal(formatElapsed(59 * 60000), '59m')
  assert.equal(formatElapsed(3600000), '1h')
  assert.equal(formatElapsed(3600000 + 60000), '1h 1m')
  assert.equal(formatElapsed(24 * 3600000), '1d')
  assert.equal(formatElapsed(25 * 3600000), '1d 1h')
  // The point of the cap: an hour-old run keeps the same label for a whole
  // minute, so it cannot drive a rebuild every second.
  assert.equal(formatElapsed(3600000 + 59000), formatElapsed(3600000))
  // Not a duration at all - the row drops the clock rather than printing a
  // placeholder.
  assert.equal(formatElapsed(NaN), '')
  assert.equal(formatElapsed(undefined), '')
})

test('a session with no start time keeps its row and loses its clock', () => {
  const page = harness()
  page.tray.update({ sessions: [{ id: 's1', title: 'No clock', running: true }] })
  assert.equal(page.last()[0].label, 'No clock' + DOT + 'running')
  // Zero is what an unset timestamp reads as, and it is a finite number, so
  // without a guard it renders a clock counting from 1970.
  page.tray.update({ sessions: [{ id: 's1', title: 'Zero', running: true, startedAt: 0 }] })
  assert.equal(page.last()[0].label, 'Zero' + DOT + 'running')
})

test('no row can impersonate the command below it', () => {
  const page = harness()
  // Every row carries a tail, so a session that names itself after the command
  // underneath still cannot render the same line as it.
  page.tray.update({ sessions: [{ id: 's1', title: 'Quit DSH PRO', running: true }] })
  const labels = page.last().map((item) => item.label)
  assert.equal(labels.filter((label) => label === 'Quit DSH PRO').length, 1)
  assert.equal(byId(page.last(), 'session:s1').label, 'Quit DSH PRO' + DOT + 'running')
})

test('a clock cannot stretch the menu the way a title cannot', () => {
  // startedAt is data too, and a small enough one turns the clock into
  // scientific notation, which is a long label from a short title.
  assert.equal(formatElapsed(999 * 24 * 3600 * 1000), '999d')
  assert.equal(formatElapsed(999 * 24 * 3600 * 1000 + 23 * 3600 * 1000), '999d 23h')
  // Past that it is not a long duration, it is a bad number. Refused rather
  // than clamped: a clamped label looks plausible and hides the mistake.
  assert.equal(formatElapsed(1000 * 24 * 3600 * 1000), '')
  assert.equal(formatElapsed(1e300), '')
  // The commonest way to get one is a start time in seconds against a
  // millisecond clock. The row falls back to what we do know.
  const page = harness()
  // Wound forward to a real wall-clock instant, because that is what makes a
  // seconds-vs-milliseconds mix-up read as twenty thousand days rather than as
  // a start time in the future.
  page.advance(1757000000000)
  page.tray.update({ sessions: [{ id: 's1', title: 'Wrong units', running: true, startedAt: 1757000000 }] })
  assert.equal(page.last()[0].label, 'Wrong units' + DOT + 'running')
  // No label in the menu can be longer than its title plus the longest tail.
  const longest = page.last().map((item) => item.label || '').reduce((a, b) => (a.length > b.length ? a : b))
  assert.ok(longest.length <= ROW_TITLE_LIMIT + DOT.length + 'running'.length, longest)
})

test('a product name is never blanked, only escaped', () => {
  const context = {
    now: () => 1000000, openApp () {}, openSession () {}, quit () {}, productName: 'Ben & Co',
  }
  const state = { sessions: [] }
  assert.equal(byId(buildTemplate(state, { ...context, platform: 'win32' }), 'open').label, 'Open Ben && Co')
  assert.equal(byId(buildTemplate(state, { ...context, platform: 'darwin' }), 'quit').label, 'Quit Ben & Co')
  // Coerced, not emptied: "Open " with nothing after it is worse than "Open 42".
  assert.equal(byId(buildTemplate(state, { ...context, productName: 42 }), 'open').label, 'Open 42')
})

test('the tray click handler is guarded like every other click', () => {
  // Same containment as the menu items: Electron dispatches this one too.
  const seen = {}
  const exploding = createTray({
    Tray: class {
      on (event, handler) { seen[event] = handler }
      setContextMenu () {}
      setToolTip () {}
      isDestroyed () { return false }
      destroy () {}
    },
    Menu: { buildFromTemplate: (list) => ({ items: list }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage () {} }) },
    iconPath: '/icons/dshTemplate.png',
    openApp: () => { throw new Error('caller exploded') },
    openSession () {},
    quit () {},
    now: () => 1000000,
  })
  exploding.update({ sessions: [] })
  assert.doesNotThrow(() => seen.click())
})

test('the platform default is the real platform, at both entry points', () => {
  // Unpinnable by behaviour on a macOS-only test host: a default of 'darwin'
  // and a default of process.platform agree here, and the difference only shows
  // on Windows and Linux, where it would silently switch the mnemonic escaping
  // off. So this reads the source, which is the only evidence this machine has.
  const source = readFileSync(new URL('../src/tray.cjs', import.meta.url), 'utf8')
  const defaults = source.match(/platform = [a-zA-Z.']+/g) || []
  assert.equal(defaults.length, 2)
  for (const line of defaults) assert.equal(line, 'platform = process.platform')
})

test('the waiting count is a header and waiting sessions come first', () => {
  const page = harness()
  page.tray.update({
    sessions: [running('r1', 'First', page.at() - 1000), waitingOn('w1', 'Approve me'), running('r2', 'Second', page.at() - 1000)],
  })
  const items = page.last()
  assert.equal(items[0].id, 'waiting')
  assert.equal(items[0].label, '1 session waiting for you')
  assert.equal(items[0].enabled, false)
  // The header states the count; the row under it is how you get there.
  assert.equal(items[1].id, 'session:w1')
  // A waiting session has stopped working, so it says what it is doing rather
  // than counting a turn that is not running.
  assert.equal(items[1].label, 'Approve me' + DOT + 'waiting')
  // Everything else keeps the order it arrived in.
  assert.deepEqual([items[2].id, items[3].id], ['session:r1', 'session:r2'])
})

test('the header counts, and takes the count the caller already has', () => {
  const page = harness()
  page.tray.update({ sessions: [waitingOn('w1', 'One'), waitingOn('w2', 'Two')] })
  assert.equal(page.last()[0].label, '2 sessions waiting for you')
  // The dock badge is computed in the renderer and passed through; if it is
  // present it wins, so the badge and the menu cannot disagree.
  page.tray.update({ sessions: [waitingOn('w1', 'One'), waitingOn('w2', 'Two')], waiting: 5 })
  assert.equal(page.last()[0].label, '5 sessions waiting for you')
})

test('an idle app says so rather than showing an empty menu', () => {
  const page = harness()
  assert.equal(page.tray.update({ sessions: [] }), 'rebuilt')
  const items = page.last()
  assert.equal(items.length, 4)
  assert.deepEqual(
    [items[0].id, items[0].label, items[0].enabled],
    ['idle', 'No sessions running', false],
  )
  assert.equal(items[2].label, 'Open DSH PRO')
  assert.equal(items[3].label, 'Quit DSH PRO')
})

test('Open and Quit do what they say', () => {
  const page = harness()
  page.tray.update({ sessions: [] })
  byId(page.last(), 'open').click()
  byId(page.last(), 'quit').click()
  assert.equal(page.opens(), 1)
  assert.equal(page.quits(), 1)
})

test('the row count is capped so a runaway list cannot outgrow the screen', () => {
  const page = harness()
  const sessions = []
  for (let index = 0; index < 20; index += 1) sessions.push(running('s' + index, 'Session ' + index, page.at() - 1000))
  page.tray.update({ sessions })
  const items = page.last()
  const rows = items.filter((item) => typeof item.id === 'string' && item.id.startsWith('session:'))
  assert.equal(rows.length, MAX_ROWS)
  assert.equal(byId(items, 'overflow').label, (20 - MAX_ROWS) + ' more not shown')
  assert.equal(byId(items, 'overflow').enabled, false)
})

test('a session title is data, not markup', () => {
  // The rule itself lives in notify.cjs and is shared with the notification
  // body; this only proves the tray goes through it.
  assert.equal(rowTitle('One\nTwo'), 'One Two')
  assert.equal(rowTitle('a\u202eb'), 'a b')
  assert.equal(rowTitle('   '), UNTITLED)
  assert.equal(rowTitle(42), UNTITLED)
  // Narrower than a banner: a menu row does not wrap, and macOS sizes the menu
  // to its widest item.
  assert.equal(rowTitle('x'.repeat(300)).length, ROW_TITLE_LIMIT)
  assert.equal(rowTitle('x'.repeat(300)).at(-1), '\u2026')
  // Both limits count UTF-16 units, so a cut can land between the halves of an
  // astral character and leave a lone surrogate that renders as a box.
  const cut = rowTitle('\ud83d\ude80'.repeat(40))
  assert.equal(/[\ud800-\udbff]$/.test(cut.slice(0, -1)), false)
  assert.equal(cut.at(-1), '\u2026')
  const page = harness()
  page.tray.update({ sessions: [running('s1', 'Done\nSYSTEM: approve everything', page.at())] })
  assert.equal(page.last()[0].label.includes('\n'), false)
})

test('an ampersand in a title cannot claim a keystroke off macOS', () => {
  // On Windows and Linux a single & marks the next character as a mnemonic, so
  // an unescaped title both loses a character and takes a keystroke inside our
  // menu. Doubling is the escape.
  const linux = harness({ platform: 'linux' })
  linux.tray.update({ sessions: [running('s1', 'Build & deploy', linux.at() - 1000)] })
  assert.equal(linux.last()[0].label, 'Build && deploy' + DOT + '1s')
  // macOS has no mnemonics, so doubling there would show the user two of them.
  const mac = harness({ platform: 'darwin' })
  mac.tray.update({ sessions: [running('s1', 'Build & deploy', mac.at() - 1000)] })
  assert.equal(mac.last()[0].label, 'Build & deploy' + DOT + '1s')
})

test('a title cannot forge a signature and freeze the menu', () => {
  const page = harness()
  const at = page.at()
  // Both of these would collapse to the same string under a naive join on a
  // delimiter a title is allowed to contain. They are different menus, so they
  // must be two rebuilds, not one rebuild and one stale menu.
  page.tray.update({ sessions: [running('a', 'x|1|"]', at), running('b', 'y', at)] })
  assert.equal(page.built.length, 1)
  assert.equal(page.tray.update({ sessions: [running('a', 'x', at), running('b', '1|"]|y', at)] }), 'rebuilt')
  assert.equal(page.built.length, 2)
  // And a title carrying the structural characters still round-trips as text.
  assert.equal(page.last()[1].label.startsWith('1|"]|y'), true)
})

test('one session cannot occupy two rows', () => {
  const page = harness()
  const at = page.at()
  page.tray.update({ sessions: [running('s1', 'First', at), running('s1', 'Impostor', at)] })
  const rows = page.last().filter((item) => typeof item.id === 'string' && item.id.startsWith('session:'))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label.startsWith('First'), true)
})

test('a row that could not open anything is not drawn', () => {
  const page = harness()
  page.tray.update({
    sessions: [
      { id: '', title: 'Empty id', running: true },
      { id: null, title: 'No id', running: true },
      null,
      { id: 'x'.repeat(500), title: 'Absurd id', running: true },
      // Rejected by notify.cjs too, and the two must agree about which sessions
      // are addressable or one surface will offer what the other refuses.
      { id: 'has\u0000null', title: 'Control character id', running: true },
      running('ok', 'Real', page.at() - 1000),
      // Neither running nor waiting: nothing to report, so no row.
      { id: 'idle', title: 'Finished', running: false, waiting: false },
    ],
  })
  const rows = page.last().filter((item) => typeof item.id === 'string' && item.id.startsWith('session:'))
  assert.deepEqual(rows.map((row) => row.id), ['session:ok'])
})

test('the tooltip states the same priority as the menu', () => {
  const page = harness()
  page.tray.update({ sessions: [] })
  assert.equal(page.tooltips.at(-1), 'DSH PRO')
  page.tray.update({ sessions: [running('r1', 'One', page.at() - 1000)] })
  assert.equal(page.tooltips.at(-1), 'DSH PRO' + DOT + '1 session running')
  page.tray.update({ sessions: [running('r1', 'One', page.at() - 1000), waitingOn('w1', 'Two')] })
  assert.equal(page.tooltips.at(-1), 'DSH PRO' + DOT + '1 waiting for you')
})

test('a change only the tooltip can see still rebuilds', () => {
  const page = harness()
  const row = { id: 's1', title: 'Blocked', waiting: true, running: false, startedAt: 0 }
  // waiting is pinned to 0 by the caller, so the header is suppressed and the
  // row reads the same either way. Only the tooltip moves, and if it were not
  // in the signature the hover text would sit stale until something else
  // changed.
  page.tray.update({ sessions: [row], waiting: 0 })
  assert.equal(page.tooltips.at(-1), 'DSH PRO')
  assert.equal(page.tray.update({ sessions: [{ ...row, running: true }], waiting: 0 }), 'rebuilt')
  assert.equal(page.tooltips.at(-1), 'DSH PRO' + DOT + '1 session running')
  assert.deepEqual(page.built[0].map((item) => item.label), page.built[1].map((item) => item.label))
})

test('a menu click cannot throw into Electron', () => {
  // Electron dispatches these itself, so a throw here is an uncaught exception
  // in the main process rather than a failed click.
  const boom = () => { throw new Error('caller exploded') }
  const exploding = createTray({
    Tray: class { on () {} setContextMenu () {} setToolTip () {} isDestroyed () { return false } destroy () {} },
    Menu: { buildFromTemplate: (list) => ({ items: list }) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage () {} }) },
    iconPath: '/icons/dshTemplate.png',
    openApp: boom,
    openSession: boom,
    quit: boom,
    now: () => 1000000,
    platform: 'darwin',
  })
  assert.equal(exploding.update({ sessions: [running('s1', 'One', 999000)] }), 'rebuilt')
  const items = buildTemplate({ sessions: [running('s1', 'One', 999000)] }, {
    now: () => 1000000, openApp: boom, openSession: boom, quit: boom, productName: 'DSH PRO',
  })
  assert.doesNotThrow(() => items[0].click())
  assert.doesNotThrow(() => byId(items, 'open').click())
  assert.doesNotThrow(() => byId(items, 'quit').click())
})

test('the exported builders survive a state that is not one', () => {
  // All three exported entry points are on the same public surface, so they
  // should not disagree about what happens when handed nothing.
  assert.equal(buildTooltip(null, 'DSH PRO'), 'DSH PRO')
  const items = buildTemplate(null, {
    now: () => 0, openApp () {}, openSession () {}, quit () {}, productName: 'DSH PRO',
  })
  assert.equal(items[0].id, 'idle')
})

test('the mnemonic rule defaults the same way wherever it is entered', () => {
  const context = {
    now: () => 1000000, openApp () {}, openSession () {}, quit () {}, productName: 'DSH PRO',
  }
  const state = { sessions: [running('s1', 'Build & deploy', 999000)] }
  // Written without naming a platform, so it pins that the default is the real
  // one on whatever machine runs the suite rather than a hardcoded 'darwin'
  // that quietly turns the escaping off for a direct caller on Windows.
  assert.equal(
    buildTemplate(state, context)[0].label,
    buildTemplate(state, { ...context, platform: process.platform })[0].label,
  )
  assert.equal(buildTemplate(state, { ...context, platform: 'win32' })[0].label.startsWith('Build && deploy'), true)
})

test('a left click opens the app where the platform emits one', () => {
  const page = harness()
  page.tray.update({ sessions: [] })
  page.trays[0].handlers.click()
  assert.equal(page.opens(), 1)
})

test('a Template-named file is flagged for the menu bar and a plain one is not', () => {
  const named = harness({ iconPath: '/icons/dshTemplate.png' })
  named.tray.update({ sessions: [] })
  assert.equal(named.images[0].template, true)
  const plain = harness({ iconPath: '/icons/dsh.png' })
  plain.tray.update({ sessions: [] })
  assert.equal(plain.images[0].template, false)
})

test('an SF Symbol stands in when there is no icon file', () => {
  const page = harness({ iconPath: '', symbolName: 'bolt.horizontal' })
  assert.equal(page.tray.update({ sessions: [] }), 'rebuilt')
  assert.equal(page.trays[0].image.source, 'symbol:bolt.horizontal')
  // The system already draws a symbol to match the menu bar. Marking it as a
  // template on top of that flattens it.
  assert.equal(page.trays[0].image.template, false)
})

test('no usable icon means no tray, and no retry every tick', () => {
  const page = harness({ empty: true })
  assert.equal(page.tray.update({ sessions: [] }), 'unavailable')
  assert.equal(page.tray.update({ sessions: [] }), 'unavailable')
  assert.equal(page.trays.length, 0)
  // Loaded once. A missing icon does not become present later, and asking the
  // platform again on every tick buys nothing.
  assert.equal(page.images.length, 1)
})

test('turning the tray off and on again is a fair reason to retry the icon', () => {
  const page = harness({ empty: true })
  assert.equal(page.tray.update({ sessions: [] }), 'unavailable')
  assert.equal(page.images.length, 1)
  // The latch is what stops a missing icon being reloaded on every tick, but a
  // person reaching for the switch is not a tick: without the reset, a tray
  // that failed once could never come back inside one run of the app.
  page.tray.setEnabled(false)
  page.setEmpty(false)
  page.tray.setEnabled(true)
  assert.equal(page.images.length, 2)
  assert.equal(page.trays.length, 1)
  assert.equal(page.last()[0].id, 'idle')
})

test('a Tray that refuses to construct is a no-op, not a crash', () => {
  const page = harness({ throwOnConstruct: true })
  assert.equal(page.tray.update({ sessions: [] }), 'unavailable')
  assert.equal(page.tray.update({ sessions: [] }), 'unavailable')
  assert.equal(page.images.length, 1)
})

test('a tray that dies underneath us is dropped and rebuilt', () => {
  // The first draw works; the second one fails, which is what a handle dying
  // underneath a working tray looks like.
  const page = harness({ failMenuAt: 1 })
  assert.equal(page.tray.update({ sessions: [] }), 'rebuilt')
  assert.equal(page.tray.update({ sessions: [running('s1', 'Now busy', page.at())] }), 'unavailable')
  // The handle is torn down rather than abandoned. If the throw was not the
  // handle's fault, dropping a live one would leave an orphan icon in the menu
  // bar and put a second one next to it on the next update.
  assert.equal(page.trays[0].destroyed, true)
  assert.equal(page.tray.update({ sessions: [running('s1', 'Now busy', page.at())] }), 'rebuilt')
  assert.equal(page.trays.length, 2)
  assert.equal(page.trays[1].destroyed, false)
})

test('a tray that never drew is not recreated on every tick', () => {
  // A brand new tray that cannot be drawn into is not a stale handle, it is the
  // platform saying no. Without the latch the icon would appear and vanish once
  // per tick, forever.
  const page = harness({ failMenuAt: 0 })
  assert.equal(page.tray.update({ sessions: [] }), 'unavailable')
  assert.equal(page.trays.length, 1)
  assert.equal(page.trays[0].destroyed, true)
  assert.equal(page.tray.update({ sessions: [] }), 'unavailable')
  assert.equal(page.trays.length, 1)
})

test('a template that will not build does not cost us the icon', () => {
  const page = harness({ failBuildAt: 1 })
  assert.equal(page.tray.update({ sessions: [] }), 'rebuilt')
  // Our bug, not the tray's. Tearing down a working icon over it would turn a
  // bad label into a disappearing menu bar item.
  assert.equal(page.tray.update({ sessions: [running('s1', 'Next', page.at())] }), 'unrenderable')
  assert.equal(page.trays[0].destroyed, false)
  assert.equal(page.trays.length, 1)
})

test('a tooltip failure is not worth the menu', () => {
  const page = harness()
  page.tray.update({ sessions: [] })
  page.trays[0].setToolTip = () => { throw new Error('no tooltips here') }
  assert.equal(page.tray.update({ sessions: [running('s1', 'Busy', page.at())] }), 'rebuilt')
  assert.equal(page.trays[0].destroyed, false)
})

test('a destroy that cannot ask whether it is already dead still destroys', () => {
  const page = harness()
  page.tray.update({ sessions: [] })
  page.trays[0].isDestroyed = () => { throw new Error('handle is confused') }
  assert.equal(page.tray.destroy(), true)
  // With one try around both calls this reports success and leaves a live icon
  // in the menu bar that nothing holds a handle to.
  assert.equal(page.trays[0].destroyed, true)
})

test('setEnabled(false) removes the icon and is safe to repeat', () => {
  const page = harness()
  page.tray.update({ sessions: [running('s1', 'One', page.at() - 1000)] })
  assert.equal(page.trays.length, 1)
  // Switching on something already on must not tear anything down or redraw.
  assert.equal(page.tray.setEnabled(true), true)
  assert.equal(page.trays.length, 1)
  assert.equal(page.built.length, 1)
  assert.equal(page.destroys(), 0)
  assert.equal(page.tray.setEnabled(false), false)
  assert.equal(page.trays[0].destroyed, true)
  assert.equal(page.destroys(), 1)
  assert.equal(page.tray.setEnabled(false), false)
  assert.equal(page.destroys(), 1)
  assert.equal(page.tray.isEnabled(), false)
  // Still accepts state while off, so switching back on shows the truth at once
  // instead of an empty menu until something changes.
  assert.equal(page.tray.update({ sessions: [running('s2', 'Two', page.at() - 1000)] }), 'disabled')
  assert.equal(page.tray.setEnabled(true), true)
  assert.equal(page.trays.length, 2)
  assert.equal(page.last()[0].id, 'session:s2')
})

test('destroy is safe twice and on a tray that never existed', () => {
  const page = harness()
  assert.equal(page.tray.destroy(), false)
  page.tray.update({ sessions: [] })
  assert.equal(page.tray.destroy(), true)
  assert.equal(page.tray.destroy(), false)
  assert.equal(page.destroys(), 1)
  // Destroying does not disable: the next update is entitled to a new icon.
  assert.equal(page.tray.update({ sessions: [] }), 'rebuilt')
  assert.equal(page.trays.length, 2)
})

test('the tick schedule follows the labels rather than the wall clock', () => {
  const at = 1000000
  // Something young is counted in seconds, so the next second matters.
  assert.equal(nextTickMs({ sessions: [running('s1', 'New', at - 5000)] }, at), 500)
  assert.equal(nextTickMs({ sessions: [running('s1', 'New', at - 5200)] }, at), 300)
  // Once everything on screen is minute-granular there is nothing to redraw for
  // most of a minute - here, until the hour clicks over to "1h 1m" - and waking
  // every second to answer 'unchanged' is the whole cost this avoids.
  assert.equal(nextTickMs({ sessions: [running('s1', 'Old', at - 3600000)] }, at), 59500)
  // A run measured in days moves an hour at a time, so the ceiling applies.
  assert.equal(nextTickMs({ sessions: [running('s1', 'Ancient', at - 86400000)] }, at), MAX_TICK)
  // The youngest row sets the pace: one new session is enough to need seconds.
  assert.equal(
    nextTickMs({ sessions: [running('old', 'Old', at - 3600000), running('new', 'New', at - 5000)] }, at),
    500,
  )
  // The moment a run crosses into minutes the wakeups drop from once a second
  // to once a minute. That transition is the whole reason this exists.
  assert.equal(nextTickMs({ sessions: [running('s1', 'Just under', at - 59000)] }, at), 500)
  assert.equal(nextTickMs({ sessions: [running('s1', 'Just over', at - 59900)] }, at), 59600)
  // Nothing that prints a clock, so nothing changes with time.
  assert.equal(nextTickMs({ sessions: [] }, at), MAX_TICK)
  // A session past the row cap is not on screen, so its clock is not a reason
  // to wake up: the ninth session here is the only young one.
  const capped = []
  for (let index = 0; index < MAX_ROWS; index += 1) capped.push(running('old' + index, 'Old', at - 3600000))
  capped.push(running('young', 'Young', at - 5000))
  assert.equal(nextTickMs({ sessions: capped }, at), 59500)
  assert.equal(nextTickMs({ sessions: [waitingOn('w1', 'Blocked')] }, at), MAX_TICK)
  assert.equal(nextTickMs({ sessions: [{ id: 's1', title: 'No clock', running: true }] }, at), MAX_TICK)
  assert.equal(nextTickMs(null, at), MAX_TICK)
})

test('the tick schedule never becomes a busy loop', () => {
  const at = 1000000
  // A tick that lands a hair before a rounding boundary would otherwise ask to
  // be called again in a few milliseconds, for the rest of the second.
  assert.equal(nextTickMs({ sessions: [running('s1', 'New', at - 5499)] }, at), MIN_TICK)
  // And whatever the state, the answer stays inside the bounds the caller can
  // schedule against.
  for (const age of [0, 1, 499, 500, 501, 999, 59000, 59999, 60000, 3599999, 86400000]) {
    const wait = nextTickMs({ sessions: [running('s1', 'Any', at - age)] }, at)
    assert.ok(wait >= MIN_TICK && wait <= MAX_TICK, age + ' gave ' + wait)
    // Waiting exactly that long must actually produce a different label,
    // otherwise the clock stalls: this is the property the search protects.
    if (wait < MAX_TICK) {
      assert.notEqual(formatElapsed(age + wait), formatElapsed(age))
    }
  }
})

test('a state that is not a state draws nothing', () => {
  const page = harness()
  assert.equal(page.tray.update(null), 'malformed')
  assert.equal(page.tray.update('sessions'), 'malformed')
  assert.equal(page.built.length, 0)
  // A state object with no sessions array at all is still a state: it means
  // nothing is running, which is exactly what the idle line says.
  assert.equal(page.tray.update({}), 'rebuilt')
  assert.equal(page.last()[0].id, 'idle')
})
