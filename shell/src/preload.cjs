'use strict'
/**
 * Preload bridge.
 *
 * Deliberately minimal. The renderer is the harness's own web UI, which talks to
 * the host over HTTP on the loopback origin — it needs nothing from Electron to
* function. Every capability added here becomes reachable by any script running
 * in that page. Choosing a workspace and reading credentials stay off this
 * bridge. Restarting the host and revealing the log exist only because the
 * fatal screen has no other way to recover, and the main process refuses those
 * two calls unless the sender is that screen.
 */

const { contextBridge, ipcRenderer } = require('electron')

/** Read one `--name=value` pair out of the arguments main handed this preload. */
function argValue (name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : ''
}

/**
 * The two legal-notice documents, addressed by name rather than by path.
 *
 * The renderer never names a file. It passes one of these two words, the main
 * process maps it to a fixed absolute path inside the app's own resources, and
 * anything else is refused there. That leaves no path for a compromised page to
 * point this at an arbitrary file — the usual failure of an "open this document"
 * bridge.
 */
const NOTICES = ['license', 'third-party']

contextBridge.exposeInMainWorld('__DSH_DESKTOP__', {
  /** Lets the web UI adapt chrome (e.g. hide "open in browser" affordances). */
  isDesktop: true,
  platform: process.platform,

  /**
   * Build identity, so a surface like About can state exactly which build this
   * is. Read-only and not sensitive.
   *
   * Delivered through additionalArguments rather than process.env, which does
   * not reliably reach a sandboxed renderer. Each value defaults to '' so a
   * missing argument renders as absent rather than as the string "undefined".
   */
  version: argValue('dshd-app-version'),
  electronVersion: argValue('dshd-electron-version'),
  arch: argValue('dshd-arch'),
  harnessVersion: argValue('dshd-harness-version'),

  /**
   * Open a bundled legal notice in the user's default viewer.
   *
   * Read-only and state-free: it shows a document that already ships inside the
   * bundle. It is here because the About panel has to be able to surface the
   * MIT and LGPL notices we are obliged to provide, and a page served over
   * http://127.0.0.1 cannot reach a file inside the .app on its own.
   *
   * @param which - 'license' or 'third-party'.
   * @returns true when the document opened.
   */
  openNotice: (which) => {
    if (!NOTICES.includes(which)) return Promise.resolve(false)
    return ipcRenderer.invoke('dsh:open-notice', which)
  },


  /** Open the download site so the user can get the update. Fixed URL. */
  openUpdatePage: () => ipcRenderer.invoke('dsh:open-update-page'),

  /**
   * Factory-reset the app. The renderer only ASKS: the main process owns the
   * native confirmation dialog, the wipe, and the relaunch — a page can invoke
   * the question, never the destruction. Resolves false on cancel.
   */
  resetApp: () => ipcRenderer.invoke('dsh:reset-app'),

  /**
   * Phone access. `op` is 'status' | 'enable' | 'disable'; the answer is
   * { enabled, url?, code?, error? }. The main process owns the proxy and its
   * pairing secret; this bridge only relays the user's Settings intent.
   */
  phoneAccess: (op) => ipcRenderer.invoke('dsh:phone-access', op),

  developmentSetup: (op, payload = {}) => ['check', 'status', 'install', 'cancel', 'open-installer'].includes(op)
    ? ipcRenderer.invoke('dsh:development-setup', op, payload)
    : Promise.resolve({error:'Unknown setup operation.'}),

  /** Status and native confirmations only. The renderer cannot run actions. */
  computerUse: (op) => ['status', 'enable', 'disable', 'permissions', 'screen-settings'].includes(op)
    ? ipcRenderer.invoke('dsh:computer-use', op)
    : Promise.resolve({ enabled: false, error: 'Unknown computer-use control.' }),

  /**
   * OS notifications, the Dock badge, and the click route back into a session.
   *
   * The page cannot post a notification itself and this does not change that:
   * main.cjs denies every renderer permission request, notifications included.
   * What crosses here is a KIND and a session id, never banner text - the
   * wording lives in the main process, because a session title is model-written
   * and a macOS banner floats over every other app on the machine.
   *
   * notify resolves a reason string ('posted', 'focused', 'repeat', ...), which
   * makes the ordinary declines legible instead of a bare false.
   */
  notify: (payload) => ipcRenderer.invoke('dsh:notify', payload),

  /** Sessions waiting on a person. The main process clamps and formats it. */
  setNotifyBadge: (count) => ipcRenderer.invoke('dsh:notify-badge', count),

  /**
   * Mirror the user's preference into the main process, so it can refuse an
   * "off" without a round trip. Not a boundary - the toggle is in this same
   * renderer - just one preference held in both halves.
   */
  setNotifyEnabled: (value) => ipcRenderer.invoke('dsh:notify-enabled', value),

  /**
   * Run a callback when a notification is clicked, with the session to open.
   *
   * The IpcRendererEvent is dropped rather than forwarded: it carries senders
   * and ports, and handing those to the page would widen this bridge from one
   * string to a live IPC handle.
   *
   * @returns a remover, so a caller can unsubscribe.
   */
  onOpenSession: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_event, id) => { if (typeof id === 'string' && id !== '') handler(id) }
    ipcRenderer.on('dsh:open-session', listener)
    return () => { ipcRenderer.removeListener('dsh:open-session', listener) }
  },
  /**
   * Tell the native menu which of its controls this page currently has.
   *
   * send rather than invoke: there is no answer worth waiting for, and this
   * fires on a DOM change, so a promise per call would be churn. The payload is
   * the page's own probe - booleans only, no text - and the main process treats
   * anything it does not recognise as "enabled", so a malformed one cannot
   * disable a keystroke.
   */
  publishMenuState: (state) => { ipcRenderer.send('dsh:menu-state', state) },

  /**
   * The live session list, for the menu-bar tray.
   *
   * send rather than invoke: there is no answer worth waiting for, and this
   * fires on every list mutation. Turning notifications off must not empty
   * the tray, so this is a separate channel from dsh:notify. The payload is
   * ids, titles, running/waiting flags and optional start times - never banner
   * text. Main sanitises the shape before it reaches the native menu.
   */
  publishSessions: (state) => { ipcRenderer.send('dsh:sessions-state', state) },

  /**
   * Restart the harness after a crash.
   *
   * Only the fatal screen may call this. The same preload is attached to the
   * harness page, so the main process refuses the call unless the sender is
   * file:.../error.html. A host-origin call is a no-op.
   */
  retryHarness: () => ipcRenderer.invoke('dsh:retry-harness'),

  /**
   * Open the on-disk host log. Same sender fence as retryHarness.
   */
  revealLogs: () => ipcRenderer.invoke('dsh:reveal-logs'),

})
