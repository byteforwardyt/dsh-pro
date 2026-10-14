'use strict'
/**
 * Supervises the DeepSeek Harness host as a child of the Electron main process.
 *
 * The harness is a Node program. Electron's own binary can run it by setting
 * ELECTRON_RUN_AS_NODE=1, which avoids shipping a second Node runtime — but two
 * launch details are load-bearing and were established empirically (see
 * docs/PHASE0-FINDINGS.md):
 *
 *   --expose-internals  cordis-plugin-hmr requires ctx.loader.internal. Node
 *                       normally supplies it through the node-addon-require-builtin
 *                       N-API addon, which refuses to run under Electron's embedded
 *                       V8 ("no compatible GetAlignedPointerFromEmbedderData symbol").
 *                       The flag is the only remaining route. Disabling the hmr row
 *                       instead does NOT work: profile-boot mints a replacement HMR
 *                       entry whenever ctx.get('hmr') is undefined, which throws the
 *                       same way.
 *   --port 0            Asks the OS for a free port. Hardcoding 3080 collides with a
 *                       `dsh web` the user may already be running.
 *   --no-open           Suppresses the harness's detached `open` child, which would
 *                       otherwise launch the user's browser onto the same URL.
 */

const { spawn, execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const net = require('node:net')
const path = require('node:path')
const readline = require('node:readline')

/**
 * The PATH a double-clicked .app inherits, and why it has to be repaired.
 *
 * Finder and the Dock launch through launchd, which hands the process a bare
 * `/usr/bin:/bin:/usr/sbin:/sbin`. A terminal launch inherits the user's real
 * PATH instead, so this is invisible during development and total in the
 * shipped app: that PATH flows through the harness into every `bash -c` the
 * agent runs, as a non-login non-interactive shell that never sources
 * ~/.zprofile. `npm install` becomes "command not found". So do pnpm, brew,
 * cargo, go, gh, rg — and node itself for anyone using nvm, asdf, volta or
 * fnm, which is most people. Git and coreutils keep working, so the failure
 * reads as a bad model rather than a bad launch environment.
 *
 * Hardcoding /opt/homebrew/bin is the tempting fix and the wrong one: it misses
 * every version-manager shim. Ask the user's own login shell instead, once, and
 * cache it.
 */
let cachedPath = null

function loginShellPath () {
  if (cachedPath !== null) return cachedPath
  cachedPath = ''
  const shell = process.env.SHELL
  // A shell we cannot identify is not worth guessing at.
  if (!shell || !path.isAbsolute(shell)) return cachedPath
  try {
    // -i is deliberate alongside -l: version managers commonly install their
    // shims from ~/.zshrc (interactive) rather than ~/.zprofile (login).
    //
    // killSignal:'SIGKILL' is what makes the timeout real. spawnSync's default
    // is SIGTERM, and an INTERACTIVE shell ignores SIGTERM by design — so the
    // 5s bound was decorative. Measured: `-lc` returns at ~3004ms against a
    // 3000ms timeout, while `-ilc` blocks 15-30s and only then throws. This
    // call is synchronous on the Electron main process, after the loading
    // window is already painted, so a slow rc file (nvm/conda/asdf on a cold
    // FS, or an MDM check against an unreachable VPN host) froze the whole app
    // — menu bar, Cmd-Q and the 90s ready timeout all dead, spinner still
    // turning because it animates in another process. An rc file that blocks
    // forever meant an app that never started and could only be force-quit.
    //
    // The `-l` fallback below is not just for correctness: if the interactive
    // shell has to be killed, the login-only shell usually still answers.
    const probe = (args) => execFileSync(shell, args, {
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    // A sentinel, because `printf %s` emits no trailing newline: a zsh TRAPEXIT
    // hook or a banner without one concatenates straight onto the PATH, and the
    // result still looks path-shaped. Reproduced with a real rc file — the
    // first entry came back as "welcome back" glued onto the PATH entry. Slice after
    // the sentinel instead of trusting the last line.
    const SENTINEL = '__DSH_PATH__'
    const script = `printf %s "${SENTINEL}$PATH"`

    let out = ''
    try {
      out = probe(['-ilc', script])
    } catch (interactiveError) {
      out = probe(['-lc', script])
    }

    const marker = String(out).lastIndexOf(SENTINEL)
    const value = marker >= 0 ? String(out).slice(marker + SENTINEL.length).trim() : ''
    // Sanity-check the shape rather than trusting whatever the rc file echoed.
    if (value && value.includes('/') && !value.includes('\u0000')) cachedPath = value
  } catch (error) {
    // Degrades to the inherited PATH — exactly the pre-fix baseline, never
    // worse. Logged rather than swallowed: this is silent by nature, and the
    // shells it fails on (fish, nu, csh, tcsh, which have no `-ilc` and treat
    // $PATH as a list) would otherwise give a user broken tooling with nothing
    // anywhere to explain it.
    console.log(`[dsh-desktop] could not read PATH from ${shell}: ${error.message}. `
      + 'Falling back to the inherited PATH; tools installed by a version manager may not be found.')
  }
  return cachedPath
}

/**
 * Merge the login-shell PATH in front of the inherited one.
 *
 * Union rather than replace: the inherited PATH can carry entries the login
 * shell does not (Electron's own bundled helpers), and dropping them silently
 * would trade one broken-tooling bug for another.
 */
function resolvedPath () {
  const discovered = loginShellPath()
  if (!discovered) return process.env.PATH || ''
  const seen = new Set()
  return [...discovered.split(':'), ...String(process.env.PATH || '').split(':')]
    .filter((entry) => entry && !seen.has(entry) && seen.add(entry))
    .join(':')
}

/**
 * The harness prints exactly one line of this shape once the tree has settled.
 *
 * Not anchored at the end: when the configured host is 0.0.0.0 the harness
 * appends a "(LAN: http://<ip>:<port>)" suffix, and the strict anchor missed
 * the whole line — producing a 90-second hang and a "did not report a URL"
 * message blaming a boot failure that never happened. Only the loopback URL is
 * captured; the LAN address is deliberately not what this window loads.
 */
const READY_LINE = /^dsh web:\s*(http:\/\/127\.0\.0\.1:\d+(?:\/\?token=[A-Za-z0-9_-]+)?)(?=\s|$)/

/** Give the host this long to print its URL before treating the launch as failed. */
const READY_TIMEOUT_MS = 90_000

/**
 * Locate the harness CLI entry.
 *
 * In development it resolves out of the workspace's node_modules. In a packaged
 * app the staged closure lives beside the asar under Resources/harness, because
 * the profile healer writes real symlinks into it and the native .node binaries
 * must be real files on disk.
 */
function resolveHarnessEntry (resourcesPath, isPackaged) {
  if (isPackaged) {
    return path.join(resourcesPath, 'harness', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
  return require.resolve('@deepseek-ai/dsh/lib/bin.js')
}

/**
 * Start the harness and resolve once it reports its URL.
 *
 * Also mints this run's API capability. The harness's HTTP surface is reachable
 * by any process on the machine — its header fence is a CSRF defence and cannot
 * tell an app window from a stray curl — so the desktop shell issues a secret
 * here, passes it to the harness in the environment, and seeds the same value
 * as a cookie into the window's session before the window loads. Only the
 * window (and the paired phone proxy, which is handed the secret explicitly)
 * can then reach routes that read the workspace or run commands.
 *
 * It is minted per start rather than persisted: nothing outlives the process
 * that needs to know it, and a fresh one per launch means a leaked value stops
 * being useful at quit.
 *
 * @returns {Promise<{url: string, port: number, capability: string, child: import('node:child_process').ChildProcess}>}
 */
/**
 * A stable port for the harness, derived from $DSH_HOME.
 *
 * `--port 0` gave a fresh OS-assigned port every launch, which made the
 * renderer's ORIGIN different every launch — and localStorage is keyed by
 * origin, so every preference the web app stores (preview URL, last file,
 * pinned theme) silently reset on relaunch. Hashing the install-unique
 * $DSH_HOME into a fixed high range gives each install one habitual port;
 * verifying it is actually free before use keeps the old behaviour as the
 * fallback rather than a collision. A second copy of the app is already
 * excluded by the single-instance lock, so the realistic collision is some
 * unrelated service, which the probe detects.
 */
function preferredPort (dshHome) {
  let hash = 0
  const text = String(dshHome || '')
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return 41300 + (Math.abs(hash) % 2000)
}

function portIsFree (port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close(() => resolve(true))
    })
  })
}

/**
 * Environment variables that put code inside a process before its first line
 * runs, or redirect where its code comes from.
 *
 * This matters here more than in an ordinary child process. The harness is
 * spawned from this same signed binary with `ELECTRON_RUN_AS_NODE=1`, so it
 * really is Node: `NODE_OPTIONS=--require /tmp/x.js` is honoured, and
 * `NODE_PATH` and `NODE_REPL_EXTERNAL_MODULE` redirect module resolution. On
 * macOS `launchctl setenv` sets any of them for every process the user later
 * launches, persistently and without a prompt, so one write turns into code
 * running inside the process that holds the user's provider credentials — and
 * it survives reinstalling the app, because nothing about the app is involved.
 *
 * Denied by class rather than by name. Naming today's variables would age
 * badly: Node has added loader hooks more than once. Everything we actually
 * need from these namespaces is set back explicitly at the spawn.
 */
const INJECTION_PREFIXES = ['NODE_', 'ELECTRON_', 'DYLD_']

/**
 * Two loader variables that are not covered by a prefix worth banning whole.
 * `LD_LIBRARY_PATH` is deliberately NOT here: the Linux AppImage sets it for
 * its own runtime, and native modules in the child load through it.
 */
const INJECTION_NAMES = ['LD_PRELOAD', 'LD_AUDIT']

/**
 * One documented exception to the `NODE_` ban.
 *
 * It names a PEM file of extra trust anchors and cannot execute anything, and
 * dropping it breaks TLS for anyone behind a corporate proxy in a way that is
 * miserable to diagnose. Someone who can already set this variable can add a
 * trust anchor by easier routes, so refusing it buys almost nothing and costs a
 * real class of user their network.
 */
const ENV_EXCEPTIONS = ['NODE_EXTRA_CA_CERTS']

/**
 * The inherited half of the harness child's environment.
 *
 * Everything the user exported survives except the loader variables above,
 * because the agent shells out through this environment — `HOME`,
 * `SSH_AUTH_SOCK`, `LANG`, toolchain roots and the rest are load-bearing for
 * the commands people actually run, and an allowlist would quietly break them.
 *
 * The visible cost is that a user who exports `NODE_OPTIONS` for their own
 * builds no longer has it inside the app's terminal. That is the intended
 * trade: the same variable is the injection vector, and there is no way to
 * honour one and refuse the other.
 *
 * @param {NodeJS.ProcessEnv} [source] - defaults to this process's environment.
 */
function inheritedEnv (source = process.env) {
  const env = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (ENV_EXCEPTIONS.includes(name)) { env[name] = value; continue }
    if (INJECTION_NAMES.includes(name)) continue
    if (INJECTION_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    env[name] = value
  }
  return env
}

/**
 * Every harness child currently alive, tracked from the instant it is spawned —
 * NOT from when it reports ready. The caller only learns the child through the
 * resolved promise, which can be up to READY_TIMEOUT_MS (90s) later; a Cmd+Q in
 * that window (the natural response to a slow boot) found `hostChild` still null
 * and quit without ever killing the child, orphaning a harness that then bound
 * the install's stable port and forced the next launch onto a fresh origin —
 * silently resetting every origin-keyed preference. stopAllHosts() closes that
 * gap: before-quit stops whatever we have spawned, ready or not.
 */
const liveHosts = new Set()

/** Stop every spawned harness child, whether or not it finished booting. */
function stopAllHosts (timeoutMs = 8000) {
  return Promise.all([...liveHosts].map((child) => stopHost(child, timeoutMs)))
}

/** Whether any spawned harness child is still running. */
function hasLiveHosts () {
  for (const child of liveHosts) {
    if (child.exitCode === null && child.signalCode === null) return true
  }
  return false
}

async function startHost ({ entry, profile, dshHome, cwd, onLog, onExit, onMessage, onDisconnect }) {
  const stablePort = preferredPort(dshHome)
  const port = (await portIsFree(stablePort)) ? String(stablePort) : '0'
  const capability = crypto.randomBytes(32).toString('hex')
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // Launcher flags first; the first token the launcher does not recognize
      // begins the web app's own arguments (--port / --no-open belong to it).
      ['--expose-internals', entry, '--profile', profile, '--port', port, '--no-open'],
      {
        cwd,
        env: {
          ...inheritedEnv(),
          // Repaired before anything else: every tool the agent shells out to
          // is found through this.
          PATH: resolvedPath(),
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HOME: dshHome,
          // The harness reads this to decide whether to auto-open a browser on
          // some paths; belt and braces alongside --no-open.
          DSH_WEB_MODE: 'desktop',
          DSH_COMPUTER_BRIDGE: onMessage ? '1' : '0',
          // Read by the plugins' shared trust fence. Its absence is what keeps
          // `dsh web` usable straight from a terminal, so this is the only
          // place that turns the capability on.
          DSHPRO_API_TOKEN: capability,
          // Kimi moved its account frontend from kimi.com to kimi.ai. pi-ai
          // 0.82.1 still defaults its Kimi device flow to auth.kimi.com, whose
          // API answers but whose verification page (www.kimi.com/code/
          // authorize_device) is dead — sign-in dead-ends there. pi-ai reads
          // this env var to override the OAuth host, so the whole flow, the
          // approval page included, lands on kimi.ai. Verified against the
          // device_authorization endpoint: .com returns a www.kimi.com
          // verification_uri, .ai returns www.kimi.ai. Preserved on process.env
          // so a user who already exported it is not overridden.
          KIMI_CODE_OAUTH_HOST: process.env.KIMI_CODE_OAUTH_HOST || 'https://auth.kimi.ai',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    )

    // Track it now, at spawn, so quit-time cleanup can reach it during the whole
    // boot window — not only after it reports ready.
    liveHosts.add(child)
    child.once('exit', () => liveHosts.delete(child))
    child.on('message', message => onMessage?.(message, child))
    child.once('disconnect', () => onDisconnect?.(child))

    let settled = false
    const stderrTail = []

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Escalate exactly like stopHost: a child stuck in a blocking call ignores
      // SIGTERM, and because this promise REJECTS, the caller never learns the
      // pid — nothing else will ever clean it up.
      void stopHost(child)
      reject(new Error(
        `The harness did not report a URL within ${READY_TIMEOUT_MS / 1000}s.\n\n${stderrTail.join('\n')}`,
      ))
    }, READY_TIMEOUT_MS)

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      onLog?.('out', line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]'))
      const match = READY_LINE.exec(line)
      if (!match || settled) return
      settled = true
      resolvedReady = true
      clearTimeout(timer)
      const url = match[1]
      resolve({ url: new URL(url).origin, launchUrl: url, port: Number(new URL(url).port), capability, child })
    })

    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      line = line.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')
      onLog?.('err', line)
      // Keep a bounded tail so a failure report carries the real cause.
      stderrTail.push(line)
      if (stderrTail.length > 40) stderrTail.shift()
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    let resolvedReady = false
    child.on('exit', (code, signal) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(
          `The harness exited before it was ready (code ${code}, signal ${signal}).\n\n${stderrTail.join('\n')}`,
        ))
        return
      }
      // Only a host that actually became ready reports its death upward; the
      // timed-out child's eventual exit is old news the caller already handled.
      if (resolvedReady) onExit?.(code, signal, stderrTail.join('\n'))
    })
  })
}

/**
 * Ask the host to stop, escalating to SIGKILL if it ignores the request.
 *
 * The default sits deliberately OUTSIDE the harness's own shutdown deadline
 * (PROCESS_SHUTDOWN_TIMEOUT_MS = 5000). It used to be 4000 — strictly inside —
 * which meant a dispose that ran long was always force-killed before the
 * harness could finish. That matters because dsh-subprocess-local spawns the
 * agent's Bash trees `detached: true`, in their own process groups, and reaps
 * them from a `process.on('exit')` handler that only runs on the harness's own
 * force-exit at 5s. Killing at 4s destroyed the reaper along with its chance to
 * run, so quitting mid-build left `npm run build` writing into the user's
 * project and holding its port after DSH PRO had left the Dock.
 */
function stopHost (child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const kill = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      resolve()
    }, timeoutMs)
    child.once('exit', () => { clearTimeout(kill); resolve() })
    try { child.kill('SIGTERM') } catch { clearTimeout(kill); resolve() }
  })
}

module.exports = { resolvedPath, startHost, stopHost, stopAllHosts, hasLiveHosts, resolveHarnessEntry, inheritedEnv, READY_LINE }
