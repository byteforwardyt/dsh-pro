/** ChatGPT's Codex allowance, using the read-only endpoint used by openai/codex.
 * Tokens and account ids stay host-side. No quota purchase/reset operations.
 */
import { credentialKeyId } from '@deepseek-ai/dsh-credentials'
import { catalogAuth } from './model-catalog.js'
import { recordSnapshot, recordUsageFailure, usageGeneration } from './usage-observer.js'

const PROVIDER = 'openai-codex'
const ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage'
const finite = value => typeof value === 'number' && Number.isFinite(value)

function windowSnapshot(value) {
  if (!value || !finite(value.used_percent) || value.used_percent < 0) return undefined
  const window = { usedPercent: Math.min(100, value.used_percent) }
  if (finite(value.limit_window_seconds) && value.limit_window_seconds > 0) window.windowMinutes = Math.ceil(value.limit_window_seconds / 60)
  if (finite(value.reset_at) && value.reset_at > 0) window.resetsAt = value.reset_at * 1000
  else if (finite(value.reset_after_seconds) && value.reset_after_seconds >= 0) window.resetAfterSeconds = value.reset_after_seconds
  return window
}

export function chatgptSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null
  const primary = windowSnapshot(payload.rate_limit?.primary_window)
  const secondary = windowSnapshot(payload.rate_limit?.secondary_window)
  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits.slice(0, 20).flatMap(limit => {
    const primary = windowSnapshot(limit?.rate_limit?.primary_window), secondary = windowSnapshot(limit?.rate_limit?.secondary_window)
    if ((!primary && !secondary) || typeof limit.limit_name !== 'string') return []
    return [{ name: limit.limit_name.slice(0, 100), primary, secondary }]
  }) : []
  if (!primary && !secondary && !additional.length) return null
  return {
    source: 'account', status: 'current', primary, secondary, additional,
    ...(typeof payload.plan_type === 'string' && /^[a-z0-9_-]{1,60}$/i.test(payload.plan_type) ? { planType: payload.plan_type } : {}),
  }
}

async function boundedJSON(response) {
  if (!response.body?.getReader) throw Error('Missing usage response')
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 128 * 1024) throw Error('Oversized usage response')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

export async function pollChatgptUsage(ctx, { signal = AbortSignal.timeout(12_000), authorize = catalogAuth } = {}) {
  const entry = ctx.authorization.list().find(e => credentialKeyId(e.key) === PROVIDER)
  if (!entry) return
  const read = () => ctx.credentials.readRecord(entry.key)
  const initial = await read().catch(() => null)
  if (initial?.kind !== 'grant') return
  let generation = usageGeneration(PROVIDER), access
  try {
    signal.throwIfAborted()
    const auth = await authorize(ctx, PROVIDER, signal)
    access = auth.apiKey
    // Refresh may have updated the credential under its existing lock.
    generation = usageGeneration(PROVIDER)
    const current = await read()
    if (current?.kind !== 'grant' || current.payload?.access !== access) return
    const response = await fetch(ENDPOINT, {
      method: 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${access}`, ...auth.headers, accept: 'application/json', 'User-Agent': 'DSH-PRO' },
    })
    if (!response.ok) { await response.body?.cancel?.(); throw Error('Usage unavailable') }
    const snapshot = chatgptSnapshot(await boundedJSON(response))
    if (!snapshot) throw Error('Unrecognized usage response')
    signal.throwIfAborted()
    const latest = await read()
    if (usageGeneration(PROVIDER) !== generation || latest?.kind !== 'grant' || latest.payload?.access !== access) return
    recordSnapshot(PROVIDER, snapshot)
  } catch {
    if (signal.aborted || usageGeneration(PROVIDER) !== generation) return
    const latest = await read().catch(() => null)
    if (latest?.kind !== 'grant' || (access && latest.payload?.access !== access) || (!access && latest.payload?.access !== initial.payload?.access)) return
    recordUsageFailure(PROVIDER)
  }
}
