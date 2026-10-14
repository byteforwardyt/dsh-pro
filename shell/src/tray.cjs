'use strict'
/**
 * The menu bar tray.
 *
 * The app already tells you when something needs you (shell/src/notify.cjs),
 * but a notification is a moment: it fires once, and if you were in another
 * Space or your screen was asleep it is gone. The tray is the standing version
 * of the same answer. Pull it down at any time and it says what is running,
 * how long each thing has been running, and how many sessions are blocked on
 * you, with one click to the one you want.
 *
 * This module holds the policy and none of the platform. Tray, Menu and
 * nativeImage are injected, as are the three things a menu item can do - open
 * the window, open a session, quit - along with the clock and the platform
 * name. That is what lets the rebuild rule, the elapsed formatting, the row cap
 * and the teardown be tested with no Electron and no display.
 *
 * The one rule that matters most here is the rebuild rule. The caller is
 * expected to drive update() on every session-list change and on a timer, and
 * it only touches the native menu when the rendered result actually differs,
 * because on macOS calling setContextMenu while the menu is open closes it
 * under the user's cursor. A tray that rebuilds on every tick is a tray you
 * cannot click.
 */

const path = require('node:path')

// The character rule for untrusted text lives in one place. Session titles are
// model-written - the agent names the session from the work it was given, and
// that work can come from a web page - so the same stripping that keeps a
// notification body honest keeps a menu row honest. Requiring it rather than
// copying it means the rule cannot drift between the two surfaces.
const { cleanTitle } = require('./notify.cjs')

/**
 * How many session rows the menu will draw.
 *
 * A menu bar menu drops down from the top of the screen and macOS turns it into
 * a scrolling strip when it does not fit, which is worse to use than a
 * truncation we chose ourselves. Eight rows plus the waiting header, the
 * overflow line, a separator and the two commands is thirteen items. Estimated,
 * not measured: at the 22pt standard item height and a separator worth about
 * half of one, that is roughly 280pt, which leaves room on the shortest display
 * this is likely to meet. The cap is also a containment boundary, and that part
 * is not an estimate: the session list is driven by an agent that can create
 * sessions, so the number of rows must not be its decision.
 */
const MAX_ROWS = 8

/**
 * How wide a session title may be in a row.
 *
 * macOS sizes a menu to its widest item, so one long title stretches every row.
 * notify.cjs allows 80 characters because a banner body wraps to two lines; a
 * menu row does not wrap, and 44 characters is about as wide as this menu can
 * get before it stops looking like a menu and starts looking like a window.
 */
const ROW_TITLE_LIMIT = 44

/** What a row says when a session has a title but nothing legible survives it. */
const UNTITLED = 'Untitled session'

/** Middle dot, the separator used across this app's own strings. */
const DOT = ' \u00b7 '

/**
 * A macOS template image is a black-and-alpha stencil that the system recolours
 * for the light or dark menu bar. It is opt-in per image, and we opt in by
 * FILE NAME - the ...Template.png convention Apple uses for these assets -
 * rather than by platform, because flagging an ordinary coloured icon as a
 * template throws its colour away and paints its silhouette.
 *
 * That is not hypothetical here. Measured on the icons this repo actually has:
 * build/icons/16x16.png is, of its 256 pixels, 216 fully opaque, 28 partially
 * transparent and only 12 fully transparent - a filled rounded square with
 * antialiased corners. As a template image it would draw a solid black block in
 * the menu bar. Naming is therefore the signal, and an asset that has not been
 * drawn for this job cannot accidentally opt in.
 */
const TEMPLATE_NAME = /Template(@[0-9]+x)?\.png$/i

/**
 * Format an elapsed duration for a menu row.
 *
 * Two decisions, both about how the label BEHAVES over time rather than how
 * accurate it is:
 *
 * Rounding is to the nearest second with a floor of one, so a session that has
 * just started reads "1s" immediately. Truncating would show "0s" for the first
 * second of every run, which reads like a stopped clock at the exact moment the
 * user is looking to see that something started.
 *
 * Granularity is capped as the duration grows: seconds below a minute, whole
 * minutes below an hour, hours and minutes below a day, then days and hours.
 * The label is the input to the rebuild check, so its granularity IS the
 * rebuild rate. A run that has been going an hour would otherwise rewrite the
 * native menu once a second to change a digit nobody is reading.
 *
 * Returns '' for anything that is not a finite duration, and the caller drops
 * the clock from the row rather than printing a placeholder.
 */
