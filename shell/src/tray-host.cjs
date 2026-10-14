'use strict'
/**
 * Own the tray for the life of the app.
 *
 * tray.cjs is the policy: what a menu looks like, when it is worth rebuilding,
 * how a clock is written. This file is the host: it creates that tray, accepts
 * the untrusted payload the page sends, drives update() from both the session
 * list and a nextTickMs timer, and tears the icon down on quit.
 *
 * The timer exists because a running clock is a function of time, not of the
 * session list. A one-second interval would wake the process 3600 times an
 * hour to redraw nothing once the labels are minute-granular; nextTickMs
 * (shell/src/tray.cjs) returns the actual distance to the next label change.
 *
 * Tray, Menu and nativeImage are injected so the timer, the sanitiser and the
 * enablement path can be tested with no Electron and no display.
 */

const { createTray, nextTickMs } = require('./tray.cjs')

/** Hard cap on rows accepted from the page. tray.cjs draws eight; extras become "N more not shown". */
const FEED_CAP = 32

/**
 * Turn an IPC payload into the shape tray.cjs will draw, or null.
 *
 * The page is a loopback origin that fronts an agent, so this is not a trust
 * boundary so much as a shape boundary: a malformed list must not become a
 * throw inside Menu.buildFromTemplate, and a 10,000-row list must not become
 * a 10,000-row native menu. tray.cjs already drops idle rows and caps the
 * draw at eight; this cap is what keeps a confused publisher from handing it
 * thousands of them first.
 */
function sanitizeState (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const list = Array.isArray(raw.sessions) ? raw.sessions : []
  const sessions = []
  const seen = new Set()
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue
    const id = row.id
    if (typeof id !== 'string' || id === '' || id.length > 200) continue
    if (/[\u0000-\u001f]/.test(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const entry = {
      id: id,
      title: typeof row.title === 'string' ? row.title : '',
      running: row.running === true,
      waiting: row.waiting === true,
    }
    if (typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) && row.startedAt > 0) {
      entry.startedAt = row.startedAt
    }
    sessions.push(entry)
    if (sessions.length >= FEED_CAP) break
  }
  const waiting = Number.isFinite(raw.waiting)
    ? Math.max(0, Math.floor(raw.waiting))
    : sessions.filter((row) => row.waiting).length
  return { sessions: sessions, waiting: waiting }
}

function attachTray ({
  Tray, Menu, nativeImage, iconPath, symbolName = '',
  openApp, openSession, quit,
  productName = 'DSH PRO',
  now = Date.now,
  platform = process.platform,
  createTray: makeTray = createTray,
  nextTickMs: tickMs = nextTickMs,
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
} = {}) {
  const tray = makeTray({
    Tray, Menu, nativeImage, iconPath, symbolName,
    openApp, openSession, quit, productName, now, platform,
  })
  let last = { sessions: [], waiting: 0 }
  let timer = null

  function disarm () {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  function arm () {
    disarm()
    if (!tray.isEnabled()) return
    const wait = tickMs(last, now())
    timer = setTimer(function onTick () {
      timer = null
      tray.update(last)
      arm()
    }, wait)
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  }

  const api = {
    /**
     * Accept a payload from the page and draw it.
     *
     * Returns the tray.cjs reason string, or 'malformed' when the payload was
     * not an object. A malformed payload leaves the last good menu in place
     * rather than wiping it: one bad send must not blank a tray that was right.
     */
    ingest (state) {
      const next = sanitizeState(state)
      if (next === null) return 'malformed'
      last = next
      const result = tray.update(last)
      arm()
      return result
    },
    setEnabled (value) {
      // tray.setEnabled already redraws from its remembered state when turning
      // back on, so this only has to start or stop the clock.
      const enabled = tray.setEnabled(value)
      if (enabled) arm()
      else disarm()
      return enabled
    },
    isEnabled () { return tray.isEnabled() },
    destroy () {
      disarm()
      return tray.destroy()
    },
  }

  // Appear immediately, empty, so the icon exists before the page has published
  // anything. Without this the tray is created on the first ingest, which is
  // after the session list arrives, and a slow first pull looks like a missing icon.
  api.ingest({ sessions: [], waiting: 0 })
  return api
}

module.exports = {
  attachTray,
  sanitizeState,
  FEED_CAP,
}
