'use strict'
/**
 * Application menu.
 *
 * Electron's default menu is fine but titles the app "Electron" in development
 * and carries browser-ish items (Reload, Force Reload) that invite a user to
 * reload a page that is really an application. This trims it and names it.
 */

const { app, Menu, BrowserWindow } = require('electron')

const YOUTUBE_CHANNEL = 'https://www.youtube.com/channel/UCGGHPOAzUaKsSc2yjsOeAFQ?sub_confirmation=1'

/**
 * The conversation views, in header order, by stable slot id.
 *
 * Ids rather than labels, because the labels the header draws are translated at
 * render time and matching one locale's output left Cmd+1 and Cmd+2 dead
 * everywhere else. VIEW_LABELS below is only what this menu prints; the
 * accelerator each view gets is its index here, assigned in the View submenu.
 *
 * Duplicated from VIEWS in plugins/client-ui-brand/lib/client.js, which cannot
 * be imported here: that file is a browser module loaded by the harness's own
 * module loader, and this is CJS in the Electron main process.
 * scripts/test/menu-views.test.cjs asserts the copies agree, because a drift
 * shows up as a menu item and a keystroke that silently do nothing.
 */
const VIEWS = ['chat', 'trajectory', 'preview', 'files']
/**
 * Menu item ids for the items whose usefulness depends on what the page shows.
 *
 * Ids exist so the enablement pass can find an item without walking labels,
 * which are the one thing in this menu that could reasonably be translated
 * later. VIEW_ITEM_ID is derived from the same VIEWS list the accelerators come
 * from, so a view added in one place cannot be missed by the other.
 */
const VIEW_ITEM_ID = (id) => 'dshd.view.' + id

/**
 * Which field of the page's probe decides each non-view item.
 *
 * The probe is window.__DSHD_ACTIONS__.probe() in
 * plugins/client-ui-brand/lib/client.js - the same function each action uses to
 * find its control, so an item is greyed out exactly when its action would have
 * found nothing.
 */
const ITEM_PROBE_FIELD = {
  'dshd.newSession': 'newSession',
  'dshd.settings': 'settings',
  'dshd.sidebar': 'sidebar',
  'dshd.sessionLog': 'sessionLog',
  'dshd.composer': 'composer',
  'dshd.terminal': 'terminal',
}

/**
 * What the menu prints for each view.
 *
 * English, like every other item in this menu — Electron's own roles and the
 * File/Edit/View titles are English too, so a half-translated menu bar would be
 * worse than a consistent one. The page's tabs stay in the user's language.
 */
const VIEW_LABELS = {
  chat: 'Code',
  trajectory: 'Trajectory',
  preview: 'Preview',
  files: 'Files',
}

/**
 * Invoke one of the client's own app-level actions.
 *
 * The menu lives in the main process; the window belongs to the harness's web
 * UI, and there is no IPC into it. Our brand plugin publishes
 * window.__DSHD_ACTIONS__ for exactly this, so the DOM knowledge stays in the
 * client and the menu only names an intent.
 *
 * Best-effort by design: a missing action or a renamed upstream control makes
 * the menu item a no-op rather than an error dialog.
 *
 * The action name and argument are serialised rather than pasted into a
 * property path. Nothing hostile reaches this today - every caller is a literal
 * below - but a name interpolated raw into executeJavaScript is a footgun one
 * refactor away from being reachable, and quoting costs nothing.
 */
