import { settingsNamespace, settingsAccess } from './settings-access.js'

/**
 * Native support for local model servers — Ollama and LM Studio.
 *
 * Both expose an OpenAI-compatible endpoint on a well-known loopback port, and
 * the llm-pi-ai settings schema can declare a fully custom route (baseURL, api,
 * headers, models) — so no catalog change and no new protocol is needed. This
 * module is only the glue neither side ships:
 *
 *   detect   — probe the two well-known ports (a 600ms local connect).
 *   declare  — when a server answers, write its route into `llm-pi-ai`
 *              settings with the models it actually serves, so they appear in
 *              the model picker beside the cloud accounts.
 *   retract  — when the server is gone, remove the route again — but ONLY if
 *              every key of the stored profile is one this module wrote. A
 *              profile the user edited (their own baseURL, extra models,
 *              anything) is never touched, same contract as declare.js.
 *
 * Auth: neither server checks credentials, but pi-ai's OpenAI-compatible
 * protocol insists on an Authorization header — so the route carries a fixed
 * `Bearer local` header and stays entirely out of the credentials seam. No
 * key is stored anywhere because none exists.
 */

const NS = 'llm-pi-ai'

/** Route ids, chosen to read well everywhere a provider id leaks into the UI. */
export const LOCAL_SERVERS = [
  {
    id: 'ollama',
    displayName: 'Ollama',
    origin: 'http://127.0.0.1:11434',
    baseURL: 'http://127.0.0.1:11434/v1',
    hint: 'ollama serve',
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio',
    origin: 'http://127.0.0.1:1234',
    baseURL: 'http://127.0.0.1:1234/v1',
    hint: 'Developer tab → Start server',
  },
]

/** Keys this module ever writes into a route profile; the retract fence. */
const AUTO_WRITTEN_KEYS = ['displayName', 'api', 'baseURL', 'headers', 'models']

/** Sane floors for models whose server does not report a context length. */
const FALLBACK_CONTEXT = 8192
const OUTPUT_BUDGET = 4096

const timedFetch = (url, init = {}, signal) => {
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(600)
  return fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
}
const validId = value => typeof value === 'string' && value.trim().length > 0
const DETAIL_CONCURRENCY = 4

/** Skip embedding models — they cannot hold a conversation. */
const isEmbedding = (id) => /embed/i.test(id)

/**
 * What is Ollama serving right now?
 * `/api/tags` lists installed models; `/api/show` names each one's context
 * window (model_info["<arch>.context_length"]). Show failures degrade to the
 * fallback context rather than dropping the model.
 * @returns {Promise<null | Array<{id: string, name: string, contextWindow: number}>>}
 */
async function probeOllama (origin, signal) {
  let listed
  try {
    const res = await timedFetch(`${origin}/api/tags`, {}, signal)
    if (!res.ok) return null
    listed = (await res.json())?.models
  } catch { signal?.throwIfAborted(); return null }
  signal?.throwIfAborted()
  if (!Array.isArray(listed)) return null
  const models = [...new Set(listed.map(m => m?.name).filter(name => validId(name) && !isEmbedding(name)))]
  const detailed = new Array(models.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, models.length) }, async () => {
    while (cursor < models.length) {
      signal?.throwIfAborted()
      const index = cursor++, name = models[index]
      let contextWindow = FALLBACK_CONTEXT
      try {
        const res = await timedFetch(`${origin}/api/show`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name }),
        }, signal)
        if (res.ok) {
          const info = (await res.json())?.model_info ?? {}
          const key = Object.keys(info).find(k => k.endsWith('.context_length'))
          const value = key === undefined ? undefined : Number(info[key])
          if (Number.isSafeInteger(value) && value > 0) contextWindow = value
        }
      } catch { signal?.throwIfAborted(); /* ordinary detail failures use the fallback */ }
      signal?.throwIfAborted()
      detailed[index] = { id: name, name, contextWindow }
    }
  }))
  return detailed
}

/**
 * What is LM Studio serving right now?
 * `/api/v0/models` (LM Studio 0.3+) reports type and max_context_length; the
 * plain `/v1/models` list is the fallback for older builds, with the fallback
 * context window.
 * @returns {Promise<null | Array<{id: string, name: string, contextWindow: number}>>}
 */
async function probeLmStudio (origin, signal) {
  try {
    const res = await timedFetch(`${origin}/api/v0/models`, {}, signal)
    if (res.ok) {
      const data = (await res.json())?.data
      if (Array.isArray(data)) {
        const seen = new Set()
        return data
          .filter((m) => (m?.type === 'llm' || m?.type === 'vlm') && validId(m?.id) && !isEmbedding(m.id))
          .filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true })
          .map((m) => ({
            id: m.id,
            name: m.id,
            contextWindow: Number.isSafeInteger(m?.max_context_length) && m.max_context_length > 0
              ? m.max_context_length
              : FALLBACK_CONTEXT,
          }))
      }
    }
  } catch { signal?.throwIfAborted(); /* fall through to /v1/models */ }
  try {
    const res = await timedFetch(`${origin}/v1/models`, {}, signal)
    if (!res.ok) return null
    const data = (await res.json())?.data
    if (!Array.isArray(data)) return null
    return [...new Set(data.map(m => m?.id).filter(id => validId(id) && !isEmbedding(id)))]
      .map((id) => ({ id, name: id, contextWindow: FALLBACK_CONTEXT }))
  } catch { signal?.throwIfAborted(); return null }
}

