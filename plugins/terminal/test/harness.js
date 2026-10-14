/**
 * Shared fixtures for the terminal plugin's tests.
 *
 * These tests drive REAL shells. A terminal whose defects only show up against
 * a live process is a terminal whose tests have to start one: every defect
 * these files cover was reported from a running build and none of them is
 * visible to a mocked stdin.
 */

import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'

/**
 * A faithful stand-in for the subprocess seam.
 *
 * Detached, so the child owns its own process group and terminate() is
 * process-GROUP scoped exactly as the real seam is — not tree-scoped, and the
 * difference is the whole subject of teardown.test.js. A double that killed
 * the tree would make every escapee test pass for free. Same
 * SIGTERM -> graceMs -> SIGKILL escalation too, because a double that only
 * ever sent SIGTERM would call a survivor dead.
 */
export function subprocessSeam () {
  return {
    async resolveExecutable (name) {
      for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
        const full = join(dir, name)
        if (existsSync(full)) return full
      }
      throw new Error('not found: ' + name)
    },
    spawn ({ argv, cwd, stdio, env, graceMs = 3000 }) {
      const child = spawn(argv[0], argv.slice(1), {
        cwd,
        detached: true,
        env: { ...process.env, ...env },
        stdio: ['stdin', 'stdout', 'stderr'].map((key) => (stdio[key] === 'pipe' ? 'pipe' : 'ignore')),
      })
      const done = new Promise((resolve) => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })))
      // A spawn that never started still has to settle. Without this a failed
      // spawn raises 'error' with no listener, which node turns into an
      // uncaught exception in whichever test happened to be running.
      child.on('error', () => {})
      let escalation = null
      const signalTree = (name) => {
        try { process.kill(-child.pid, name) } catch {
          try { child.kill(name) } catch { /* already gone */ }
        }
      }
      done.then(() => clearTimeout(escalation), () => {})
      return {
        pid: child.pid,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done,
        collected: {},
        terminate () {
          signalTree('SIGTERM')
          if (escalation) return
          escalation = setTimeout(() => signalTree('SIGKILL'), graceMs)
          escalation.unref?.()
        },
        async waitForExit () { await done; return true },
      }
    },
  }
}

export function fixtureContext (roots) {
  return {
    workspaceRegistry: {
      list: () => roots.map((entry, index) => ({ id: index + 1, path: entry, title: basename(entry) })),
    },
    subprocess: subprocessSeam(),
    logger: { warn () {} },
    tools: { register () {} },
    on () {},
    webServer: { register () { return () => {} } },
  }
}

/** A workspace root that is a real, realpath-resolved directory. */
export function workspace () {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dsh-terminal-')))
}

/**
 * /bin/sh with -s sources no profile, so a test measures the plugin and not
 * whatever the developer's .zprofile prints on startup.
 */
export function plainShell (path = '/bin/sh') {
  const previous = process.env.SHELL
  process.env.SHELL = path
  return () => {
    if (previous === undefined) delete process.env.SHELL
    else process.env.SHELL = previous
  }
}

/** A response double that records what the route actually put on the wire. */
export function response () {
  const chunks = []
  return {
    statusCode: null,
    headers: null,
    destroyed: false,
    ended: false,
    writeHead (status, headers) { this.statusCode = status; this.headers = headers; return this },
    write (chunk) { chunks.push(chunk); return true },
    end (chunk) { if (chunk) chunks.push(chunk); this.ended = true },
    // Real: the stream route drops a socket that stops draining, and a double
    // without this threw "res.destroy is not a function" from inside the
    // route's own error path, where it read as a passing test.
    destroy () { this.destroyed = true; this.ended = true },
    once () {}, off () {},
    get body () { return chunks.join('') },
    get json () { return JSON.parse(chunks.join('')) },
  }
}

/**
 * A request double. `pieces` are delivered as separate Buffers, which is the
 * only way to reproduce a body split across socket reads.
 */
export function request (method, url, headers, pieces) {
  const stream = Readable.from(pieces === undefined ? [] : pieces)
  return Object.assign(stream, { method, url, headers })
}

export const trusted = { host: '127.0.0.1:1234', 'content-type': 'application/json' }

/** Fail loudly rather than hanging a test runner on a shell that never answers. */
export function deadline (promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for ' + what)), ms).unref()),
  ])
}

export async function until (check, ms, what) {
  const stop = Date.now() + ms
  for (;;) {
    const now = await check()
    if (now) return now
    if (Date.now() > stop) throw new Error('timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

/**
 * Every live process descended from `root`, by parent link.
 *
 * A test that asks "did the interrupt reach the grandchild" has to look at the
 * process table, because the registry's own view cannot tell a stopped command
 * from one that ignored the signal — which is exactly the confusion the
 * `interrupted` flag used to ship.
 */
export function descendants (root) {
  const rows = processes()
  const found = []
  let frontier = [root]
  while (frontier.length > 0) {
    const children = rows.filter((row) => frontier.includes(row.ppid))
    found.push(...children)
    frontier = children.map((row) => row.pid)
  }
  return found
}

/** Every live process, as ps reports it. */
export function processes () {
  return execFileSync('/bin/ps', ['-Ao', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, pgid, command]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), command }))
}

/** The status a synchronous registry call refused with, or null when it did not. */
export const status = (call) => { try { call() } catch (error) { return error.status } return null }