function formatElapsed (ms) {
  if (!Number.isFinite(ms)) return ''
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm'
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes === 0 ? hours + 'h' : hours + 'h ' + restMinutes + 'm'
  const days = Math.floor(hours / 24)
  // Past three years this is not a duration, it is a bad number, and the two
  // ways to get one are both real: a start time recorded in seconds against a
  // millisecond clock reads as decades, and an absurd one turns the label into
  // scientific notation - measured, formatElapsed(1e300) produced the
  // 24-character "1.1574074074074075e+292d", which is a 28-character row from a
  // one-character title. Refusing beats clamping. A clamped "999d+" is a
  // plausible-looking label that hides the unit mismatch behind it, where no
  // clock at all leaves the row saying "running", which is the one thing we
  // actually know.
  if (days > 999) return ''
  const restHours = hours % 24
  return restHours === 0 ? days + 'd' : days + 'd ' + restHours + 'h'
}

/**
 * Never sleep longer than this between ticks.
 *
 * Past the first minute no label moves more often than once a minute, so
 * sleeping longer could only make a clock late, and a ceiling means a machine
 * that wakes from sleep with a stale menu corrects itself within a minute
 * whatever else happens. It also bounds the search below to 61 steps.
 */
const MAX_TICK = 60000

/**
 * Never sleep less than this.
 *
 * The next label change can be a few milliseconds away when a tick lands just
 * before a rounding boundary. Without a floor that becomes a busy loop for the
 * rest of the second.
 */
const MIN_TICK = 250

/**
 * How long until this elapsed duration would print differently.
 *
 * Searches forward in whole seconds from the next rounding boundary rather than
 * deriving it from the branches in formatElapsed, because the two would then
 * have to be kept in step by hand and a drift between them is silent: the clock
 * simply stops updating at whatever threshold the copy got wrong. The search is
 * bounded by the caller's limit, so it is at most 61 comparisons.
 */
function nextLabelChange (elapsed, limit) {
  const current = formatElapsed(elapsed)
  // round() flips at k*1000+500, so that is where the label can first move.
  const first = Math.round(elapsed / 1000) * 1000 + 500 - elapsed
  for (let ahead = first > 0 ? first : 1000; ahead <= limit; ahead += 1000) {
    if (formatElapsed(elapsed + ahead) !== current) return ahead
  }
  return limit
}

/**
 * How long the caller should wait before calling update() again.
 *
 * The tray has to poll, because the elapsed clocks move with the wall clock and
 * nothing publishes a change for that. A fixed one-second timer would work and
 * is what this would otherwise be, but it wakes the process 3600 times an hour
 * to redraw nothing: past the first minute the labels are minute-granular, and
 * update() would answer 'unchanged' to 59 of every 60 calls. So the schedule is
 * derived from the labels themselves - a second while something is young enough
 * to be counted in seconds, a minute once everything on screen has aged past
 * that, and the exact distance to the boundary in between.
 *
 * Session-list changes do not depend on this at all; they arrive on their own
 * and call update() directly.
 */
function nextTickMs (state, at) {
  let soonest = MAX_TICK
  // Only the rows that are actually drawn. A ninth session is not on screen, so
  // its clock cannot be the reason to wake up and redraw.
  const drawn = selectRows(state === null || typeof state !== 'object' ? [] : state.sessions).slice(0, MAX_ROWS)
  for (const row of drawn) {
    // A waiting row prints no clock, and a row with no start time prints none
    // either, so neither of them can change with time.
    if (row.waiting || !Number.isFinite(row.startedAt)) continue
    soonest = Math.min(soonest, nextLabelChange(at - row.startedAt, MAX_TICK))
  }
  return Math.max(MIN_TICK, Math.min(MAX_TICK, soonest))
}

/**
 * A session title, safe and short enough for a menu row.
 *
 * cleanTitle does the part that is about safety and is shared with the
 * notification body; this only narrows the result to the menu's width. The
 * fallback is a fixed string rather than the session id, because an id in a
 * menu tells the reader nothing and looks like a bug.
 */
