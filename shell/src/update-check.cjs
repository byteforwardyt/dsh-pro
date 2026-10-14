'use strict'
/**
 * Update notifier — the light kind.
 *
 * The owner's brief: when a newer DMG is on the server, tell the user, and have
 * them get it from the site. No silent download, no auto-install, and almost
 * nothing added to the website — just one static file it already serves.
 *
 * So this fetches `https://dsh.bytefwd.com/version.json`, compares its version
 * to the running build, and when the server is newer, tells the renderer once.
 * A dismissed version is remembered so the same update never nags twice, and
 * every failure (offline, malformed file, slow network) is silent — an update
 * check that interrupts the app it is checking would be worse than no check.
 *
 * The fetch happens HERE, in the main process, on purpose: the renderer's CSP
 * allows only loopback origins, so a page fetch to the site would be blocked,
 * and widening that policy to reach the public internet is exactly what the
 * window's lockdown exists to prevent.
 */

const https = require('node:https')
const { BrowserWindow } = require('electron')

const FEED_URL = process.env.DSHD_UPDATE_FEED || 'https://dsh.bytefwd.com/version.json'
const SITE_URL = 'https://dsh.bytefwd.com/'

/** First check shortly after launch; then a few times a day. Never a tight loop. */
const FIRST_DELAY_MS = 12_000
const INTERVAL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

/**
 * Compare two dotted numeric versions. Returns >0 when `a` is newer than `b`.
 * Deliberately tiny and dependency-free: a build/pre-release suffix is ignored,
 * which is the right call for a "is the server ahead of me" check.
 */
function compareVersions (a, b) {
  const parse = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** GET a small JSON document, resolving null on any failure. Never throws. */
function fetchJson (url) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => { if (!settled) { settled = true; resolve(value) } }
    try {
      const req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return done(null) }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > 64_000) { req.destroy(); done(null) } // a version file is tiny
        })
        res.on('end', () => { try { done(JSON.parse(body)) } catch { done(null) } })
      })
      req.on('timeout', () => { req.destroy(); done(null) })
      req.on('error', () => done(null))
    } catch { done(null) }
  })
}

// The available update, once found, is held at MODULE scope rather than pushed
// once and forgotten. The renderer's banner subscribes AFTER React mounts, the
// harness frontend reloads during boot, and on macOS the window can be closed
// and reopened — a per-window closure lost the update across every one of those.
// Holding it here lets any window, at any time, receive the current update.
let pending = null
let checksStarted = false
let openExternalFn = () => {}

/**
 * The banner-injection script for one window. Injects CSS once, then a fixed
 * bar, and wires its button to the preload bridge
 * (window.__DSH_DESKTOP__.openUpdatePage) already present in the page.
 * Idempotent: it no-ops if the bar exists or this version was dismissed.
 */
