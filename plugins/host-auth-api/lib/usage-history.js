/**
 * Durable usage, read from the session logs.
 *
 * The header observer in `usage-observer.js` can only ever report what a vendor
 * volunteers on its own responses, and exactly one vendor does: ChatGPT sends
 * `x-codex-*`. Kimi, Grok and OpenRouter send nothing usage-shaped, so a user
 * working on those models watched the card say "usage appears after your first
 * message" forever, however many messages they sent. That was the bug.
 *
 * The harness already records the real numbers. Every session is a durable
 * JSONL log (zstd-framed) under $DSH_HOME/sessions/<workspace>/<session>/, and
 * each turn writes:
 *
 *   request/header    { config: { provider, model } }   which model ran
 *   assistant/chunk   { chunk: { type:'usage', usage:{ inputTokens,
 *                       outputTokens, cacheReadTokens } } }
 *   turn/start|end    timestamps
 *
 * So this reads the source of truth instead of a vendor's courtesy header. It
 * is provider-agnostic by construction, it is retrospective (usage from before
 * this feature existed is already on disk), and it carries the model identity
 * and the timestamp that a breakdown and a heat map need.
 *
 * What it deliberately does NOT do is claim a quota. Tokens spent is a fact;
 * "62% of your plan" is not derivable from a session log, and the plan meter
 * stays the header/poll observer's job.
 */

import { readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { readUsageLog, MAX_LOG_BYTES } from './usage-log.js'
import { setImmediate } from 'node:timers/promises'
import { createSessionUsage, UsageAccumulator, summarizeRows } from './usage-projection.js'
import { UsageSummaryCache } from './usage-cache.js'

/** Re-reading every log on every request would make the settings page crawl. */
const cache = new UsageSummaryCache()
const scans = new Map()

function sessionsRoot () {
  const home = process.env.DSH_HOME
  return home ? join(home, 'sessions') : null
}

/** Every session log on disk, as {file, mtimeMs, sessionId}. */
async function listLogs (root, coverage, signal) {
  signal?.throwIfAborted()
  if (!root) { coverage.unavailable += 1; return [] }
  const logs = []
  let workspaces
  try { workspaces = await readdir(root, { withFileTypes: true }) } catch (error) { if (error.code !== 'ENOENT') coverage.unavailable += 1; return [] }

  for (const workspace of workspaces) {
    signal?.throwIfAborted()
    if (!workspace.isDirectory()) { if (workspace.isSymbolicLink()) coverage.unavailable += 1; continue }
    const workspaceDir = join(root, workspace.name)
    let sessions
    try { sessions = await readdir(workspaceDir, { withFileTypes: true }) } catch { coverage.unavailable += 1; continue }
    for (const session of sessions) {
      signal?.throwIfAborted()
      if (!session.isDirectory()) { if (session.isSymbolicLink()) coverage.unavailable += 1; continue }
      const dir = join(workspaceDir, session.name)
      let files
      try { files = await readdir(dir) } catch { coverage.unavailable += 1; continue }
      const artifacts = files.filter(name => name === 'session.jsonl' || name === 'session.jsonl.zstd')
      if (artifacts.length > 1) { coverage.skipped += artifacts.length; coverage.issues.ambiguous += 1; continue }
      for (const name of artifacts) {
        const file = join(dir, name)
        try {
          const info = await lstat(file)
          if (!info.isFile()) { coverage.skipped += 1; coverage.issues.unreadable += 1; continue }
          if (info.size > MAX_LOG_BYTES) { coverage.skipped += 1; coverage.issues.oversized += 1; continue }
          logs.push({ file, mtimeMs: info.mtimeMs, size: info.size, sessionId: session.name })
        } catch { coverage.skipped += 1; coverage.issues.unreadable += 1 }
      }
    }
  }
  return logs
}

async function readSession (log, signal) {
  const session = createSessionUsage(log.sessionId)
  const decoded = await readUsageLog(log.file, {signal, onEvent:session.accept})
  signal?.throwIfAborted()
  return {rows:session.rows,invalidUsage:session.invalidUsage,issue:decoded.issue}
}

const emptyCoverage = () => ({complete:false,read:0,partial:0,skipped:0,unavailable:0,
  issues:{oversized:0,unreadable:0,corrupt:0,truncated:0,ambiguous:0,invalidUsage:0}})

/** The explicit rows API still returns all calls; it does not retain them in a cache. */
export async function collectUsage ({signal} = {}) {
  const logs = await listLogs(sessionsRoot(), emptyCoverage(), signal)
  const rows = []
  for (const log of logs) {
    const session = await readSession(log, signal)
    for (let i=0;i<session.rows.length;i++) {
      if (i % 512 === 0) { await setImmediate(); signal?.throwIfAborted() }
      rows.push(session.rows[i])
    }
  }
  signal?.throwIfAborted()
  return rows
}

/**
 * The shape the Usage page renders: totals, a per-model breakdown, a per-day
 * series for the heat map, and the busiest hours.
 */
export async function usageSummary ({signal} = {}) {
  signal?.throwIfAborted()
  // Share only work in flight, keyed by the captured profile. The next refresh
  // must inspect disk again, including incomplete logs whose metadata is stable.
  const root = sessionsRoot()
  let scan = scans.get(root)
  if (!scan) {
    scan = { controller: new AbortController(), readers: 0, settled: false }
    scans.set(root, scan)
    scan.promise = Promise.resolve().then(() => summarize(root, scan.controller.signal))
    const settled = () => {
      scan.settled = true
      if (scans.get(root) === scan) scans.delete(root)
    }
    scan.promise.then(settled, settled)
  }
  scan.readers++
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (fn, value) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      scan.readers--
      fn(value)
    }
    const abort = () => {
      finish(reject, signal.reason)
      if (!scan.readers && !scan.settled) {
        // Detach before aborting: an immediate reopen must start fresh rather
        // than join an abandoned scan that is still finishing an I/O operation.
        if (scans.get(root) === scan) scans.delete(root)
        scan.controller.abort()
      }
    }
    signal?.addEventListener('abort', abort, {once:true})
    scan.promise.then(value => finish(resolve, value), error => finish(reject, error))
  })
}