function rowTitle (value) {
  const clean = cleanTitle(value)
  if (clean === '') return UNTITLED
  // Applied to both exits. cleanTitle cuts at its own limit, so a title short
  // enough to skip ours can still arrive with a lone surrogate already on the
  // end, and returning it untouched would render the box this is here to stop.
  if (clean.length <= ROW_TITLE_LIMIT) return dropLoneSurrogate(clean)
  let cut = dropLoneSurrogate(clean.slice(0, ROW_TITLE_LIMIT - 1))
  // Both limits count UTF-16 units, so a cut can land between the halves of an
  // astral character - an emoji, or most of CJK extension B - and leave a lone
  // high surrogate that renders as a replacement box. Drop it. cleanTitle has
  // the same seam at its own limit; this only closes the one that is ours.
  const tailCode = cut.charCodeAt(cut.length - 1)
 if (tailCode >= 0xd800 && tailCode <= 0xdbff) cut = cut.slice(0, -1)
  return cut + '\u2026'
}

/**
 * Remove a trailing unpaired high surrogate.
 *
 * Every length here counts UTF-16 units, so a cut can land between the halves
 * of an astral character - an emoji, or most of CJK extension B - and leave a
 * high surrogate with nothing after it, which renders as a replacement box.
 */
function dropLoneSurrogate (text) {
  const tail = text.charCodeAt(text.length - 1)
  return tail >= 0xd800 && tail <= 0xdbff ? text.slice(0, -1) : text
}

/**
 * Pick and order the sessions that get a row.
 *
 * Sessions blocked on a person come first, keeping their order among
 * themselves. That is a stable partition of the order we were handed, so a row
 * only moves when a session actually changes state - sorting by elapsed time
 * instead would shuffle the rows under the cursor on every tick, which is the
 * same failure the rebuild rule exists to prevent.
 *
 * A session with no usable id is dropped: its row could not open anything, and
 * a menu item that does nothing when clicked is worse than an absent one. So is
 * a repeat of an id already taken: two rows that open the same session are one
 * row and one lie, and the id is also what Electron uses to address a menu
 * item, which duplicates would make ambiguous.
 */
function selectRows (sessions) {
  const usable = []
  const seen = new Set()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session === null || typeof session !== 'object') continue
    const id = session.id
    // The same shape notify.cjs requires of a session id (notify.cjs:137-140),
    // so the two surfaces cannot disagree about which sessions are addressable.
    if (typeof id !== 'string' || id === '' || id.length > 200) continue
    if (/[\u0000-\u001f]/.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const waiting = session.waiting === true
    const running = session.running === true
    if (!waiting && !running) continue
    usable.push({ id: id, title: session.title, waiting: waiting, running: running, startedAt: session.startedAt })
  }
  return usable.filter((row) => row.waiting).concat(usable.filter((row) => !row.waiting))
}

/**
 * Escape a label so nothing in it is read as markup.
 *
 * On Windows and Linux a single & marks the next character as a mnemonic: the &
 * itself is not displayed and the character after it is underlined and given an
 * Alt accelerator. Doubling it is the documented escape - "In order to escape
 * the & character in an item name, add a preceding &. For example, &&File would
 * result in &File displayed on the button label"
 * (shell/node_modules/electron/electron.d.ts:9529-9536). A session title is
 * model-written, so without this a title can hide a character from its own row
 * and claim a keystroke inside our menu.
 *
 * The honest limit of that citation: it is written about the top-level items of
 * setApplicationMenu, not about a tray's context menu, and this app is
 * developed on macOS where the behaviour does not occur, so it could not be
 * measured here. Escaping is the safe side of that uncertainty - on macOS the
 * rule is off entirely, so the cost of being wrong is zero.
 */
function escapeMnemonics (text, platform) {
  return platform === 'darwin' ? text : text.replace(/&/g, '&&')
}

/**
 * Build the menu as plain data.
 *
 * Returned as a template rather than a Menu so the shape can be asserted
 * directly, and so update() can compare two renders without asking Electron to
 * build either of them.
 */
