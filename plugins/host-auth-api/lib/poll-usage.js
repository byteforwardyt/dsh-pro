/**
 * Active usage polls, for the providers that answer questions instead of
 * volunteering headers.
 *
 * The passive observer stays the preferred source — it can never be wrong
 * about a quota because it only ever repeats what the vendor said on real
 * traffic. Active polls also read the connected ChatGPT plan before its first model call:
 *
 *   - ChatGPT exposes both Codex windows through the same read used by Codex CLI.
 *   - OpenRouter reports spend through `GET /api/v1/key`, documented for
 *     integrators. A bar renders only when the key has a limit; a limitless
 *     key has no denominator and inventing one is worse than showing nothing.
 *   - Kimi's coding-plan quota lives at `/coding/v1/usages`, which usagebar
 *     documents as reverse-engineered and changeable without notice. Treated
 *     accordingly: any surprise in the response shape means no snapshot, and
 *     never an error surfaced to the user.
 *
 * Cadence is owned by the caller (host-auth-api polls only while an SSE
 * stream is open, so a closed app makes no traffic).
 */

import { credentialKeyId } from '@deepseek-ai/dsh-credentials'

import { recordSnapshot } from './usage-observer.js'
import { pollChatgptUsage } from './subscription-usage.js'

const REQUEST_TIMEOUT_MS = 10_000

const signal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS)

/** Map an OpenRouter /api/v1/key payload to a snapshot, or null. Exported for tests. */
export function openrouterSnapshot (payload) {
  const d = payload?.data
  if (!d || typeof d !== 'object') return null
  const limit = d.limit
  const remaining = d.limit_remaining
  if (typeof limit !== 'number' || limit <= 0 || typeof remaining !== 'number') return null
  const used = Math.min(limit, Math.max(0, limit - remaining))
  return {
    primary: { usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)) },
  }
}

/** Map a Kimi /coding/v1/usages payload to a snapshot, or null. Exported for tests. */
export function kimiSnapshot (payload) {
  const usage = payload?.usage
  if (!usage || typeof usage !== 'object') return null
  const limit = usage.limit
  const remaining = usage.remaining
  if (typeof limit !== 'number' || limit <= 0 || typeof remaining !== 'number') return null
  const used = Math.min(limit, Math.max(0, limit - remaining))
  const windowSeconds = payload?.limits?.[0]?.window?.duration
  let resetAfterSeconds
  const reset = usage.resetTime
  if (typeof reset === 'string' || typeof reset === 'number') {
    const at = new Date(reset).getTime()
    if (Number.isFinite(at) && at > Date.now()) resetAfterSeconds = Math.round((at - Date.now()) / 1000)
  }
  return {
    primary: {
      usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
      windowMinutes: typeof windowSeconds === 'number' && windowSeconds > 0
        ? Math.round(windowSeconds / 60)
        : undefined,
      resetAfterSeconds,
    },
  }
}

/** The stored record for a provider, or null. */
async function recordFor (ctx, provider) {
  const entry = ctx.authorization.list().find((e) => credentialKeyId(e.key) === provider)
  if (!entry) return null
  try {
    return await ctx.credentials.readRecord(entry.key) ?? null
  } catch {
    return null
  }
}

async function pollOpenrouter (ctx) {
  const record = await recordFor(ctx, 'openrouter')
  // OpenRouter's OAuth exchange stores a GRANT, not an api-key record —
  // verified against a real credential store, where all four providers land as
  // `kind: grant`. Reading only the api-key shape meant this poll silently
  // never ran. Both shapes are handled: the grant payload is pi-ai's own
  // credential, whose key field naming is not ours to assume, so several
  // plausible names are tried and anything unrecognised simply yields no poll.
  let key = null
  if (record?.kind === 'api-key') {
    key = record.key ?? null
    if (!key && record.env) {
      for (const name of Object.keys(record.env)) {
        if (process.env[name]) { key = process.env[name]; break }
      }
    }
  } else if (record?.kind === 'grant') {
    const payload = record.payload ?? {}
    for (const field of ['key', 'apiKey', 'access', 'accessToken', 'token']) {
      if (typeof payload[field] === 'string' && payload[field]) { key = payload[field]; break }
    }
  }
  if (!key) return
  const response = await fetch('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: signal(),
  })
  if (!response.ok) return
  const snapshot = openrouterSnapshot(await response.json().catch(() => null))
  if (snapshot) recordSnapshot('openrouter', snapshot)
}

async function pollKimi (ctx) {
  const record = await recordFor(ctx, 'kimi-coding')
  // The grant payload is pi-ai's own oauth credential: { access, refresh,
  // expires }. Read-only use of the access token; refresh stays pi-ai's job,
  // so an expired token here simply means no snapshot until the next request
  // refreshes it.
  const access = record?.kind === 'grant' ? record.payload?.access : null
  if (typeof access !== 'string' || !access) return
  if (typeof record.payload?.expires === 'number' && record.payload.expires < Date.now()) return
  // kimi.ai first (the current domain), kimi.com as fallback while the
  // migration is incomplete — the API side of .com still answers.
  for (const host of ['https://api.kimi.ai', 'https://api.kimi.com']) {
    try {
      const response = await fetch(`${host}/coding/v1/usages`, {
        headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
        signal: signal(),
      })
      if (!response.ok) continue
      const snapshot = kimiSnapshot(await response.json().catch(() => null))
      if (snapshot) { recordSnapshot('kimi-coding', snapshot); return }
    } catch {
      // Try the next host; a network failure is not an event.
    }
  }
}

/**
 * One round of every active poll. Failures are silent by design: a usage bar
 * is decoration on top of a working product, and a poll that surfaces errors
 * would invert that priority.
 */
const pending = new WeakMap()
export function pollActiveUsage (ctx, signal) {
  if (pending.has(ctx)) return pending.get(ctx)
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
  const job = Promise.allSettled([pollOpenrouter(ctx), pollKimi(ctx), pollChatgptUsage(ctx, {signal: requestSignal})])
    .finally(() => { if (pending.get(ctx) === job) pending.delete(ctx) })
  pending.set(ctx, job)
  return job
}