async function summarize (root, signal) {
  const coverage = emptyCoverage()
  const logs = await listLogs(root, coverage, signal)
  signal?.throwIfAborted()
  const liveFiles = new Set(logs.map(log => log.file))
  for (const file of cache.keys()) if (!liveFiles.has(file)) cache.delete(file)
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone ?? process.env.TZ ?? ''
  const accumulator = new UsageAccumulator()
  const pending = []
  // Consume cache hits before admitting new entries. Otherwise a full scan
  // larger than the cache would evict every hit before reaching it.
  for (const log of logs) {
    signal?.throwIfAborted()
    const hit = cache.get(log.file)
    if (hit && hit.mtimeMs === log.mtimeMs && hit.size === log.size && hit.zone === zone) {
      await accumulator.merge(hit.summary, log.sessionId, signal)
      coverage.read++
    } else {
      cache.delete(log.file)
      pending.push(log)
    }
  }
  for (const log of pending) {
    const session = await readSession(log, signal)
    const summary = await summarizeRows(session.rows, signal)
    signal?.throwIfAborted()
    await accumulator.merge(summary, log.sessionId, signal)
    if (!session.issue && !session.invalidUsage) {
      cache.set(log.file, {mtimeMs:log.mtimeMs,size:log.size,zone,summary})
      coverage.read++
    } else {
      if (session.issue) coverage.issues[session.issue]++
      if (session.invalidUsage) coverage.issues.invalidUsage++
      if (summary.totals.turns) coverage.partial++
      else coverage.skipped++
    }
  }
  signal?.throwIfAborted()
  coverage.complete = coverage.partial === 0 && coverage.skipped === 0 && coverage.unavailable === 0
  return {...accumulator.summary(),coverage}
}