function buildTemplate (state, {
  now, openApp, openSession, quit, productName = 'DSH PRO', platform = process.platform,
}) {
  const safe = state === null || typeof state !== 'object' ? {} : state
  const rows = selectRows(safe.sessions)
  const waiting = Number.isFinite(safe.waiting)
    ? Math.max(0, Math.floor(safe.waiting))
    : rows.filter((row) => row.waiting).length
  // One instant for the whole render. Called per row it would measure eight
  // rows against eight different clocks, and the rebuild rule assumes a render
  // is a function of one timestamp.
  const at = now()
  const items = []

  // The count is a statement, not a destination - the rows below it are how you
  // get somewhere - so it is a disabled line rather than a clickable one.
  if (waiting > 0) {
    items.push({
      id: 'waiting',
      label: waiting === 1 ? '1 session waiting for you' : waiting + ' sessions waiting for you',
      enabled: false,
    })
  }

  for (const row of rows.slice(0, MAX_ROWS)) {
    // A session that is waiting has stopped working, so its elapsed clock would
    // be counting something that is not happening. It says what it is doing
    // instead. A running session with no usable start time gets the same
    // treatment for the same reason.
    //
    // Every row gets a tail, and that is deliberate beyond tidiness: it is what
    // stops a session titled "Quit DSH PRO" from rendering a row identical to
    // the command underneath it.
    const clock = row.waiting ? '' : formatElapsed(at - toStart(row.startedAt))
    const tail = clock === '' ? (row.waiting ? 'waiting' : 'running') : clock
    items.push({
      id: 'session:' + row.id,
      label: escapeMnemonics(rowTitle(row.title), platform) + DOT + tail,
      click: () => guard(() => openSession(row.id)),
    })
  }

  const hidden = rows.length - Math.min(rows.length, MAX_ROWS)
  if (hidden > 0) {
    items.push({ id: 'overflow', label: hidden + ' more not shown', enabled: false })
  }

  // An empty menu reads as a broken tray. One honest line reads as an answer,
  // and it is the answer someone opening this menu is usually looking for.
  if (items.length === 0) {
    items.push({ id: 'idle', label: 'No sessions running', enabled: false })
  }

  items.push({ type: 'separator' })
  // Coerced here rather than inside escapeMnemonics. Blanking a bad value is
  // right for a title, which has a fallback, and wrong for the two labels a
  // person has to be able to find: "Open " with nothing after it is worse than
  // "Open 42".
  const name = escapeMnemonics(typeof productName === 'string' ? productName : String(productName), platform)
  items.push({ id: 'open', label: 'Open ' + name, click: () => guard(openApp) })
  items.push({ id: 'quit', label: 'Quit ' + name, click: () => guard(quit) })
  return items
}

/**
 * Run a menu click without letting it reach Electron.
 *
 * Electron dispatches these callbacks itself, so a throw from one is an
 * uncaught exception in the main process - the error dialog, or worse. What the
 * caller does about its own failure is the caller's business; the menu's job is
 * to not become the thing that crashes the app.
 */
function guard (action) {
  try { action() } catch { /* the caller's problem, not the menu's */ }
}

/**
 * A start time we can subtract, or NaN so formatElapsed drops the clock.
 *
 * Zero is not a start time. It is what an unset field reads as, and it is
 * finite, so without this test a session that never recorded one renders a
 * clock counting from 1970.
 */
function toStart (value) {
  return Number.isFinite(value) && value > 0 ? value : NaN
}

/** What the tray says on hover: the same priority the menu itself uses. */
function buildTooltip (state, productName = 'DSH PRO') {
  const safe = state === null || typeof state !== 'object' ? {} : state
  const rows = selectRows(safe.sessions)
  const waiting = Number.isFinite(safe.waiting)
    ? Math.max(0, Math.floor(safe.waiting))
    : rows.filter((row) => row.waiting).length
  if (waiting > 0) return productName + DOT + waiting + ' waiting for you'
  const running = rows.filter((row) => row.running).length
  if (running > 0) return productName + DOT + running + (running === 1 ? ' session running' : ' sessions running')
  return productName
}

/**
 * Everything about a render that the user can see, as one comparable string.
 *
 * Derived from the template rather than taken from object identity, because a
 * fresh template is built on every update and would never compare equal. The id
 * is in the signature as well as the label so that two sessions that happen to
 * render the same text still rebuild when the row's target changes.
 */
function signature (items, tooltip) {
  // JSON rather than a joined string with a delimiter. Half of what goes in
  // here is a session title, which is model-written, and any delimiter simple
  // enough to read is one a title can contain: a crafted title could then make
  // two different menus produce one signature, and the tray would sit on a
  // stale menu for as long as that title held. JSON escapes its own separators,
  // so no value can be mistaken for the structure around it.
  return JSON.stringify([
    items.map((item) => (item.type === 'separator'
      ? null
      : [item.id, item.label, item.enabled !== false])),
    tooltip,
  ])
}

