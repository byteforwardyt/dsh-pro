'use strict'
/**
 * DSH PRO — Electron main process.
 *
 * Responsibilities, in order of execution:
 *   1. Refuse to run from a translocated (quarantined-DMG) path, which would make
 *      the harness write absolute symlinks into a directory that vanishes.
 *   2. Own a single instance, so two windows never race one $DSH_HOME.
 *   3. Start the harness and wait for it to report its loopback URL.
 *   4. Show that URL in a hardened BrowserWindow.
 *
 * The renderer deliberately loads over http://127.0.0.1:<port> rather than file://
 * or a custom scheme. The frontend cannot boot unserved (the host injects
 * window.__DSH_BOOT__ into index.html at render time and serves each client plugin
 * from /plugins/<id>/client.js), and the harness's own request-trust fence checks
 * Origin/Sec-Fetch-Site, which an app:// origin would fail.
 */

const { app, BrowserWindow, dialog, shell, session, ipcMain, Notification, screen, Tray, Menu, nativeImage } = require('electron')
const { startUpdateChecks, attachUpdateBanner } = require('./update-check.cjs')
const { startPhoneAccess } = require('./phone-access.cjs')

/**
 * Read one `DSH_DESKTOP_CAPTURE_*` variable, but only in a build where the
 * automation surface is allowed to run at all.
 *
 * The capture blocks below schedule window automation from environment
 * variables. `devtools` fences its own helpers, so a shipped build would answer
 * null to every one of them — but the blocks would still arm their timers and
 * log as though a capture run were under way, and any automation added here
 * that did not route through `devtools` would not be fenced at all. Reading the
 * variables through the same gate makes the whole section inert in one place.
 */
const captureEnv = (name) => (devtools.enabled() ? process.env[`DSH_DESKTOP_CAPTURE_${name}`] : undefined)
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fs = require('node:fs')
const { createDiagnosticLog } = require('./diagnostic-log.cjs')

const { startHost, stopHost, stopAllHosts, hasLiveHosts, resolveHarnessEntry, resolvedPath } = require('./host-process.cjs')
const { createComputerUse, loadBundledSDK } = require('./computer-use.cjs')
const computerUse = createComputerUse({ isConnected: () => Boolean(hostChild?.connected), loadSDK: () => loadBundledSDK(process.resourcesPath, app.isPackaged) })
const { ensureProfile } = require('./profile.cjs')
const { migrateLegacyHome, legacyHomePaths } = require('./migrate.cjs')
const devtools = require('./devtools.cjs')
const { applyChrome } = require('./chrome.cjs')
const { buildMenu, applyMenuState, resetMenuState } = require('./menu.cjs')
const { createNotifier } = require('./notify.cjs')
const { attachTray } = require('./tray-host.cjs')
const { isFatalPage, crashRestartPlan, unexpectedStopTitle } = require('./fatal-page.cjs')

const PRODUCT_NAME = 'DSH PRO'

// Must run before anything reads app.getPath('userData'): Electron derives that
// path from the app name, and the package name (@dsh-desktop/shell) would create
// a nested "@dsh-desktop/shell" directory under Application Support.
app.setName(PRODUCT_NAME)

// Development QA can run against a disposable profile without touching accounts
// or sessions in the installed app. Never honor this override in packaged builds.
if (!app.isPackaged && process.env.DSH_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.DSH_DESKTOP_USER_DATA))
}

const diagnostics = createDiagnosticLog({
  file: path.join(app.getPath('userData'), 'diagnostics-24h.log'),
})
process.on('uncaughtExceptionMonitor', (error) => {
  diagnostics.write('error', 'main', error?.stack || error)
})

/**
 * In a packaged build the icon comes from the bundle's Info.plist. In development
 * the process is generic Electron, so the Dock icon is set explicitly — otherwise
 * the app shows Electron's own icon while developing and demoing.
 */
function applyDockIcon () {
  if (process.platform !== 'darwin' || app.isPackaged) return
  const icon = path.join(__dirname, '..', '..', 'build', 'icon', 'icon-1024.png')
  try {
    if (fs.existsSync(icon)) app.dock?.setIcon(icon)
  } catch {
    // Cosmetic only.
  }
}

/** @type {import('node:child_process').ChildProcess | null} */
let hostChild = null
/** @type {BrowserWindow | null} */
let mainWindow = null
/** @type {ReturnType<typeof attachTray> | null} */
let trayHost = null
let hostUrl = null
let hostLaunchUrl = null // Private authenticated bootstrap URL; never log it.
/** This run's API capability, minted by startHost. Null until the host boots. */
let hostCapability = null
let quitting = false
/** Set while we deliberately stop a host we intend to replace (the reopen
 *  fallback). Its exit is expected, so onExit must NOT report it as a crash. */
let restartingHost = false
/** Once a fatal screen is showing, a later failure must not silently replace it
 *  with a different message — the first one names the real cause. */
let fatalShown = false
const hostLog = []
/** Host deaths we have already auto-restarted in this streak. Manual Retry
 *  and a successful boot both clear it. */
let consecutiveCrashes = 0
/** Timer for the backoff restart. Cleared when boot() actually starts so a
 *  Dock click during the wait does not race a second boot. */
let crashRestartTimer = null
/** $DSH_HOME lives under userData but in its own subdirectory, so it never mixes
 *  with the Cache/GPUCache/Cookies trees Electron manages beside it. */
function harnessHome () {
  return path.join(app.getPath('userData'), 'harness')
}

/**
 * A .app launched from a quarantined DMG runs from a randomized read-only
 * /private/var/folders/.../AppTranslocation/<uuid>/d/ path that changes between
 * launches. The harness heals $DSH_HOME/profiles/node_modules with ABSOLUTE links
 * into the install directory, so booting under translocation writes links that
 * dangle on the next run. Refuse, and tell the user what to do.
 */
function isTranslocated () {
  return process.platform === 'darwin' && process.execPath.includes('/AppTranslocation/')
}

/**
 * Locate our own cordis plugins so they can be linked into the profile.
 * Resolving through package.json keeps this correct in development (pnpm
 * workspace symlinks) and in the packaged app (staged closure) alike.
 */
function resolveDesktopPlugins () {
  const names = [
    '@dsh-desktop/auth-allowlist',
    '@dsh-desktop/host-auth-api',
    '@dsh-desktop/host-diagnostics',
    '@dsh-desktop/host-files-api',
    // Not mounted by the desktop profile — the Dispatch PRESET imports it — but
    // it must be in the profile link farm so that import resolves.
    '@dsh-desktop/tool-dispatch',
    '@dsh-desktop/client-ui-byteforward',
    '@dsh-desktop/client-ui-accounts',
    '@dsh-desktop/client-ui-model-visibility',
    '@dsh-desktop/client-ui-agent-default',
    '@dsh-desktop/client-ui-supercode',
    '@dsh-desktop/client-ui-notify',
    '@dsh-desktop/client-ui-preview',
    '@dsh-desktop/client-ui-reset',
    '@dsh-desktop/client-ui-phone',
    '@dsh-desktop/client-ui-files',
    '@dsh-desktop/client-ui-brand',
    '@dsh-desktop/client-ui-usage',
    '@dsh-desktop/client-ui-theme-holo',
    '@dsh-desktop/client-ui-workspaces',
    '@dsh-desktop/client-ui-workspace-tools',
    '@dsh-desktop/client-ui-inspector',
    '@dsh-desktop/client-ui-media',
    '@dsh-desktop/computer-use',
    '@dsh-desktop/development-setup',
    '@dsh-desktop/terminal',
  ]
  const resolved = {}
  for (const name of names) {
    try {
      if (app.isPackaged) {
        // The packaged main ships no node_modules of its own; the plugins live
        // in the staged harness closure beside the asar (pnpm deploy of the
        // shell includes its production dependencies, ours included).
        const dir = path.join(process.resourcesPath, 'harness', 'node_modules', ...name.split('/'))
        if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error(`not in staged tree: ${dir}`)
        resolved[name] = fs.realpathSync(dir)
      } else {
        resolved[name] = path.dirname(require.resolve(`${name}/package.json`))
      }
    } catch (error) {
      recordLog('err', `could not resolve plugin ${name}: ${error.message}`)
    }
  }
  return resolved
}