/** The fixed, non-model fields this module always writes for a server. */
function canonicalFields (server) {
  return {
    displayName: server.displayName,
    api: 'openai-completions',
    baseURL: server.baseURL,
    headers: { Authorization: 'Bearer local' },
  }
}

/**
 * True only when this profile is one we own AND still holds the exact config we
 * wrote — no key we do not write, and every non-model field unchanged. The
 * previous test accepted ANY profile whose keys were all ours, so a user who
 * edited a VALUE (pointed baseURL at a remote Ollama, renamed the route, changed
 * the auth header) still looked "ours" and had that edit silently overwritten or
 * retracted on the next 20s pass. Now such an edit makes the profile theirs and
 * off-limits; only the model list, which legitimately tracks the server, stays
 * ours to refresh.
 */
export function isOurs (server, profile) {
  if (typeof profile !== 'object' || profile === null) return false
  if (!Object.keys(profile).every((key) => AUTO_WRITTEN_KEYS.includes(key))) return false
  const canon = canonicalFields(server)
  return profile.displayName === canon.displayName
    && profile.api === canon.api
    && profile.baseURL === canon.baseURL
    && JSON.stringify(profile.headers) === JSON.stringify(canon.headers)
}

/** The route profile a detection turns into. */
function profileFor (server, models) {
  return {
    displayName: server.displayName,
    api: 'openai-completions',
    baseURL: server.baseURL,
    // Neither server validates auth, but the OpenAI protocol implementation
    // requires an Authorization header to consider the route configured.
    headers: { Authorization: 'Bearer local' },
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      contextWindow: m.contextWindow,
      maxTokens: Math.min(OUTPUT_BUDGET, m.contextWindow),
    })),
  }
}

/** Deep-enough equality for the profiles this module writes. */
function sameProfile (a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Re-read ownership after every conflict rather than replaying a stale decision. */
async function syncProfile (settings, server, models, signal) {
  if (!settings || typeof settings.describe !== 'function' || typeof settings.section !== 'function') return 'settings-unavailable'
  const next = models?.length ? profileFor(server, models) : null
  for (let retry = 0; retry < 3; retry++) {
    signal?.throwIfAborted()
    const snapshot = settings.describe({ redactSecrets: true }).find(entry => entry.ns === NS)
    if (!snapshot || !Number.isSafeInteger(snapshot.revision)) return 'settings-unavailable'
    // Raw keys establish ownership; redaction can hide user-added secret fields.
    const existing = settings.section(settingsNamespace(NS))?.providers?.[server.id]
    if (existing !== undefined && !isOurs(server, existing)) return 'user-managed'
    if (next && existing !== undefined && sameProfile(existing, next)) return 'declared'
    if (!next && existing === undefined) return models === null ? 'absent' : 'no-models'
    try {
      signal?.throwIfAborted()
      await settings.mutate(settingsNamespace(NS), [next
        ? { op: 'set', path: ['providers', server.id], value: next }
        : { op: 'unset', path: ['providers', server.id] }], snapshot.revision)
      signal?.throwIfAborted()
      return next ? 'declared' : 'retracted'
    } catch (error) {
      signal?.throwIfAborted()
      if (error?.code === 'SETTINGS_CONFLICT' && retry < 2) continue
      throw error
    }
  }
}

/** Scan one server independently so a long inventory cannot block its sibling. */
async function syncServer (ctx, state, server, signal) {
  signal?.throwIfAborted()
  const models = server.id === 'ollama'
    ? await probeOllama(server.origin, signal)
    : await probeLmStudio(server.origin, signal)
  signal?.throwIfAborted()
  const next = {
    up: models !== null,
    displayName: server.displayName,
    hint: server.hint,
    baseURL: server.baseURL,
    models: models?.map(m => m.id) || [],
  }
  let settings
  try { settings = ctx.get?.('settings') } catch { settings = undefined }
  try {
    next.sync = await syncProfile(settings, server, models, signal)
  } catch (error) {
    signal?.throwIfAborted()
    next.sync = `failed: ${error?.message}`
    ctx.logger?.warn?.(`local models: sync of ${server.id} failed: ${error?.message}`)
  }
  signal?.throwIfAborted()
  state[server.id] = next
}

/** One pass; the optional lifetime signal withdraws probes and future writes. */
export async function syncLocalModels (ctx, state, { signal } = {}) {
  await Promise.all(LOCAL_SERVERS.map(server => syncServer(ctx, state, server, signal)))
  return state
}

/**
 * Install the periodic reconciler.
 * @returns {{ state: object, dispose: () => void }} the live snapshot the
 * /local-models route serves, and the teardown.
 */
export function installLocalModels (ctx, intervalMs = 20_000) {
  const state = {}
  const running = new Set()
  const lifetime = new AbortController()
  const pass = async server => {
    if (running.has(server.id) || lifetime.signal.aborted) return
    running.add(server.id)
    try { await syncServer(ctx, state, server, lifetime.signal) }
    catch (error) { if (!lifetime.signal.aborted) ctx.logger?.warn?.(`local models: scan failed: ${error?.message}`) }
    finally { running.delete(server.id) }
  }
  const scan = () => { for (const server of LOCAL_SERVERS) void pass(server) }
  scan()
  const timer = setInterval(scan, intervalMs)
  return { state, dispose: () => { clearInterval(timer); lifetime.abort() } }
}