/**
 * The tray.
 *
 * Every native edge is a parameter: the Tray and Menu constructors, nativeImage
 * for loading the icon, the path of that icon, what Open and Quit and a session
 * row do, the clock the elapsed labels are measured against, and the platform
 * name - which is used for exactly one thing, the mnemonic rule above.
 *
 * The icon has no default on purpose. This repo ships no monochrome template
 * asset today - measured: build/icons/16x16.png, the only 16pt art there is,
 * has 216 of its 256 pixels fully opaque - and inventing one in code would put
 * a hand-rolled bitmap in the menu bar. Two ways in are offered instead, tried
 * in this order, and when neither makes an image the tray declines to exist:
 *
 *   iconPath   a file. Named ...Template.png it is flagged as a template image
 *              and macOS recolours it for the light and dark menu bars.
 *   symbolName an SF Symbol, drawn by the system at the menu bar's own weight
 *              and colour. nativeImage.createMenuSymbol exists in the Electron
 *              this app pins (43.4.1) and is documented as being "for use in a
 *              native Menu" (shell/node_modules/electron/electron.d.ts:9894).
 *              macOS only, so the guard below is the isEmpty check every other
 *              platform will fail.
 */
function createTray ({
  Tray, Menu, nativeImage, iconPath, symbolName = '', openApp, openSession, quit,
  productName = 'DSH PRO', now = Date.now, platform = process.platform,
}) {
  let tray = null
  let shown = ''
  let enabled = true
  let last = null
  // A construction failure is environmental - no status area, or an image the
  // platform refused - and it does not become true later. Retrying on every
  // update would spend a native call a second for the life of the app to keep
  // getting the same answer.
  let failed = false

  /**
   * Reject anything that is not a usable image.
   *
   * createFromPath answers a missing or unreadable file with an EMPTY image
   * rather than an error - "returns an empty image if the path does not exist,
   * cannot be read, or is not a valid image"
   * (shell/node_modules/electron/electron.d.ts:9888) - and createMenuSymbol
   * has nothing to draw off macOS. So isEmpty, not a thrown error, is the real
   * does-this-exist check. A Tray built on an empty image is a zero-width gap
   * in the menu bar: it takes a slot, shows nothing, and cannot be clicked.
   */
  function usable (image) {
    if (image === null || typeof image !== 'object') return null
    if (typeof image.isEmpty === 'function' && image.isEmpty()) return null
    return image
  }

  /** The icon, or null when there is nothing worth putting in the menu bar. */
  function loadIcon () {
    if (typeof iconPath === 'string' && iconPath !== '') {
      let image = null
      try { image = usable(nativeImage.createFromPath(iconPath)) } catch { image = null }
      if (image !== null) {
        // Flagged by FILE NAME, never by platform. A coloured icon marked as a
        // template loses its colour and paints as its silhouette, which for the
        // filled square this repo currently ships is a black block.
        if (TEMPLATE_NAME.test(path.basename(iconPath)) && typeof image.setTemplateImage === 'function') {
          try { image.setTemplateImage(true) } catch { /* not macOS, or an image that cannot be one */ }
        }
        return image
      }
    }
    if (typeof symbolName === 'string' && symbolName !== '' && typeof nativeImage.createMenuSymbol === 'function') {
      // A symbol is already drawn to match the menu bar, so it is not marked as
      // a template: doing that to art the system is already styling is how you
      // get a flat black glyph instead of the one it would have drawn.
      try { return usable(nativeImage.createMenuSymbol(symbolName)) } catch { return null }
    }
    return null
  }

  /** True when there is a live tray to draw into. */
  function ensureTray () {
    if (tray !== null) return true
    if (failed) return false
    const image = loadIcon()
    if (image === null) { failed = true; return false }
    try {
      tray = new Tray(image)
    } catch {
      failed = true
      tray = null
      return false
    }
    // A best-effort extra, not a route anything depends on. What the platforms
    // actually promise, from the file itself: on macOS the neighbouring
    // mouse-up "will not be emitted if you have set a context menu for your
    // Tray using tray.setContextMenu, as a result of macOS-level constraints"
    // (shell/node_modules/electron/electron.d.ts:15346), and click on Linux "is
    // emitted when the tray icon receives an activation, which might not
    // necessarily be left mouse click" (:14869-14872) - which under
    // StatusNotifierItem may be the same gesture that opens the menu, or may
    // never arrive at all. So this handler may be dead, may double up with the
    // menu opening, or may be the only thing that works, depending on the desk.
    // Each of those is fine because Open is in the menu regardless; what would
    // not be fine is the menu depending on it.
    try { tray.on('click', () => guard(openApp)) } catch { /* platform without the event */ }
    return true
  }

  const api = {
    /**
     * Draw the current state, or say why nothing was drawn.
     *
     * Returns a reason string for the same reason notify.cjs does: most of the
     * ways this declines are the feature working, and 'unchanged' in particular
     * is the common case - it is what keeps an open menu open.
     */
    update (state) {
      if (state === null || typeof state !== 'object') return 'malformed'
      // Remembered even while disabled, so switching the tray back on shows the
      // truth immediately instead of an empty menu until the next change.
      last = state
      if (!enabled) return 'disabled'
      const items = buildTemplate(state, { now, openApp, openSession, quit, productName, platform })
      const tooltip = buildTooltip(state, productName)
      const next = signature(items, tooltip)
      if (tray !== null && next === shown) return 'unchanged'
      // Nothing below is worth doing for a tray that has already been refused.
      // Building the menu first is what keeps a live tray safe from a bad
      // template, but ahead of the latch it would also build and discard a menu
      // on every tick for the rest of the run.
      if (tray === null && failed) return 'unavailable'
      // Built before the tray is touched, and outside the tray's catch. A
      // template that will not build is our bug, and tearing down a healthy
      // icon because of it would turn a bad label into a disappearing tray.
      let menu = null
      try {
        menu = Menu.buildFromTemplate(items)
      } catch {
        return 'unrenderable'
      }
      const fresh = tray === null
      if (!ensureTray()) return 'unavailable'
      try {
        tray.setContextMenu(menu)
      } catch {
        // The tray went away underneath us - a destroyed handle, or a platform
        // that lost its status area. Let go of it and let the next update build
        // a fresh one. Destroyed first, because the reason for the throw might
        // not be the handle at all, and simply dropping a LIVE one would leave
        // an icon in the menu bar that nothing owns and a second one beside it
        // on the next update.
        //
        // A tray created moments ago that cannot be drawn into is not a stale
        // handle, it is a platform saying no, and without this latch the icon
        // would appear and vanish once per tick for the life of the app.
        if (fresh) failed = true
        api.destroy()
        return 'unavailable'
      }
      // Outside the fatal path on purpose: a tooltip is a hover nicety, and
      // losing one is not a reason to take the menu down with it.
      try {
        if (typeof tray.setToolTip === 'function') tray.setToolTip(tooltip)
      } catch { /* cosmetic */ }
      shown = next
      return 'rebuilt'
    },

    /**
     * Whether the user wants a tray at all.
     *
     * Off tears the icon down rather than emptying it, because an icon that is
     * present and says nothing is a worse answer to "turn it off" than no icon.
     */
    setEnabled (value) {
      const next = value !== false
      if (next === enabled) return enabled
      enabled = next
      if (!enabled) {
        api.destroy()
        return enabled
      }
      // Turning it back on is a deliberate act, and a fair reason to try the
      // native call once more even if it failed before.
      failed = false
      if (last !== null) api.update(last)
      return enabled
    },

    isEnabled () { return enabled },

    /**
     * Remove the icon. Safe to call twice, and safe to call on a tray that was
     * never created: the handle is cleared before it is destroyed, so a second
     * call has nothing to find and a throwing destroy cannot leave a dead
     * handle in place.
     */
    destroy () {
      shown = ''
      if (tray === null) return false
      const doomed = tray
      tray = null
      // Two try blocks, not one. With both in the same block a throwing
      // isDestroyed skips the destroy entirely, which reports success while
      // leaving a live icon in the menu bar that nothing holds a handle to.
      let dead = false
      try {
        dead = typeof doomed.isDestroyed === 'function' && doomed.isDestroyed()
      } catch { dead = false }
      if (dead) return false
      try { doomed.destroy() } catch { /* already gone */ }
      return true
    },
  }
  return api
}

module.exports = {
  createTray,
  buildTemplate,
  buildTooltip,
  formatElapsed,
  nextTickMs,
  rowTitle,
  selectRows,
  signature,
  MAX_ROWS,
  MAX_TICK,
  MIN_TICK,
  ROW_TITLE_LIMIT,
  UNTITLED,
}