function injectBanner (win) {
    if (!pending || !win || win.isDestroyed()) return
    const payload = JSON.stringify({ version: pending.version, notes: pending.notes || '' })
    const script = `(() => {
      try {
        var info = ${payload};
        var KEY = 'dshd.update.dismissed';
        try { if (localStorage.getItem(KEY) === info.version) return; } catch (e) {}
        if (document.getElementById('dshd-update-bar')) return;
        if (!document.getElementById('dshd-update-style')) {
          var st = document.createElement('style'); st.id = 'dshd-update-style';
          st.textContent = '#dshd-update-bar{position:fixed;top:0;left:0;right:0;z-index:2147483000;'
            + 'display:flex;align-items:center;gap:12px;padding:9px 16px;color:#fff;'
            + 'font:13px/20px -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;'
            + 'background:linear-gradient(90deg,#5b7cfa,#7c6cff);box-shadow:0 2px 14px rgba(0,0,0,.28)}'
            + '#dshd-update-bar .m{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
            + '#dshd-update-bar b{font-weight:600}'
            + '#dshd-update-bar button{flex:0 0 auto;cursor:pointer;border:none;border-radius:14px;height:28px;padding:0 14px;font:inherit;font-weight:600}'
            + '#dshd-update-bar .get{background:#fff;color:#3a2fb0}'
            + '#dshd-update-bar .x{background:transparent;color:#fff;opacity:.85;padding:0 8px;font-size:16px}';
          document.head.appendChild(st);
        }
        var bar = document.createElement('div'); bar.id = 'dshd-update-bar'; bar.setAttribute('role','status');
        var msg = document.createElement('span'); msg.className = 'm';
        var b = document.createElement('b'); b.textContent = 'DSH PRO ' + info.version + ' is available.';
        msg.appendChild(b);
        msg.appendChild(document.createTextNode(' ' + (info.notes || 'Get the latest from the site.')));
        var get = document.createElement('button'); get.className = 'get'; get.textContent = 'Get it';
        var remember = function(){ try { localStorage.setItem(KEY, info.version); } catch (e) {} };
        get.onclick = function(){ remember(); try { window.__DSH_DESKTOP__.openUpdatePage(); } catch (e) {} bar.remove(); };
        var x = document.createElement('button'); x.className = 'x'; x.setAttribute('aria-label','Dismiss'); x.textContent = '\u00d7';
        x.onclick = function(){ remember(); bar.remove(); };
        bar.appendChild(msg); bar.appendChild(get); bar.appendChild(x);
        document.body.appendChild(bar);
      } catch (e) {}
    })()`
    // Return a short status string (cloneable) so we can log whether it landed.
    win.webContents.executeJavaScript(script + ';(document.getElementById("dshd-update-bar")?"shown":(document.body?"nobar":"nobody"))')
      .catch(() => {})
}

/** Inject the current update into every open window (used when one is found). */
function injectIntoAllWindows () {
  for (const win of BrowserWindow.getAllWindows()) injectBanner(win)
}

/**
 * Start the update poll and register the "open the update page" IPC handler.
 * Idempotent: safe to call on every boot. Registering the handler more than
 * once threw "Attempted to register a second handler" and painted a false fatal
 * screen over a successfully restarted harness — so it happens exactly once.
 *
 * @param currentVersion - app.getVersion().
 * @param openExternal - opens a URL in the user's real browser.
 * @param ipcMain - Electron's ipcMain, for the "open the update page" action.
 */
function startUpdateChecks ({ currentVersion, openExternal, ipcMain, recordLog }) {
  openExternalFn = openExternal
  if (checksStarted) return
  checksStarted = true

  // A fixed URL, so this channel can never be steered somewhere else.
  ipcMain.handle('dsh:open-update-page', () => { openExternalFn(SITE_URL); return true })

  const check = async () => {
    const feed = await fetchJson(FEED_URL)
    const remote = feed && typeof feed.version === 'string' ? feed.version.trim() : null
    if (!remote) return
    if (compareVersions(remote, currentVersion) <= 0) return
    if (pending && pending.version === remote) return // already known
    pending = {
      version: remote,
      notes: typeof feed.notes === 'string' ? feed.notes.slice(0, 300) : '',
    }
    recordLog?.('out', `update available: ${remote} (running ${currentVersion})`)
    injectIntoAllWindows()
  }

  setTimeout(() => { void check() }, FIRST_DELAY_MS)
  setInterval(() => { void check() }, INTERVAL_MS)
}

/**
 * Attach the update banner to one window. Call for EVERY window created (boot
 * and reopen), so a close/reopen cycle on macOS does not silently lose update
 * banners for the rest of the run. Re-injects on each load, and once now if the
 * update is already known and the page has finished loading.
 */
function attachUpdateBanner (win) {
  if (!win || win.isDestroyed()) return
  win.webContents.on('did-finish-load', () => injectBanner(win))
  if (pending && !win.webContents.isLoadingMainFrame()) injectBanner(win)
}

module.exports = { startUpdateChecks, attachUpdateBanner, compareVersions }