function runAction (name, argument) {
  // Matches how main.cjs picks a window: a destroyed window at index 0 must not
  // stand in for a live one behind it.
  const focused = BrowserWindow.getFocusedWindow()
  const win = focused && !focused.isDestroyed()
    ? focused
    : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!win) return Promise.resolve(false)
  try {
    // Inside the try because JSON.stringify throws on a BigInt or a cycle, and
    // it used to throw from here into Electron's click dispatch as an uncaught
    // main-process exception - the error dialog the comment above promises
    // never to raise.
    const call = argument === undefined ? '' : JSON.stringify(argument)
    return win.webContents
      .executeJavaScript(`(() => {
      const actions = window.__DSHD_ACTIONS__
      const action = actions && actions[${JSON.stringify(name)}]
      return Boolean(typeof action === 'function' && action(${call}))
    })()`)
      .catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

function buildMenu ({ productName, onOpenExternal, onRevealDiagnostics }) {
  if (typeof onOpenExternal !== 'function') {
    // Every outbound URL goes through the caller's allowlist — a silent
    // shell.openExternal fallback here would be an allowlist bypass waiting for
    // a refactor to reach it.
    throw new TypeError('buildMenu requires onOpenExternal')
  }
  if (typeof onRevealDiagnostics !== 'function') throw new TypeError('buildMenu requires onRevealDiagnostics')
  const open = (url) => () => onOpenExternal(url)

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: productName,
      submenu: [
        { role: 'about', label: `About ${productName}` },
        { type: 'separator' },
        // Cmd+, is muscle memory on macOS. Without it the only way into
        // Settings is a control at the very bottom of the sidebar.
        {
          id: 'dshd.settings',
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => void runAction('openSettings'),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${productName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${productName}` },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          id: 'dshd.newSession',
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: () => void runAction('newSession'),
        },
        { type: 'separator' },
        // macOS only. role:'close' rather than a click handler, because it
        // closes the focused window - which on macOS is not the same as
        // quitting - and stays correct for a window this menu has never heard
        // of. Off macOS, role:'windowMenu' below already contributes a Close on
        // the same Ctrl+W, and two items sharing a keystroke is a menu bug the
        // accelerator test cannot see, since roles carry no accelerator string.
        ...(process.platform === 'darwin' ? [{ role: 'close', label: 'Close Window' }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        // The items below grey out in states where they would do nothing: the
        // home screen renders no view tabs, no sidebar toggle and no Session
        // log, and Files and Terminal have no message field.
        //
        // This was deliberately NOT done until 0.1.29 because sampling was the
        // only option and sampling is wrong here: menu-will-show does not fire
        // at all when the user takes the keystroke instead of opening the menu,
        // so a stale disabled item would kill a keystroke that should have
        // worked. The page now PUSHES its probe over the desktop bridge
        // (preload publishMenuState), so the state is never sampled and never
        // stale by more than one DOM change.
        //
        // The default is enabled, everywhere: applyMenuState only ever disables
        // on an explicit false, and the main process resets the whole menu to
        // enabled when the page goes away. A renderer that dies, or a plugin
        // that fails to load, therefore degrades to exactly the old behaviour -
        // a live item that finds nothing - rather than to a dead menu bar.
        // The view ring, in the order the header draws it. Switching view was
        // previously mouse-only: five controls in the top right corner, used
        // dozens of times an hour, with no keyboard route at all.
        ...VIEWS.map((id, index) => ({
          id: VIEW_ITEM_ID(id),
          label: VIEW_LABELS[id],
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: () => void runAction('selectView', id),
        })),
        {
          id: 'dshd.terminal',
          label: 'Toggle Bottom Terminal',
          accelerator: 'CmdOrCtrl+5',
          click: () => void runAction('toggleTerminal'),
        },
        { type: 'separator' },
        {
          id: 'dshd.sidebar',
          label: 'Toggle Sidebar',
          // Cmd+B is the sidebar toggle a user arrives with from every editor
          // they already use, and nothing in this app claims it for bold.
          accelerator: 'CmdOrCtrl+B',
          click: () => void runAction('toggleSidebar'),
        },
        {
          id: 'dshd.sessionLog',
          label: 'Session Actions',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => void runAction('openSessionLog'),
        },
        {
          id: 'dshd.composer',
          label: 'Focus Message Field',
          // Not Cmd/Ctrl+L. A menu accelerator is handled before the page sees
          // the key, and on the Linux target (shell/package.json declares one)
          // CmdOrCtrl resolves to Ctrl, which the terminal view binds to clear
          // the screen (plugins/terminal/lib/client.js:629). Cmd+L is also the
          // browser reflex for the address bar, and the Preview view has one.
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => void runAction('focusComposer'),
        },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
      ],
    },
    // role:'windowMenu' rather than a hand-rolled list: it carries the standard
    // behaviour a Mac user expects, including Bring All to Front and the live
    // window list, which a literal submenu silently omits.
    { role: 'windowMenu' },
    {
      role: 'help',
      // Support first, promotion last. Help is where someone goes when
      // something is wrong; leading with a subscribe link reads as a pitch at
      // the exact moment the user wants an answer.
      submenu: [
        { label: 'Open Last 24 Hours of Diagnostics…', click: () => void onRevealDiagnostics() },
        { type: 'separator' },
        { label: 'DSH PRO source', click: open('https://github.com/byteforwardyt/dsh-pro') },
        { label: 'DeepSeek Harness on GitHub', click: open('https://github.com/deepseek-ai/deepseek-harness') },
        { type: 'separator' },
        { label: 'Subscribe to Byte Forward on YouTube', click: open(YOUTUBE_CHANNEL) },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Grey out the items the page cannot currently serve.
 *
 * Flips `enabled` on the existing items rather than rebuilding the menu:
 * rebuilding drops an open menu on macOS and would rediscover every role, and
 * this runs on a DOM change.
 *
 * ABSENCE MEANS ENABLED. A missing probe, a malformed one, a field this build
 * has never heard of - all leave the item alone. Only an explicit `false`
 * disables, because the cost of the two mistakes is not symmetric: a live item
 * that finds nothing does nothing, while a wrongly disabled item swallows the
 * accelerator and the keystroke is simply lost.
 *
 * @param probe - window.__DSHD_ACTIONS__.probe() output, or null to re-enable.
 * @param menu - the menu to act on; omit for the application menu.
 * @returns how many items changed, so a caller can log a no-op as a no-op.
 */
function applyMenuState (probe, menu) {
  // Not a default parameter: passing undefined explicitly would evaluate it,
  // and Menu is undefined whenever this module is loaded outside Electron -
  // which shell/test/menu-enablement.test.js does, because requiring 'electron'
  // in a plain node process resolves to the binary path, not the API.
  const target = menu === undefined ? currentMenu() : menu
  if (target === null || target === undefined || typeof target.getMenuItemById !== 'function') return 0
  const known = probe !== null && typeof probe === 'object'
  const views = known && probe.views !== null && typeof probe.views === 'object' ? probe.views : {}
  const wanted = new Map()
  for (const id of VIEWS) wanted.set(VIEW_ITEM_ID(id), !known || views[id] !== false)
  for (const [itemId, field] of Object.entries(ITEM_PROBE_FIELD)) {
    wanted.set(itemId, !known || probe[field] !== false)
  }
  let changed = 0
  for (const [itemId, enabled] of wanted) {
    const item = target.getMenuItemById(itemId)
    if (item === null || item === undefined || item.enabled === enabled) continue
    item.enabled = enabled
    changed += 1
  }
  return changed
}

/**
 * Re-enable everything.
 *
 * Called whenever the page that publishes the state stops being able to: a
 * reload, a crashed renderer, a closed window. Without it the last state before
 * the page went away would persist over a menu bar that no longer has anything
 * behind it, which is the dead-keystroke failure this feature has to avoid.
 */
function resetMenuState (menu) {
  return applyMenuState(null, menu)
}

/**
 * The live application menu, or null.
 *
 * Guarded on Menu itself, not just on its return: getApplicationMenu is null
 * before buildMenu runs, and Menu is absent entirely outside Electron.
 */
function currentMenu () {
  return Menu !== undefined && Menu !== null && typeof Menu.getApplicationMenu === 'function'
    ? Menu.getApplicationMenu()
    : null
}

module.exports = {
  buildMenu, applyMenuState, resetMenuState,
  YOUTUBE_CHANNEL, VIEWS, VIEW_LABELS, VIEW_ITEM_ID, ITEM_PROBE_FIELD,
}