function recordLog (stream, line, source = 'app') {
  line = String(line).replace(/([?&]token=)[^\s&'"<>]+/g, '$1[redacted]')
  const entry = `[${stream}] ${line}`
  hostLog.push(entry)
  if (hostLog.length > 200) hostLog.shift()
  // Host stdout can include arbitrary plugin output. Keep it only in the
  // short-lived crash ring; persist host stderr and our own lifecycle events.
  if (source !== 'host' || stream === 'err') {
    diagnostics.write(stream === 'err' ? 'error' : 'info', source, line)
  }
  // The harness child's output is otherwise captured into this ring buffer and
  // never printed, so a console.log from inside a plugin is invisible — which
  // makes diagnosing anything host-side guesswork. Opt in with DSHD_HOST_LOG=1.
  if (process.env.DSHD_HOST_LOG) console.log(`[host:${stream}] ${line}`)
}

async function revealDiagnosticLog () {
  const file = diagnostics.revealPath()
  const error = await shell.openPath(file)
  if (error) {
    recordLog('err', 'could not reveal diagnostics: ' + error)
    return false
  }
  return true
}

function existingWindow () {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function errorPagePath () {
  return path.join(__dirname, 'ui', 'error.html')
}

function fromFatalPage (event) {
  return isFatalPage(event.senderFrame?.url ?? '', errorPagePath())
    && event.senderFrame === event.sender.mainFrame
}

/**
 * Remember the window's size and position between launches.
 *
 * An app that opens at the same default rectangle every time, no matter how you
 * left it, is one of the quieter tells that something is a wrapper rather than
 * a Mac app. Stored beside the other app state, and treated as advisory: a
 * corrupt or stale file, or a saved rectangle that belongs to a display that is
 * no longer attached, falls back to the default rather than opening the window
 * somewhere the user cannot reach it.
 */
function windowStateFile () {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function readWindowState () {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'))
    if (!Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return null
    if (saved.width < 720 || saved.height < 520) return null
    // Only honour a position that still lands on a connected display.
    if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const onScreen = screen.getAllDisplays().some((display) => {
        const b = display.workArea
        return saved.x < b.x + b.width && saved.x + saved.width > b.x
          && saved.y < b.y + b.height && saved.y + saved.height > b.y
      })
      if (!onScreen) return { width: saved.width, height: saved.height }
    }
    return saved
  } catch {
    return null
  }
}

function trackWindowState (win) {
  const save = () => {
    // Never write during a factory reset: the reset deletes window-state.json,
    // then hides/closes the window — whose close-time save would recreate the
    // file and reopen the "fresh install" at the old bounds.
    if (quitting) return
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const { x, y, width, height } = win.getNormalBounds()
    try {
      fs.writeFileSync(windowStateFile(), JSON.stringify({ x, y, width, height }))
    } catch {
      // Losing a window position is not worth surfacing to anyone.
    }
  }
  let timer = null
  const debounced = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  win.on('resize', debounced)
  win.on('move', debounced)
  win.on('close', save)
}

function createWindow () {
  const saved = readWindowState()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 860,
    ...(Number.isFinite(saved?.x) && Number.isFinite(saved?.y)
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: PRODUCT_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Matches the harness's own boot screen (#151517) so window paint, our
    // splash, and the app background are one continuous colour at launch.
    backgroundColor: '#191919',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // Build identity for the About panel. additionalArguments is the
      // documented way to hand a preload static values; process.env does not
      // reliably reach a sandboxed renderer. A user reporting a problem should
      // not have to dig through Finder to answer "which version?".
      additionalArguments: [
        `--dshd-app-version=${app.getVersion()}`,
        `--dshd-electron-version=${process.versions.electron}`,
        `--dshd-arch=${process.arch}`,
        `--dshd-harness-version=${harnessVersion()}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Enabled for the Preview view's browser, which needs real navigation
      // history and script injection for the element picker — neither of which
      // an <iframe> can do across origins. Constrained deliberately:
      //  - a will-attach-webview handler rejects any src that is not http(s)
      //    and strips nodeIntegration/preload from the attachment;
      //  - guardWebContents contains every guest for its whole life (scheme
      //    allowlist, no windows, no permissions, no downloads);
      //  - the window CSP still forbids remote script and remote connect in
      //    the app's own origin — the guest browses, the app does not.
      // The residual risk is a compromised renderer creating a webview; that
      // renderer already has the unauthenticated local API, so this is not the
      // weakest link. Revert by setting false and the Preview view degrades to
      // its iframe path.
      webviewTag: true,
      // The renderer talks to the harness over http://127.0.0.1; leaving web
      // security on keeps same-origin rules intact for that origin.
      webSecurity: true,
    },
  })

  trackWindowState(mainWindow)

  // insertCSS is scoped to one document, and the harness UI navigates on reload,
  // so the adaptation is re-applied every time a document finishes loading.
  // Every <webview> attachment is inspected before it is allowed. Only http(s)
  // may load — the Preview pane is a real browser, so any web origin is fair
  // game, but file://, data: and friends are not — and Node integration /
  // custom preloads are stripped, so a preview pane can never become a
  // privileged frame.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    // Electron force-inherits only a handful of preferences from the embedder;
    // these four are settable from the renderer's `webpreferences` attribute and
    // are not among them. webSecurity=false in particular lets a guest read
    // file:// from an http origin.
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.experimentalFeatures = false
    webPreferences.webviewTag = false
    const partition = params.partition || PREVIEW_PARTITION
    if (partition !== PREVIEW_PARTITION && !/^persist:dshd-preview:[A-Za-z0-9%_.!~*'()-]{1,1024}$/.test(partition)) {
      event.preventDefault()
      return
    }
    guardPreviewPartition(partition)
    if (!isWebUrl(params.src)) {
      recordLog('err', `blocked webview attachment to ${params.src}`)
      event.preventDefault()
    }
  })

  mainWindow.webContents.on('did-finish-load', () => {
    void applyChrome(mainWindow.webContents)
    // A fresh page has not told us what it has yet. Re-enable the menu rather
    // than keeping the state the previous page published: the whole feature is
    // only safe while a disabled item means "measured absent", never "stale".
    // The page republishes as soon as its first probe differs from nothing.
    resetMenuState()
  })

  // Renderer errors are otherwise invisible from the main process. Capture
  // warnings/errors in the private log even outside a development run.
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    const message = `${details.message} (${details.sourceId}:${details.lineNumber})`
    diagnostics.write(details.level === 'error' ? 'error' : 'warn', 'renderer', message)
    if (devtools.enabled() || process.env.DSHD_RENDERER_LOG === '1') {
      console.log(`[renderer:${details.level}] ${message}`)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_event, detail) => {
    diagnostics.write('error', 'renderer', `process gone: ${detail?.reason || 'unknown'}`)
  })
  mainWindow.webContents.on('preload-error', (_event, _path, error) => {
    diagnostics.write('error', 'preload', error?.stack || error)
  })
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    // The game runs in its own webContents, so main-window console listeners
    // cannot see a preview exception or a failed local dev-server navigation.
    guest.on('console-message', (details) => {
      if (details.level !== 'error') return
      diagnostics.write('error', 'preview', `${details.message} (${details.sourceId}:${details.lineNumber})`)
    })
    guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return // cancelled navigation is normal
      diagnostics.write('error', 'preview', `navigation failed (${code}): ${description} ${url}`)
    })
    guest.on('render-process-gone', (_event, detail) => {
      diagnostics.write('error', 'preview', `process gone: ${detail?.reason || 'unknown'}`)
    })
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    // On macOS the app and its menu bar outlive the window. Leaving the last
    // published state applied would grey out items over no window at all.
    resetMenuState()
  })

  // Anything the page tries to open in a new window goes to the system browser
  // if we trust the host, and nowhere otherwise.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url)
    return { action: 'deny' }
  })

  // In-place navigation is confined to the harness ORIGIN. Comparing parsed
  // origins rather than string prefixes matters: "http://127.0.0.1:5051@evil.com/"
  // startsWith("http://127.0.0.1:5051") is true, but its origin is evil.com — a
  // prefix test would navigate the trusted window straight off-host.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isHostUrl(url)) return
    event.preventDefault()
    openExternalIfAllowed(url)
  })

  return mainWindow
}

/** True only when `rawUrl` parses to exactly the running harness origin. */
/**
 * The version of the DeepSeek Harness this build actually ships.
 *
 * Read from the staged closure's own package.json rather than hardcoded — that
 * file IS the shipped artifact, so it cannot drift from what is running. An
 * unreadable manifest yields an empty string, never a wrong number.
 */
function harnessVersion () {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')]
    : [path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')]
  for (const candidate of candidates) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')).version || '' } catch {}
  }
  return ''
}

function isHostUrl (rawUrl) {
  if (!hostUrl) return false
  try {
    return new URL(rawUrl).origin === new URL(hostUrl).origin
  } catch {
    return false
  }
}

/**
 * The bundled legal notices, by name.
 *
 * Redistributing several hundred packages — one of them LGPL — obliges us to
 * ship their notices and let a user actually read them. The About panel is
 * where that lives, but it is a page served over http://127.0.0.1 and cannot
 * reach a file inside the .app, so it asks the main process instead.
 *
 * Names, never paths. The renderer picks one of these two keys and the value is
 * resolved here, so there is no argument a compromised page could bend into
 * "open an arbitrary file".
 */
const NOTICE_FILES = {
  license: 'LICENSE',
  'third-party': 'THIRD_PARTY_NOTICES.md',
}

/** Where the notices sit, packaged (Resources/) or run from the repo. */
function noticePath (name) {
  const file = NOTICE_FILES[name]
  if (!file) return null
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, file)]
    : [path.join(__dirname, '..', '..', file)]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

/**
 * Factory reset: wipe everything the app stores on this Mac and relaunch.
 *
 * The renderer's row is only an entry point — the confirmation is a NATIVE
 * dialog here, so a compromised or confused page can pester but never erase.
 * What goes: $DSH_HOME (sessions, workspace registry, settings, the plaintext
 * credentials file), both Chromium sessions' storage, and the window state.
 * What stays: the user's project folders, untouched by construction.
 */
/**
 * Phone access: enable/disable the paired LAN proxy from Settings.
 *
 * Sender-checked like every other handler; state lives here and dies with the
 * process, so quitting the app always closes the door. `status` never mints
 * anything — the row can render without side effects.
 */
let phoneAccess = null
let phoneAccessStarting = false
function registerPhoneAccessHandler () {
  ipcMain.handle('dsh:phone-access', async (event, op) => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isHostUrl(senderUrl)) return { enabled: false }
    // startPhoneAccess awaits a listen(), so two 'enable' calls that arrive
    // before the first assigns phoneAccess would each bind a proxy and leak the
    // first, with no control able to stop it. The in-flight flag makes enable
    // idempotent across that await.
    if (op === 'enable' && phoneAccess === null && hostUrl && !phoneAccessStarting) {
      phoneAccessStarting = true
      try {
        const authority = new URL(hostUrl).host
        const authName = 'dsh-auth-' + require('node:crypto').createHash('sha256').update(authority).digest('base64url')
        const cookies = await session.defaultSession.cookies.get({ url: hostUrl, name: authName })
        if (cookies.length !== 1) return { enabled: false, error: 'Open the app successfully before enabling phone access.' }
        const started = await startPhoneAccess(hostUrl, hostCapability, { upstreamAuthCookie: `${authName}=${cookies[0].value}` })
        if (started.error) return { enabled: false, error: started.error }
        phoneAccess = started
      } finally {
        phoneAccessStarting = false
      }
    }
    if (op === 'disable' && phoneAccess !== null) {
      phoneAccess.stop()
      phoneAccess = null
    }
    return phoneAccess === null
      ? { enabled: false }
      : { enabled: true, url: phoneAccess.url, code: phoneAccess.code, qrSvg: phoneAccess.qrSvg }
  })
}

let developmentSetup = null
function registerDevelopmentSetupHandler () {
  const { createSetupHandler } = require('./development-setup.cjs')
  const pluginRoot = resolveDesktopPlugins()['@dsh-desktop/development-setup']
  if (!pluginRoot) throw new Error('Development setup plugin is missing from this build.')
  const toolsDir = path.join(app.getPath('userData'), 'development-tools')
  process.env.PATH = path.join(toolsDir, 'node_modules', '.bin') + path.delimiter + (process.env.PATH || '')
  const runtime = require(path.join(pluginRoot, 'lib/runtime.cjs'))
  developmentSetup = createSetupHandler({
    runtime, toolsDir, getEnv: () => ({...process.env, PATH: resolvedPath()}),
    getRoots: async () => {
      if (!hostUrl || !hostCapability) throw new Error('The agent connection is unavailable.')
      const response = await fetch(hostUrl + '/dsh-files/roots', {headers:{Cookie:CAPABILITY_COOKIE + '=' + hostCapability},signal:AbortSignal.timeout(10000)})
      if (!response.ok) throw new Error('Could not read the open workspaces.')
      return (await response.json()).roots
    },
    openExternal: url => shell.openExternal(url),
    confirm: async reviewed => {
      const response = await dialog.showMessageBox(existingWindow(), {
        type:'question',title:'Install development dependencies?',buttons:['Cancel','Install'],defaultId:0,cancelId:0,
        message: reviewed.root ? 'Install dependencies for ' + path.basename(reviewed.root) + '?' : 'Install this development tool for DSH PRO?',
        detail: 'Package installation can run code from this project and its dependencies. Python packages stay in the project virtual environment.\n\n' + reviewed.summary,
      })
      return response.response === 1
    },
  })
  ipcMain.handle('dsh:development-setup', async (event, op, payload) => {
    if (!isHostUrl(event.senderFrame?.url ?? '') || event.senderFrame !== event.sender.mainFrame) return {error:'Development setup requires the main DSH PRO window.'}
    try { return await developmentSetup.handle(op,payload) }
    catch(error) { return {error:error.message || 'Development setup failed.'} }
  })
}

function registerComputerUseHandler () {
  let confirming = false
  ipcMain.handle('dsh:computer-use', async (event, op) => {
    if (!isHostUrl(event.senderFrame?.url ?? '') || event.senderFrame !== event.sender.mainFrame) return { enabled: false }
    if (!['status', 'enable', 'disable', 'permissions', 'screen-settings'].includes(op)) return { enabled: false }
    try {
      if (op === 'enable') {
        if (confirming) return computerUse.control('status')
        confirming = true
        try {
          const current = await computerUse.control('status')
          if (current.enabled) return current
          const win = BrowserWindow.fromWebContents(event.sender)
          const answer = await dialog.showMessageBox(win, {
            type: 'question', buttons: ['Cancel', 'Turn on'], defaultId: 0, cancelId: 0,
            title: 'Turn on computer use?',
            message: 'Let DSH interact with your Mac for this app session?',
            detail: 'Requested screenshots and app content go to your selected AI provider. Each computer action uses DSH’s approval flow. You can stop computer use at any time in Settings.',
          })
          if (answer.response !== 1) return current
        } finally { confirming = false }
      }
      return await computerUse.control(op)
    } catch (error) { return { enabled: false, state: 'driver-error', error: 'Computer use failed: ' + (error?.message || 'unknown driver error') } }
  })
}
/**
 * The page's view state, pushed rather than sampled.
 *
 * See the long comment on the View submenu in menu.cjs for why sampling was
 * refused. ipcMain.on, not handle: the page is telling us something, not asking.
 */
function registerSessionsHandler () {
  ipcMain.on('dsh:sessions-state', (event, state) => {
    if (!isHostUrl(event.senderFrame?.url ?? '') || event.senderFrame !== event.sender.mainFrame) return
    if (trayHost) trayHost.ingest(state)
  })
}

function registerMenuStateHandler () {
  ipcMain.on('dsh:menu-state', (event, state) => {
    if (!isHostUrl(event.senderFrame?.url ?? '') || event.senderFrame !== event.sender.mainFrame) return
    applyMenuState(state)
  })
}

/**
 * Notifications and the Dock badge.
 *
 * The policy lives in notify.cjs, which knows nothing about Electron; this is
 * the wiring. Three channels rather than one op-switch, matching every other
 * bridge here: post an event, set the waiting count, mirror the preference.
 *
 * The preference is mirrored here as well as held in the page, so an "off" is
 * refused without a round trip and the Dock badge cannot be relit behind it.
 * It is NOT a security boundary, and calling it one would be a lie: the toggle
 * lives in the same renderer, so anything able to post can flip the mirror
 * first. What actually bounds a page gone wrong is the focus gate and the burst
 * limit in notify.cjs.
 */
function registerNotifyHandler () {
  const notifier = createNotifier({
    Notification,
    isFocused: () => mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused(),
    focusWindow: () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    },
    // Sent to the window rather than acted on here: which session is open is
    // page state, and the page is the only side that can tell whether the id
    // still exists by the time a click on a minutes-old banner arrives.
    openSession: (id) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (win) win.webContents.send('dsh:open-session', id)
    },
    // No Dock off macOS. Windows and Linux badge through an overlay icon or the
    // taskbar, which is a different design than this one, not a missing branch.
    dock: process.platform === 'darwin' ? (app.dock ?? null) : null,
  })

  /**
   * Only the top frame of the window showing the harness may ask. A <webview>
   * guest cannot reach this anyway - will-attach-webview strips its preload -
   * and the mainFrame check keeps that true for any iframe the page grows.
   */
  const fromHostPage = (event) => isHostUrl(event.senderFrame?.url ?? '')
    && event.senderFrame === event.sender.mainFrame

  ipcMain.handle('dsh:notify', (event, payload) =>
    fromHostPage(event) ? notifier.post(payload) : 'denied')
  ipcMain.handle('dsh:notify-badge', (event, count) =>
    fromHostPage(event) ? notifier.setWaiting(count) : notifier.waiting())
  ipcMain.handle('dsh:notify-enabled', (event, value) =>
    fromHostPage(event) ? notifier.setEnabled(value) : notifier.isEnabled())
}

function registerResetHandler () {
  ipcMain.handle('dsh:reset-app', async (event) => {
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isHostUrl(senderUrl)) return false
    if (!mainWindow || mainWindow.isDestroyed()) return false

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Reset and Relaunch', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Reset DSH PRO?',
      detail: 'This erases everything the app stores on this Mac: sessions, the '
        + 'workspace list, settings, and sign-ins. Your project folders are not '
        + 'touched.\n\nDSH PRO will relaunch fresh, like a first install.',
    })
    if (response !== 0) return false
    recordLog('out', 'reset: confirmed, wiping and relaunching')

    // Instant feedback: hide the window before the host teardown, which can
    // take several seconds — otherwise the app looks frozen and a user force-
    // quits mid-reset, which is exactly what read as "reset does not work".
    quitting = true
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.hide()
    }
    try { await stopHost(hostChild) } catch {}
    hostChild = null
    if (phoneAccess !== null) { try { phoneAccess.stop() } catch {}; phoneAccess = null }
    try { fs.rmSync(harnessHome(), { recursive: true, force: true }) } catch {}
    // Also remove any legacy-named home, or the post-reset relaunch would
    // migrate the old data (sessions, settings, plaintext credentials) back in
    // and the app would come up signed in — the opposite of a reset.
    const legacyHomes = !app.isPackaged && process.env.DSH_DESKTOP_USER_DATA
      ? [] : legacyHomePaths(app.getPath('appData'))
    for (const legacy of legacyHomes) {
      try { fs.rmSync(legacy, { recursive: true, force: true }) } catch {}
    }
    try { fs.rmSync(windowStateFile(), { force: true }) } catch {}
    await session.defaultSession.clearStorageData().catch(() => {})
    await session.fromPartition(PREVIEW_PARTITION).clearStorageData().catch(() => {})
    // relaunch + quit, NOT exit(0): app.exit skips the shutdown that actually
    // performs the queued relaunch, so the app wiped and never came back.
    // quit is safe here — the before-quit guard returns early once `quitting`
    // is set, so it does not preventDefault and the relaunch fires.
    app.relaunch()
    app.quit()
    return true
  })
}

function registerNoticeHandler () {
  ipcMain.handle('dsh:open-notice', async (event, which) => {
    // Only the window showing the harness may ask. A <webview> guest cannot
    // reach this anyway — will-attach-webview strips its preload and sandboxes
    // it — but the sender check means that stays true even if that changes.
    const senderUrl = event.senderFrame?.url ?? ''
    if (!isHostUrl(senderUrl)) return false

    const target = noticePath(which)
    if (!target) return false

    const error = await shell.openPath(target)
    if (error) {
      console.log(`[dsh-desktop] could not open ${which}: ${error}`)
      return false
    }
    return true
  })
}

/**
 * True for http(s) URLs on this machine's loopback interface.
 *
 * The one place the answer is decided, so the attach check, the guest's
 * navigation guard and "open in your browser" cannot drift apart.
 */
function isLoopbackUrl (rawUrl) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * True for any http(s) URL — the whole of what the Preview browser may load.
 * Everything else (file:, data:, chrome:, javascript:, custom schemes) stays
 * out of the pane at every layer that consults this.
 */
function isWebUrl (rawUrl) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { return false }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/**
 * Preview partition prefix. Conversation guests append their encoded session
 * ID; every allowed partition is guarded before the webview attaches.
 */
const PREVIEW_PARTITION = 'persist:dshd-preview'

/**
 * Contain every <webview> guest for its whole life, not just at birth.
 *
 * The Preview pane is a full browser: guests may navigate anywhere on the web.
 * What stays contained is everything about a guest that is not plain browsing:
 *
 *  - scheme allowlist — top-level navigation is http(s) only, so a link to
 *    file:///etc/passwd or a javascript: URL goes nowhere. Subframes may also
 *    use the inert embed schemes (about:, data:, blob:) that ordinary sites
 *    lean on for ads and sandboxed widgets.
 *  - no windows — window.open and target=_blank are denied as WINDOWS and
 *    turned into a navigation of the same pane, which is what a single-pane
 *    browser means by "open".
 *  - no permissions — camera, mic, geolocation, clipboard-read: denied.
 *  - no downloads (per-partition, see guardPreviewPartition) — the pane is for
 *    looking; "Open in your browser" is the download path.
 *
 * A remote page fetching the unauthenticated local API gets nowhere new: its
 * Origin is remote, and the harness's request-trust fence accepts loopback
 * origins only — the same exposure as any tab in the user's real browser.
 *
 * Registering on `web-contents-created` rather than on the window also covers
 * contents the window never sees.
 */
function guardWebContents () {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    const block = (event, url) => {
      if (isWebUrl(url) || url === 'about:blank') return
      recordLog('err', `blocked preview navigation to ${url}`)
      event.preventDefault()
    }
    contents.on('will-navigate', block)
    contents.on('will-redirect', block)

    // will-navigate fires for the MAIN FRAME only, and will-redirect only for
    // server-side redirects — so a subframe loading a URL directly tripped
    // neither. will-frame-navigate is the all-frames event; it passes a details
    // object rather than (event, url), so it cannot reuse `block`. Subframes
    // are looser on purpose: about:blank/srcdoc, data: and blob: frames are the
    // plumbing of ordinary sites, and inside a sandboxed, node-free guest they
    // rate as content, not capability.
    contents.on('will-frame-navigate', (details) => {
      if (isWebUrl(details.url)) return
      if (!details.isMainFrame && /^(about:|data:|blob:)/.test(details.url)) return
      if (details.isMainFrame && details.url === 'about:blank') return
      recordLog('err', `blocked preview ${details.isMainFrame ? '' : 'subframe '}navigation to ${details.url}`)
      details.preventDefault()
    })

    // "Open in a new window" means "navigate this pane" here. The window is
    // always denied; the URL, if it is plain web, loads in place. This is the
    // one spot where a popup-blocked site's fallback (location =) and its
    // preferred path (window.open) converge on the same behavior.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) contents.loadURL(url).catch(() => {})
      return { action: 'deny' }
    })

    // With no handler registered, Electron auto-grants permission requests. On
    // a machine where people paste API keys, a silent clipboard read from a
    // previewed page is the sharpest edge of that; deny the lot.
    const deny = (_wc, _permission, callback) => callback(false)
    contents.session.setPermissionRequestHandler(deny)
    contents.session.setPermissionCheckHandler(() => false)
  })
}

/**
 * Deny permission requests in the MAIN window too.
 *
 * The preview guest was locked down and the window that actually fronts the
 * agent was not — the protection was inverted with respect to trust. With no
 * handler registered Electron auto-grants, and a page on the harness origin
 * could call navigator.clipboard.readText() with no user gesture and no
 * prompt (confirmed against this Electron build: it returned the real
 * clipboard). Nothing here legitimately needs camera, microphone, location or
 * clipboard-read. Only sanitized clipboard writes from the trusted main frame
 * are allowed, so code-block and message Copy buttons work without read access.
 *
 * Defence in depth rather than a boundary: anything able to run script on that
 * origin already reaches an unauthenticated local API fronting a shell. That is
 * a reason to close this, not to leave it open.
 */
function guardDefaultSession () {
  // Copy is write-only. Never grant clipboard-read, or grants to preview
  // guests/subframes/other origins just because they share a session.
  const canCopy = (wc, permission, details) => permission === 'clipboard-sanitized-write'
    && wc === mainWindow?.webContents && details?.isMainFrame === true
    && isHostUrl(details.requestingUrl) && isHostUrl(wc.getURL())
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(canCopy(wc, permission, details)))
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => canCopy(wc, permission, details))
}

/**
 * Guard the preview guest's own partition.
 *
 * Permissions are denied here as well as per-contents, downloads are blocked
 * (a browser pane that silently writes files from any site it renders is a
 * drive-by hazard; "Open in your browser" is the download path), and LOOPBACK
 * responses get a stamped CSP. Remote responses pass through untouched — a
 * real site's own headers are its own policy, and the loopback stamp below
 * would break nearly every remote page.
 */
const guardedPreviewPartitions = new Set()
function guardPreviewPartition (partition = PREVIEW_PARTITION) {
  if (guardedPreviewPartitions.has(partition)) return
  guardedPreviewPartitions.add(partition)
  const guest = session.fromPartition(partition)
  guest.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  guest.setPermissionCheckHandler(() => false)
  guest.on('will-download', (event) => event.preventDefault())
  guest.webRequest.onHeadersReceived((details, callback) => {
    // The stamp exists for the loopback family: it keeps workspace HTML in an
    // opaque origin (the sandbox path below) and gives dev servers a policy
    // that HMR and localStorage tolerate. A remote page keeps its own headers.
    if (!isLoopbackUrl(details.url)) {
      callback({})
      return
    }
    const headers = { ...details.responseHeaders }
    // A page that ships its own `sandbox` CSP keeps it. This is how workspace
    // HTML served by host-files-api stays in an OPAQUE origin: without that,
    // the guest would run on a loopback origin, and the app's API trust fence
    // accepts every loopback origin — so a previewed page could drive the
    // agent. The sandbox makes its Origin `null`, which that fence rejects. A
    // user's own dev server sends no sandbox and gets the permissive guest
    // policy below, which is what HMR and localStorage need; a hostile dev
    // server that sends its own sandbox only sandboxes itself.
    let incomingSandbox = false
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== 'content-security-policy') continue
      const value = Array.isArray(headers[key]) ? headers[key].join(' ') : String(headers[key])
      if (/(^|;|\s)sandbox(\s|;|$)/.test(value)) incomingSandbox = true
      delete headers[key]
    }
    if (incomingSandbox) {
      headers['Content-Security-Policy'] = ['sandbox allow-scripts allow-forms allow-popups']
    } else {
      headers['Content-Security-Policy'] = [
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: "
        + 'http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*',
        "frame-src 'self' http://127.0.0.1:* http://localhost:*",
        "object-src 'none'",
      ].join('; ')
    }
    callback({ responseHeaders: headers })
  })
}

function openExternalIfAllowed (rawUrl) {
  let parsed
  try { parsed = new URL(rawUrl) } catch { return false }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  // Any http(s) URL may be handed to the system browser. The Preview pane is a
  // full browser now, so "Open in your browser" can legitimately carry any web
  // address — the old host allowlist (OAuth hosts + the update site) just made
  // that button dead on most of the web. What still cannot happen is an
  // app-origin page opening a NON-web scheme (file:, javascript:, custom
  // protocol handlers): rejected above. The system browser shows its own
  // address bar, so a hostile URL opened there arrives with full browser UI
  // around it, not chromeless inside this app.
  // Swallow rejections locally. `void` does NOT catch them: a failed
  // openExternal (no handler for the scheme, a launch-services error) would
  // otherwise reach the global unhandledRejection handler and replace a healthy
  // app with a fatal screen over a mere failed "open in browser".
  shell.openExternal(parsed.toString()).catch((error) => {
    recordLog('err', `openExternal failed: ${error?.message || error}`)
  })
  return true
}

function showLoading (win) {
  return win.loadFile(path.join(__dirname, 'ui', 'loading.html'))
}

/** The host boots in parallel; reveal it only after the splash sound settles. */
async function revealBootedHost (win, url, launchUrl = hostLaunchUrl || url) {
  const loadingUrl = pathToFileURL(path.join(__dirname, 'ui', 'loading.html')).href
  const current = () => !win.isDestroyed() && !quitting && !fatalShown
    && hostUrl === url && win.webContents.getURL() === loadingUrl
  if (!current()) return
  try {
    const result = await win.webContents.executeJavaScript('window.startupSoundFinished')
    recordLog(result === 'stalled' || result === 'unavailable' ? 'err' : 'out',
      `startup sound: ${result || 'not available'}`)
  } catch (error) {
    if (!current()) return // Closed window, fatal page, or superseded boot.
    recordLog('err', `startup sound check failed: ${error.message}`)
  }
  if (!current()) return
  await seedCapabilityCookie()
  if (current()) await win.loadURL(launchUrl)
}

async function showFatal (title, detail) {
  if (fatalShown) return
  fatalShown = true
  const body = String(detail ?? '').trim() || 'No further detail was reported.'
  diagnostics.write('error', 'fatal', `${title}: ${body.split(/\r?\n/, 1)[0]}`)
  const win = existingWindow()
  if (win) {
    await win.loadFile(errorPagePath(), {
      query: { title, detail: body.slice(0, 8000) },
    })
    win.show()
    return
  }
  dialog.showErrorBox(title, body)
}

/**
 * Retry from the fatal screen. Reuses the window that is already showing
 * error.html — creating a second BrowserWindow here used to leave the fatal
 * page sitting behind a new loading window, and onExit of a still-tracked
 * child could race a duplicate host.
 *
 * A host that is still alive (renderer crash, not a child death) is reattached.
 * A dead host is booted again. The crash streak is cleared so a person who
 * asked to retry gets the same two silent restarts as a fresh launch.
 */
async function retryFromFatal () {
  if (crashRestartTimer) {
    clearTimeout(crashRestartTimer)
    crashRestartTimer = null
  }
  consecutiveCrashes = 0
  fatalShown = false
  const win = existingWindow() || createWindow()
  await showLoading(win)
  win.show()
  if (hostAlive() && hostUrl) {
    try {
      await revealBootedHost(win, hostUrl)
      return { ok: true }
    } catch {
      restartingHost = true
      try { await stopHost(hostChild) } catch {}
      restartingHost = false
      hostChild = null
      hostUrl = null
      hostCapability = null
    }
  }
  try {
    await boot()
    return { ok: true }
  } catch (error) {
    await showFatal('DSH PRO could not start', String(error?.stack || error))
    return { ok: false }
  }
}

/**
 * Retry and Reveal Logs are reachable from the same preload the harness page
 * gets, so the sender fence is the whole boundary. isHostUrl would accept the
 * live app and refuse the fatal page — the opposite of what these two calls
 * are for.
 */
function registerFatalHandler () {
  ipcMain.handle('dsh:retry-harness', async (event) => {
    if (!fromFatalPage(event)) return { ok: false }
    return retryFromFatal()
  })
  ipcMain.handle('dsh:reveal-logs', async (event) => {
    if (!fromFatalPage(event)) return false
    return revealDiagnosticLog()
  })
}

/** Is the harness child still running? */
function hostAlive () {
  return Boolean(hostChild && hostChild.exitCode === null && hostChild.signalCode === null)
}

/**
 * Bring the window forward, creating one if the user closed it.
 *
 * Shared by the Dock, a second-instance launch, a notification click, and the
 * tray's Open item. show() is load-bearing on macOS: focus() on a hidden
 * window does not make it visible.
 */
function focusApp () {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  if (hostAlive() && hostUrl) void reopenWindow()
  else void boot().catch((error) => {
    void showFatal('DSH PRO could not start', String(error?.stack || error))
  })
}

/**
 * The cookie carrying this run's API capability.
 *
 * The name is duplicated from CAPABILITY_COOKIE in
 * plugins/host-files-api/lib/trust.js, because the shell is CommonJS and the
 * plugins are ESM loaded inside a different process. A test asserts the two
 * agree, so the duplication cannot drift silently.
 */
const CAPABILITY_COOKIE = 'dsh_cap'

/**
 * Seed this run's API capability into the window's session.
 *
 * The harness refuses its /dsh-* routes without it, and the browser then
 * attaches it to every same-origin request on its own — including EventSource
 * streams and media element loads, neither of which can set a header. That is
 * why the capability is a cookie rather than a bearer token.
 *
 * It is a session cookie: no expiry, so nothing reaches disk and the value dies
 * with the process that minted it. The preview pane's guests run in their own
 * partition and are deliberately never given it, so a page the user previews
 * still cannot reach the app's API despite sharing the loopback host.
 *
 * Called before every window load rather than once at boot. Seeding is cheap
 * and idempotent, and a single rule leaves no path that can forget it.
 */
async function seedCapabilityCookie () {
  if (!hostUrl || !hostCapability) return
  try {
    await session.defaultSession.cookies.set({
      url: hostUrl,
      name: CAPABILITY_COOKIE,
      value: hostCapability,
      httpOnly: true,
      sameSite: 'strict',
    })
  } catch (error) {
    // The window will load — the harness serves its own HTML above our fence —
    // but every panel that talks to a /dsh-* route will answer 403. Say so in
    // the log the user can open rather than leaving them to guess.
    recordLog('err', `could not seed the API capability; app panels will fail: ${error?.message ?? error}`)
  }
}

/**
 * Reopen path. On macOS, closing the window leaves the app (and the harness
 * child) running; clicking the Dock icon must REATTACH to that host, not boot a
 * second one. Booting again here was the audit's top finding: each close/reopen
 * spawned a fresh harness, overwrote `hostChild`, and orphaned the previous
 * process — with its port, PTYs, and any in-flight OAuth attempt — beyond even
 * quit-time cleanup, which only stops the child it still has a reference to.
 */
async function reopenWindow () {
  const win = createWindow()
  attachUpdateBanner(win)
  try {
    await seedCapabilityCookie()
    await win.loadURL(hostLaunchUrl || hostUrl)
  } catch {
    // loadURL failed. It may be a dead host, but it may equally be a transient
    // error while the host is perfectly alive — clearing hostChild without
    // stopping it would orphan the process AND boot a duplicate. Stop it first,
    // then fall back to a clean boot. Mark the stop as intentional so the host's
    // onExit does not flash a false "harness stopped unexpectedly" modal for a
    // shutdown we requested (onExit fires within this await, before the reset).
    if (!win.isDestroyed()) win.destroy()
    restartingHost = true
    try { await stopHost(hostChild) } catch {}
    restartingHost = false
    hostChild = null
    hostUrl = null
    // The next boot mints its own; keeping this one would seed a cookie the
    // new harness does not accept, which reads as a broken app rather than as
    // a stale secret.
    hostCapability = null
    await boot()
  }
}

let booting = false

async function boot () {
  if (crashRestartTimer) {
    clearTimeout(crashRestartTimer)
    crashRestartTimer = null
  }
  if (booting || hostAlive()) return
  booting = true
  try {
    await bootInner()
  } finally {
    booting = false
  }
}

async function bootInner () {
  fatalShown = false
  if (isTranslocated()) {
    dialog.showErrorBox(
      `Move ${PRODUCT_NAME} to Applications`,
      `${PRODUCT_NAME} is running from a temporary location, which macOS creates when an app is `
      + `opened directly from a disk image.\n\nQuit, drag ${PRODUCT_NAME} into your Applications `
      + `folder, and open it from there.`,
    )
    app.quit()
    return
  }

  const dshHome = harnessHome()
  fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  // mkdir's mode applies only to directories it creates, so a home left over from
  // an earlier build could keep looser permissions. It holds OAuth refresh tokens.
  try { fs.chmodSync(dshHome, 0o700) } catch { /* best effort */ }

  // Adopt data from an earlier product name so a rename does not silently sign
  // the user out. No-op once the current home holds anything.
  try {
    const moved = !app.isPackaged && process.env.DSH_DESKTOP_USER_DATA
      ? { migrated: false }
      : migrateLegacyHome(app.getPath('appData'), dshHome)
    if (moved.migrated) {
      recordLog('out', `migrated harness home from ${moved.from} (${moved.files} files)`)
      console.log(`[dsh-desktop] migrated ${moved.files} files from ${moved.from}`)
    }
  } catch (error) {
    recordLog('err', `home migration skipped: ${error.message}`)
  }

  const win = existingWindow() || createWindow()
  await showLoading(win)

  const entry = resolveHarnessEntry(process.resourcesPath, app.isPackaged)
  if (!fs.existsSync(entry)) {
    await showFatal('Harness runtime is missing', `Expected the harness entry at:\n${entry}`)
    return
  }

  // The profile carries our composition delta (notably the authorization seam).
  // The install anchor detects the app being moved or updated, which invalidates
  // the absolute symlink farm the harness maintains under profiles/node_modules.
  // A deliberately empty default root: never the user's home, and never inside
  // $DSH_HOME (which holds credentials and the boot-evaluated patch file).
  const workspaceRoot = path.join(app.getPath('userData'), 'workspace-default')
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })

  const profile = ensureProfile(dshHome, path.dirname(entry), resolveDesktopPlugins())
  if (profile.relinked) recordLog('out', 'install path changed — rebuilt profile link farm')

  // Author the Dispatch mode into the writable preset root, regenerated from
  // the shipped Standard composition every launch so it tracks upstream.

  try {
    const started = await startHost({
      entry,
      profile: profile.name,
      dshHome,
      // SECURITY: the harness derives its sandbox root from cwd —
      // dsh-base sets `sandbox-policy.workspaceRoot: !!js process.cwd()` with
      // mode 'workspace-write'. Launching in the user's home therefore granted
      // the agent write access to the WHOLE home directory, including $DSH_HOME
      // (the plaintext credential file) and $DSH_HOME/cordis.patch.yml, whose
      // !!js values are evaluated at boot — turning one prompt injection into
      // persistent code execution. We launch inside a dedicated, empty scratch
      // root instead; the in-app workspace picker grants real project access
      // explicitly, per folder.
      cwd: workspaceRoot,
      onLog: (stream, line) => recordLog(stream, line, 'host'),
      onMessage: (message, child) => {
        if (message?.type === 'dsh:diagnostic') {
          const tool = String(message.tool || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
          diagnostics.write('error', `tool:${tool}`, message.message || 'Tool call failed')
          return
        }
        void computerUse.receive(message, child)
      },
      onDisconnect: child => computerUse.disconnect(child),
      onExit: (code, signal, tail) => {
        hostChild = null
        hostUrl = null
        hostCapability = null
        // quitting: the app is shutting down. restartingHost: WE stopped this
        // host to replace it (the reopen fallback), so its exit is expected —
        // reporting it as an unexpected crash would flash a false modal over a
        // routine restart.
        if (quitting || restartingHost) return
        const plan = crashRestartPlan(consecutiveCrashes)
        consecutiveCrashes += 1
        if (plan.action === 'retry') {
          recordLog('err', `host exited (${code}${signal ? ' ' + signal : ''}); restarting in ${plan.delayMs}ms`)
          const shown = existingWindow()
          if (shown) void showLoading(shown)
          crashRestartTimer = setTimeout(() => {
            crashRestartTimer = null
            if (quitting) return
            void boot().catch((error) => {
              void showFatal('DSH PRO could not start', String(error?.stack || error))
            })
          }, plan.delayMs)
          return
        }
        const log = hostLog.slice(-40).join('\n')
        const detail = [signal && code != null ? 'Signal: ' + signal : null, log, tail]
          .filter(Boolean).join('\n\n') || 'No further detail was reported.'
        void showFatal(unexpectedStopTitle(code, signal), detail)
      },
    })
    hostChild = started.child
    hostUrl = started.url
    hostLaunchUrl = started.launchUrl
    hostCapability = started.capability
    consecutiveCrashes = 0
    recordLog('out', `host ready at ${started.url}`)
    // The user can close the loading window while the host is still booting.
    // The host came up fine and stays tracked, so this is not a failure —
    // loading into a destroyed window throws and used to surface a false
    // "Could not start the harness" box. Leave the host up; a Dock click
    // reattaches to it.
    if (win.isDestroyed()) {
      recordLog('out', 'loading window closed during boot; host stays up for reopen')
      return
    }
    await revealBootedHost(win, started.url, started.launchUrl)
    console.log(`[dsh-desktop] window loaded ${started.url}`)

    // Tell the user when a newer build is on the server. Light by design:
    // a banner in the app and a "Get it" button that opens the download site —
    // no download, no auto-install. Failures are silent. The poll + IPC handler
    // are set up once per process; the banner is attached to THIS window (and to
    // every reopened one) so a close/reopen never loses it.
    startUpdateChecks({
      currentVersion: app.getVersion(),
      openExternal: (u) => { shell.openExternal(u).catch(() => {}) },
      ipcMain,
      recordLog,
    })
    attachUpdateBanner(win)
    console.log(`[dsh-desktop] capture-enabled=${devtools.enabled()} holo=${Boolean(captureEnv('HOLO'))}`)

    if (captureEnv('PREVIEW')) {
      setTimeout(async () => {
        // Open an existing session so the view switcher renders, then flip to Preview.
        const opened = await devtools.openSessionByTitle(win, captureEnv('PREVIEW'))
        console.log('[dsh-desktop] session opened:', opened)
        await new Promise((r) => setTimeout(r, 3000))
        console.log('[dsh-desktop] views:', JSON.stringify(await devtools.probeViews(win)))
        const clicked = await devtools.clickByText(win, 'Preview')
        console.log('[dsh-desktop] preview clicked:', clicked)
        await new Promise((r) => setTimeout(r, 1800))
        console.log('[dsh-desktop] capture:', await devtools.capture(win, 'preview'))
        if (captureEnv('PREVIEW_URL')) {
          const chip = captureEnv('PREVIEW_URL')
          console.log('[dsh-desktop] preview chip:', await devtools.clickByText(win, chip))
          await new Promise((r) => setTimeout(r, 4000))
          console.log('[dsh-desktop] preview frame:', JSON.stringify(await devtools.probePreviewFrame(win)))
          console.log('[dsh-desktop] capture:', await devtools.capture(win, 'preview-live'))
        }
        if (captureEnv('POPOVERS')) {
          // The rounded-right-side rule clips the main column; prove the
          // popovers that live near it are portalled out of it.
          for (const label of String(captureEnv('POPOVERS')).split('|')) {
            console.log(`[dsh-desktop] popover ${label}:`,
              JSON.stringify(await devtools.probePopoverClipping(win, label)))
            await devtools.capture(win, `popover-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`)
            // The only automation in this file that does not go through
            // devtools, so it needs the gate restated rather than inherited.
            if (devtools.enabled()) await win.webContents.executeJavaScript('document.body.click()').catch(() => {})
            await new Promise((r) => setTimeout(r, 800))
          }
        }
      }, Number(captureEnv('DELAY') || 16000) + 4000)
    }

    if (captureEnv('HOLO')) {
      setTimeout(async () => {
        await devtools.setHolo(win, { holo: true, dark: true })
        // Wait for the theme to be APPLIED, not just requested — capturePage
        // otherwise returns the pre-repaint frame and the screenshot shows the
        // stock theme while every probe reports the holo one.
        console.log('[dsh-desktop] holo applied:', await devtools.waitForHolo(win, { dark: true }))
        console.log('[dsh-desktop] capture:', await devtools.capture(win, 'holo-dark'))
        console.log('[dsh-desktop] holo:', JSON.stringify(await devtools.probeHolo(win)))
        console.log('[dsh-desktop] sidebar hover:', JSON.stringify(await devtools.probeSidebarHover(win)))
        console.log('[dsh-desktop] selectors:', JSON.stringify(await devtools.probeSelectors(win), null, 1))
        console.log('[dsh-desktop] strip(holo-dark):', JSON.stringify(await devtools.probeTrafficStrip(win), null, 1))
        console.log('[dsh-desktop] unthemed:', JSON.stringify(await devtools.probeUnthemedSurfaces(win), null, 1))
        console.log('[dsh-desktop] center fill:', JSON.stringify(await devtools.probeCenterFill(win), null, 1))
        console.log('[dsh-desktop] moving edge:', JSON.stringify(await devtools.probeMovingEdge(win)))
        console.log('[dsh-desktop] capture:', await devtools.capture(win, 'holo-dark-b'))
        await devtools.setHolo(win, { holo: true, dark: false })
        console.log('[dsh-desktop] holo applied:', await devtools.waitForHolo(win, { dark: false }))
        console.log('[dsh-desktop] capture:', await devtools.capture(win, 'holo-light'))
        await devtools.setHolo(win, { holo: false, dark: true })
      }, Number(captureEnv('DELAY') || 16000) + 3000)
    }

    if (process.env.DSH_DESKTOP_TEST_REOPEN) {
      // Self-test for the reattach path: close the window, then fire the same
      // 'activate' the Dock click produces. A correct pass logs ONE host pid
      // throughout; the pre-fix behavior booted a second harness here.
      setTimeout(() => {
        const pid = hostChild?.pid
        console.log(`[dsh-desktop] test-reopen: host pid ${pid}, closing window`)
        mainWindow?.close()
        setTimeout(() => {
          app.emit('activate')
          setTimeout(() => {
            console.log(`[dsh-desktop] test-reopen: after reopen host pid ${hostChild?.pid}, `
              + `same=${hostChild?.pid === pid}, windows=${BrowserWindow.getAllWindows().length}`)
          }, 6000)
        }, 1500)
      }, 8000)
    }

    if (devtools.enabled()) {
      // The SPA paints after load resolves; give it a beat before measuring.
      const delay = Number(captureEnv('DELAY') || 4000)
      setTimeout(async () => {
        console.log('[dsh-desktop] bounds:', JSON.stringify(await devtools.probeBounds(win)))
        console.log('[dsh-desktop] probe:', await devtools.probeChrome(win))
        console.log('[dsh-desktop] capture:', await devtools.capture(win, 'home'))
        console.log('[dsh-desktop] footer:', JSON.stringify(await devtools.probeFooter(win), null, 1))
        console.log('[dsh-desktop] drag regions:', JSON.stringify(await devtools.probeDragRegions(win)))
        for (const label of ['Settings', 'New Session']) {
          console.log(`[dsh-desktop] region ${label}:`, JSON.stringify(await devtools.probeAppRegion(win, label)))
        }
        console.log('[dsh-desktop] hero:', JSON.stringify(await devtools.probeHero(win), null, 1))
        // What the native menu can still reach. Cheap, read-only, and the only
        // check that catches a View menu quietly emptied by an upstream rename.
        if (captureEnv('ACTIONS')) {
          const session = captureEnv('SESSION')
          if (session) console.log('[dsh-desktop] session opened:', await devtools.openSessionByTitle(win, session))
          await new Promise((r) => setTimeout(r, 2500))
          console.log('[dsh-desktop] menu actions:', JSON.stringify(await devtools.probeMenuActions(win), null, 1))
        }
        // Drive a non-chat view before the settings probes, so click-blocking
        // that only appears once a view occupant is mounted is reproduced
        // rather than missed by probing a freshly booted Chat pane.
        if (captureEnv('MODES')) {
          const opened = await devtools.openSessionByTitle(win, captureEnv('MODES'))
          console.log('[dsh-desktop] session:', opened)
          await new Promise((r) => setTimeout(r, 2500))
          console.log('[dsh-desktop] mode picker:', await devtools.openModePicker(win))
          await new Promise((r) => setTimeout(r, 1200))
          console.log('[dsh-desktop] capture:', await devtools.capture(win, 'modes'))
        }

        if (captureEnv('SEED')) {
          // "key=value" pairs, comma separated, applied before the view opens.
          for (const pair of String(captureEnv('SEED')).split(',')) {
            const eq = pair.indexOf('=')
            if (eq <= 0) continue
            console.log(`[dsh-desktop] seed ${pair.slice(0, eq)}:`,
              await devtools.seedStorage(win, pair.slice(0, eq), pair.slice(eq + 1)))
          }
        }

        // Gallery shots sit on a dark card, so they are captured in the app's
        // dark theme; a light screenshot on a dark card reads as a paste-up.
        if (captureEnv('DARK')) {
          console.log('[dsh-desktop] dark:', await devtools.setHolo(win, { holo: false, dark: true }))
          await new Promise((r) => setTimeout(r, 1500))
        }

        if (captureEnv('VIEW')) {
          const session = captureEnv('SESSION')
          if (session) console.log('[dsh-desktop] session opened:', await devtools.openSessionByTitle(win, session))
          await new Promise((r) => setTimeout(r, 2500))
          for (const label of String(captureEnv('VIEW')).split('|')) {
            // Retry: a tree row does not exist until its directory listing has
            // arrived, so a single click can land before the target is drawn.
            let hit = false
            for (let attempt = 0; attempt < 8 && !hit; attempt++) {
              hit = await devtools.clickByText(win, label)
              if (!hit) await new Promise((r) => setTimeout(r, 700))
            }
            console.log(`[dsh-desktop] view ${label}:`, hit)
            await new Promise((r) => setTimeout(r, 2200))
            console.log('[dsh-desktop] composer:', JSON.stringify(await devtools.probeComposer(win)))
            // The exact action a user takes next: reach for Settings from here.
            console.log('[dsh-desktop] hit Settings:', JSON.stringify(await devtools.probeClickTarget(win, 'Settings')))
            console.log('[dsh-desktop] capture:', await devtools.capture(win, `view-${label.toLowerCase()}`))
          }
        }

        if (captureEnv('SETTINGS')) {
          console.log('[dsh-desktop] settings opened:', await devtools.openSettings(win))
          await new Promise((r) => setTimeout(r, 4000))
          // Hit-testing, not clicking: a nav cell can render perfectly and still
          // be unreachable because something transparent is stacked over it, and
          // openSettingsTab's .click() would sail straight past that.
          for (const label of ['General', 'Usage', 'Accounts', 'Workspaces', 'Models', 'About']) {
            console.log(`[dsh-desktop] hit ${label}:`, JSON.stringify(await devtools.probeClickTarget(win, label)))
          }
          let tab = false
          for (let attempt = 0; attempt < 5 && !tab; attempt++) {
            tab = await devtools.openSettingsTab(win, 'Accounts')
            if (!tab) await new Promise((r) => setTimeout(r, 800))
          }
          console.log('[dsh-desktop] accounts tab:', tab)
          // Poll until the SSE-hydrated cards render, rather than a fixed wait —
          // the skeleton was being captured before state arrived.
          let panel = null
          for (let attempt = 0; attempt < 12; attempt++) {
            panel = await devtools.probeAccounts(win)
            if (panel && Array.isArray(panel.cards) && panel.cards.length > 0) break
            await new Promise((r) => setTimeout(r, 800))
          }
          console.log('[dsh-desktop] accounts panel:', JSON.stringify(panel, null, 2))
          console.log('[dsh-desktop] dialog:', JSON.stringify(await devtools.probeDialog(win), null, 1))
          console.log('[dsh-desktop] settings nav:', JSON.stringify(await devtools.probeSettingsNav(win), null, 1))
          console.log('[dsh-desktop] grid:', JSON.stringify(await devtools.probeGrid(win)))
          console.log('[dsh-desktop] capture:', await devtools.capture(win, 'accounts'))
          // After the accounts capture: switching tabs first meant the accounts
          // screenshot was actually the Usage page.
          if (captureEnv('USAGE')) {
            console.log('[dsh-desktop] usage tab:', await devtools.openSettingsTab(win, 'Usage'))
            await new Promise((r) => setTimeout(r, 2500))
            console.log('[dsh-desktop] capture:', await devtools.capture(win, 'settings-usage'))
          }
          if (captureEnv('ALL_TABS')) {
            // Every settings surface in one run, so the whole panel can be
            // judged as a set rather than a tab at a time.
            for (const tabName of ['General', 'Accounts', 'Workspaces', 'Models',
              'Plugins', 'Agent presets', 'About']) {
              const opened = await devtools.openSettingsTab(win, tabName)
              await new Promise((r) => setTimeout(r, 2200))
              const slug = tabName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
              console.log(`[dsh-desktop] tab ${tabName}: ${opened} -> `
                + await devtools.capture(win, `settings-${slug}`))
            }
          }
          if (captureEnv('TAB')) {
            const tabName = captureEnv('TAB')
            console.log(`[dsh-desktop] ${tabName} tab:`, await devtools.openSettingsTab(win, tabName))
            await new Promise((r) => setTimeout(r, 2200))
            console.log('[dsh-desktop] capture:', await devtools.capture(win, tabName.toLowerCase()))
            if (tabName === 'Workspaces') {
              console.log('[dsh-desktop] ws groups:',
                JSON.stringify(await devtools.probeWorkspaceGroups(win)))
            }
          }
          if (captureEnv('GENERAL')) {
            console.log('[dsh-desktop] general tab:', await devtools.openSettingsTab(win, 'General'))
            await new Promise((r) => setTimeout(r, 1500))
            console.log('[dsh-desktop] capture:', await devtools.capture(win, 'general'))
          }
          if (captureEnv('MODELS')) {
            console.log('[dsh-desktop] models tab:', await devtools.openSettingsTab(win, 'Models'))
            await new Promise((r) => setTimeout(r, 2500))
            console.log('[dsh-desktop] capture:', await devtools.capture(win, 'models'))
          }
          if (captureEnv('ABOUT')) {
            console.log('[dsh-desktop] about tab:', await devtools.openSettingsTab(win, 'About'))
            await new Promise((r) => setTimeout(r, 1500))
            console.log('[dsh-desktop] about:', JSON.stringify(await devtools.probeAbout(win)))
            console.log('[dsh-desktop] license bridge:', JSON.stringify(await devtools.probeLicenseBridge(win)))
            console.log('[dsh-desktop] capture:', await devtools.capture(win, 'about'))
          }
          if (captureEnv('SIGNIN')) {
            console.log('[dsh-desktop] signin click:', await devtools.clickByText(win, captureEnv('SIGNIN')))
            await new Promise((r) => setTimeout(r, 3000))
            console.log('[dsh-desktop] capture:', await devtools.capture(win, 'signin'))
          }
        }
      }, delay)
    }
  } catch (error) {
    await showFatal('Could not start the harness', `${error.message}\n\n${hostLog.slice(-30).join('\n')}`)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // Focus an existing window if there is one; otherwise (macOS: the user
    // closed the window but the app stayed alive) a second launch should bring
    // the app back, not silently do nothing. Same reattach-or-boot as activate.
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      return
    }
    if (hostAlive() && hostUrl) void reopenWindow()
    else void boot().catch((error) => {
      void showFatal('DSH PRO could not start', String(error?.stack || error))
    })
  })

  registerNoticeHandler()
  registerFatalHandler()
  registerResetHandler()
  registerPhoneAccessHandler()
  registerComputerUseHandler()
  registerDevelopmentSetupHandler()
  registerNotifyHandler()
  registerMenuStateHandler()
  registerSessionsHandler()
  guardWebContents()

  app.whenReady().then(() => {
    // The harness serves no CSP of its own. Stamp one onto every response from
    // the host origin: same-origin scripts plus the inline __DSH_BOOT__ injection
    // the host renders into index.html, same-origin fetch/WebSocket, and nothing
    // remote — so a compromised or confused page cannot pull outside code into
    // the window that fronts an agent with shell access.
    guardDefaultSession()
    guardPreviewPartition()

    const CSP = [
      "default-src 'self'",
      // 'unsafe-eval' is required: the harness's own frontend evaluates strings
      // (verified — a strict policy throws EvalError at boot and the app never
      // paints). The valuable protections survive: no remote script can load,
      // no remote endpoint can be reached, nothing can frame or be framed.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' blob:",
      "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*",
      // Governs only the Preview view's <iframe> FALLBACK (webviewTag off).
      // The real <webview> guest is not an iframe and is not subject to this
      // policy; the degraded iframe path stays loopback-only by design.
      "frame-src 'self' http://127.0.0.1:* http://localhost:*",
      "worker-src 'self' blob:",
      "object-src 'none'",
      // Upstream 0.2 emits <base href="host origin/">. Permit that origin only;
      // a workspace or injected page still cannot redirect relative URLs off-host.
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders }
      if (isHostUrl(details.url)) {
        // A plugin route may declare its own policy on top of this one — the
        // files byte route sends `sandbox` so that a workspace SVG or HTML
        // file, if it is ever framed or navigated to rather than drawn into an
        // <img>, runs in an opaque origin instead of this one. Two CSP headers
        // are enforced as an intersection, so carrying both is strictly more
        // restrictive than either; replacing the list outright would silently
        // drop the stricter of the two.
        const declared = []
        for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
          if (name.toLowerCase() !== 'content-security-policy') continue
          declared.push(...(Array.isArray(value) ? value : [value]))
        }
        headers['Content-Security-Policy'] = [CSP, ...declared]
      }
      callback({ responseHeaders: headers })
    })

    applyDockIcon()

    // The tray is a standing answer, so it has to exist before the page has
    // published anything. attachTray draws an empty menu immediately; the first
    // dsh:sessions-state replaces it. symbolName is the fallback if the PNG
    // cannot be read - an SF Symbol, macOS only, documented as being for a
    // native Menu (electron.d.ts:9894). With neither, the tray declines to exist
    // rather than putting a zero-width gap in the menu bar.
    trayHost = attachTray({
      Tray,
      Menu,
      nativeImage,
      iconPath: path.join(__dirname, 'assets', 'trayTemplate.png'),
      symbolName: 'apple.terminal',
      openApp: focusApp,
      openSession: (id) => {
        focusApp()
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
        if (win) win.webContents.send('dsh:open-session', id)
      },
      quit: () => { app.quit() },
      productName: PRODUCT_NAME,
    })

    // The app-menu About box is a native panel, and it shows stock Electron
    // details unless told otherwise — the one place a curious user looks for
    // "what is this" and finds someone else's framework.
    app.setAboutPanelOptions({
      applicationName: PRODUCT_NAME,
      applicationVersion: app.getVersion(),
      version: harnessVersion() ? `DeepSeek Harness ${harnessVersion()}` : '',
      credits: 'Enhanced desktop client built on DeepSeek Harness. '
        + 'Not affiliated with, endorsed by, or an official release of DeepSeek '
        + 'or DeepSeek Harness. Made by Byte Forward.',
      copyright: '© 2026 Byte Forward · MIT licensed',
    })

    diagnostics.write('info', 'app', `DSH PRO ${app.getVersion()} started on ${process.platform}/${process.arch}`)
    buildMenu({ productName: PRODUCT_NAME, onOpenExternal: openExternalIfAllowed, onRevealDiagnostics: revealDiagnosticLog })

    // A rejection here used to vanish: `void boot()` discards it, so a failure
    // before the window paints left the app sitting with a spinner and no way
    // to learn why. Route it to the same fatal screen every other boot failure
    // uses.
    void boot().catch((error) => {
      void showFatal('DSH PRO could not start', String(error?.stack || error))
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length !== 0) return
      if (hostAlive() && hostUrl) void reopenWindow()
      else void boot().catch((error) => {
        void showFatal('DSH PRO could not start', String(error?.stack || error))
      })
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // A renderer that dies leaves a white window with no explanation. Reload it
  // against the host we already know is running; a crash on a page we can
  // simply re-fetch does not deserve a fatal screen. But a page that crashes ON
  // load would reload-crash-reload forever — so cap consecutive reloads and, if
  // it keeps dying, stop and say so rather than spin. The counter resets once a
  // window has stayed up a while (crashes more than 30s apart are unrelated).
  const rendererReloads = new Map() // webContents.id -> { count, last }
  app.on('render-process-gone', (_event, contents, details) => {
    recordLog('err', `renderer gone: ${details.reason}`)
    // Nothing is publishing menu state any more, so nothing may stay disabled.
    resetMenuState()
    if (details.reason === 'clean-exit' || !hostUrl) return
    const win = BrowserWindow.fromWebContents(contents)
    if (!win || win.isDestroyed()) return
    const now = Date.now()
    const rec = rendererReloads.get(contents.id) || { count: 0, last: 0 }
    if (now - rec.last > 30_000) rec.count = 0
    rec.count += 1
    rec.last = now
    rendererReloads.set(contents.id, rec)
    if (rec.count > 3) {
      recordLog('err', `renderer crashed ${rec.count}x in a row; not reloading`)
      void showFatal('The window keeps crashing',
        `The app window stopped responding ${rec.count} times in a row (${details.reason}).\n\n`
        + 'Quit and reopen DSH PRO. If it keeps happening, reset the app from Settings.')
      return
    }
    void seedCapabilityCookie().then(() => win.loadURL(hostLaunchUrl || hostUrl))
  })

  // Anything that escapes to the top level should say so rather than leaving a
  // half-dead app on screen. These are the handlers of last resort — every
  // path that can be handled locally already is.
  process.on('uncaughtException', (error) => {
    recordLog('err', `uncaught: ${error?.stack || error}`)
    void showFatal('DSH PRO hit an unexpected error', String(error?.stack || error))
  })
  process.on('unhandledRejection', (reason) => {
    recordLog('err', `unhandled rejection: ${reason}`)
    void showFatal('DSH PRO hit an unexpected error', String(reason))
  })

  app.on('before-quit', async (event) => {
    if (trayHost !== null) { try { trayHost.destroy() } catch {} ; trayHost = null }
    // Nothing spawned yet (quit before or during earliest boot) → let it quit.
    // Otherwise stop EVERY child we spawned, including one still mid-boot that
    // was never assigned to hostChild — quitting on a slow boot must not orphan
    // the harness.
    if (quitting || (!hostChild && !hasLiveHosts())) return
    quitting = true
    event.preventDefault()
    // Close the LAN door first, and synchronously. The harness gets up to 8s
    // to shut down below, and for all of it the proxy was still listening and
    // still forwarding to a harness being torn down.
    if (phoneAccess !== null) { try { phoneAccess.stop() } catch {}; phoneAccess = null }
    // Hide first. The harness is deliberately given up to 8s to shut down
    // cleanly (its own reaper needs that long to kill detached Bash trees), but
    // a window that sits on screen for eight seconds after Cmd+Q reads as a
    // hang. Hiding makes the app *feel* quit while the child still gets its
    // full, necessary budget.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.hide()
    }
    developmentSetup?.cancel()
    await computerUse.control('disable').catch(() => {})
    await stopAllHosts()
    hostChild = null
    app.quit()
  })
}
