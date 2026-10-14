/**
 * Passive subscription-usage observer.
 *
 * pi-ai 0.82.1 exposes no usage or quota data — its typed surface recognises
 * only a `rate_limit_exceeded` error after a request has already failed
 * (verified against the extracted tarball). But the ChatGPT/Codex backend
 * REPORTS usage on every response it sends, as `x-codex-*` headers, and every
 * one of those responses already passes through this process. Wrapping global
 * fetch and reading headers off in-flight traffic gives a usage readout that is
 * based on reported limits. The separate active reader fills in ChatGPT plan
 * limits before the first model request; this observer complements those reads.
 *
 * The wrapper is strictly read-only: the response object is returned untouched
 * (headers are metadata; reading them does not consume the body stream), and a
 * throw anywhere in the harvest path must never break the request it rode on.
 *
 * Known header set (as sent to the Codex CLI):
 *   x-codex-primary-used-percent          rolling-window usage, 0..100
 *   x-codex-primary-window-minutes        the window's length
 *   x-codex-primary-reset-after-seconds   seconds until the window resets
 *   x-codex-secondary-*                   the longer companion window
 */

const CODEX_HOSTS = new Set(['chatgpt.com', 'api.openai.com'])

/**
 * xAI's completions API sends standard-shaped x-ratelimit-* headers. They are
 * OBSERVED behaviour, not a documented contract — docs.x.ai points at the
 * console instead — so this harvest treats absence as normal and never
 * invents a denominator: no limit header, no snapshot.
 */
const XAI_HOSTS = new Set(['api.x.ai'])

/** provider id -> latest snapshot. One entry per provider that ever reported. */
const snapshots = new Map()
const generations = new Map()
export const usageGeneration = provider => generations.get(provider) || 0

let installed = false
let notify = () => {}

function num (headers, name) {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** One window {usedPercent, ...} from a limit/remaining header pair, or null. */
function windowFromPair (headers, limitName, remainingName, resetName) {
  const limit = num(headers, limitName)
  const remaining = num(headers, remainingName)
  if (limit === undefined || remaining === undefined || limit <= 0) return null
  const used = Math.min(limit, Math.max(0, limit - remaining))
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    resetAfterSeconds: num(headers, resetName),
  }
}

function harvestXai (headers) {
  // Two families, one bar: the binding constraint is whichever window is more
  // used, and showing the other as secondary keeps both facts visible.
  const tokens = windowFromPair(headers,
    'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens')
  const requests = windowFromPair(headers,
    'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests')
  if (!tokens && !requests) return
  const ordered = [tokens, requests].filter(Boolean)
    .sort((a, b) => b.usedPercent - a.usedPercent)
  recordSnapshot('xai', { primary: ordered[0], secondary: ordered[1] })
}

/**
 * Commit a snapshot and fan it out. The shape both cards render from is
 * { provider, observedAt, primary: { usedPercent, ... }, secondary? } —
 * usedPercent is the one REQUIRED field; a snapshot without it would earn an
 * account a blank row, so callers must not submit one.
 */
export function recordSnapshot (provider, snapshot) {
  const complete = { ...snapshot, provider, observedAt: Date.now() }
  if (![complete.primary, complete.secondary, ...(complete.additional || []).flatMap(x => [x.primary, x.secondary])].some(w => Number.isFinite(w?.usedPercent))) return
  snapshots.set(provider, complete)
  notify(complete)
}

/**
 * Gated on DSHD_USAGE_DEBUG. Usage harvesting is invisible when it fails — the
 * card just keeps saying "no usage yet" — so there has to be a way to see what
 * the observer is actually being handed without guessing.
 */
function debugObserved (host, headers) {
  if (!process.env.DSHD_USAGE_DEBUG) return
  const names = []
  try { for (const [name] of headers) names.push(name) } catch { /* not iterable */ }
  const interesting = names.filter((n) => /ratelimit|codex|usage|quota|limit|remain|reset/i.test(n))
  console.log(`[usage-observer] ${host} :: ${interesting.length ? interesting.join(', ') : 'no usage-shaped headers'} (${names.length} total)`)
}

function harvest (url, headers) {
  let host
  try { host = new URL(url).hostname } catch { return }
  debugObserved(host, headers)
  if (XAI_HOSTS.has(host)) return harvestXai(headers)
  if (!CODEX_HOSTS.has(host)) return
  const primary = num(headers, 'x-codex-primary-used-percent')
  if (primary === undefined) return
  const snapshot = {
    provider: 'openai-codex',
    observedAt: Date.now(),
    primary: {
      usedPercent: Math.min(100, Math.max(0, primary)),
      windowMinutes: num(headers, 'x-codex-primary-window-minutes'),
      resetAfterSeconds: num(headers, 'x-codex-primary-reset-after-seconds'),
    },
    secondary: (() => {
      const used = num(headers, 'x-codex-secondary-used-percent')
      if (used === undefined) return undefined
      return {
        usedPercent: Math.min(100, Math.max(0, used)),
        windowMinutes: num(headers, 'x-codex-secondary-window-minutes'),
        resetAfterSeconds: num(headers, 'x-codex-secondary-reset-after-seconds'),
      }
    })(),
  }
  const previous = snapshots.get('openai-codex')
  if (previous?.source === 'account' && Date.now() - previous.observedAt < 5 * 60_000) return
  recordSnapshot('openai-codex', snapshot)
}

/**
 * Install the wrapper once per process. Returns an uninstaller that restores
 * the previous fetch only when nothing wrapped it after us.
 */
export function installUsageObserver (onUpdate) {
  notify = onUpdate ?? (() => {})
  if (installed) return () => {}
  installed = true
  const original = globalThis.fetch
  const wrapped = function fetchWithUsageObserver (input, init) {
    const result = original.call(this, input, init)
    return result.then((response) => {
      try {
        const url = typeof input === 'string' ? input : (input?.url ?? String(input))
        harvest(url, response.headers)
      } catch {
        // Observation must never fail the request it observed.
      }
      return response
    }, (error) => { throw error })
  }
  globalThis.fetch = wrapped
  return () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = original
    installed = false
    notify = () => {}
  }
}

/** Latest snapshot per provider, for the state read. */
export function usageSnapshots () {
  return Object.fromEntries(snapshots)
}

/**
 * Drop a provider's usage snapshot.
 *
 * Snapshots are keyed by provider id, not by account, and the observer is
 * re-attached to whatever account connects next. Without this, signing out of
 * a ChatGPT account at 93% used and signing in with a fresh one showed the new
 * account "93% used" — in the red state, on both the Accounts card and the
 * sidebar — until its first request happened to carry a usage header. Wrong
 * data, asserted confidently, which is worse than no data.
 */
export function forgetUsage (provider) {
  generations.set(provider, usageGeneration(provider) + 1)
  snapshots.delete(provider)
}

export function recordUsageFailure(provider) {
  const previous = snapshots.get(provider)
  const snapshot = { ...previous, provider, observedAt: previous?.observedAt ?? null, source: 'account', status: previous ? 'stale' : 'unavailable' }
  snapshots.set(provider, snapshot)
  notify(snapshot)
}
