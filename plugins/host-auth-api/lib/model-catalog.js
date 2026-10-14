import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, settingsAccess } from './settings-access.js'
import { createModels } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { MODEL_SOURCES, fetchModelCatalog } from './model-catalog-sources.js'

const NS = settingsNamespace('llm-pi-ai')
export const MODEL_REFRESH_MS = 15 * 60_000
const keyFor = provider => credentialKey('llm-pi-ai', provider)
const stable = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
})
const digest = value => createHash('sha256').update(stable(value)).digest('hex')
const fromRecord = record => !record ? undefined : record.kind === 'grant' ? record.payload : { ...record, type: 'api_key' }
const toRecord = value => value.type === 'api_key'
  ? { kind: 'api-key', ...(value.key === undefined ? {} : { key: value.key }), ...(value.env === undefined ? {} : { env: value.env }) }
  : { kind: 'grant', payload: value }

const OAUTH_EXPORTS = { xai: 'xaiOAuth', 'kimi-coding': 'kimiCodingOAuth', 'openai-codex': 'openaiCodexOAuth', openrouter: 'openRouterOAuth' }
async function refreshCredential(provider, credential, signal) {
  // pi-ai 0.82.1's public lazy wrapper drops the signal. Load its pinned
  // implementation to preserve cancellation where the provider supports it.
  const module = await import(new URL(`./auth/oauth/${provider}.js`, import.meta.resolve('@earendil-works/pi-ai')).href)
  signal.throwIfAborted()
  return module[OAUTH_EXPORTS[provider]].refresh(credential, signal)
}

/** Use the library's locked token refresh, sharing the inference record lock. */
export async function catalogAuth(ctx, provider, signal) {
  const native = builtinProviders().find(item => item.id === provider)
  const key = keyFor(provider)
  const store = {
    read: async () => { signal.throwIfAborted(); return fromRecord(await ctx.credentials.readRecord(key)) },
    list: async () => [],
    modify: async (_provider, mutate) => fromRecord(await ctx.credentials.modifyRecord(key, async current => {
      signal.throwIfAborted()
      if (!current) throw new Error('Account was disconnected')
      const next = await mutate(fromRecord(current))
      signal.throwIfAborted()
      return next === undefined ? undefined : toRecord(next)
    })),
    delete: async () => { throw new Error('Discovery cannot remove accounts') },
  }
  const models = createModels({ credentials: store, authContext: {
    env: async name => (await ctx.credentials.resolve?.(credentialRef(name)))?.value ?? process.env[name],
    fileExists: async () => false,
  } })
  models.setProvider({ ...native, auth: { ...native.auth, oauth: native.auth.oauth && {
    ...native.auth.oauth, refresh: credential => refreshCredential(provider, credential, signal),
  } } })
  const result = await models.getAuth(provider)
  signal.throwIfAborted()
  const authorization = Object.entries(result?.auth?.headers || {}).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  const apiKey = result?.auth?.apiKey || (typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined)
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('Account authorization is unavailable')
  const headers = {}
  if (provider === 'openai-codex') {
    try {
      const claims = JSON.parse(Buffer.from(apiKey.split('.')[1], 'base64url').toString('utf8'))
      const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id
      if (typeof accountId === 'string' && /^[a-zA-Z0-9_-]+$/.test(accountId)) headers['ChatGPT-Account-Id'] = accountId
    } catch { /* Some grants do not include an account claim. */ }
  }
  return { apiKey, headers }
}

/** Hash-only write-ahead ownership journal; no tokens or account data on disk. */
async function readJournal(root, provider) {
  if (!root) throw new Error('Model cache storage is unavailable')
  try {
    const raw = await readFile(join(root, `${provider}.json`), 'utf8')
    if (raw.length > 4096) throw new Error('Invalid model cache')
    const data = JSON.parse(raw)
    if (data.version !== 1 || !Array.isArray(data.owned) || data.owned.length > 2 || !data.owned.every(x => /^[a-f0-9]{64}$/.test(x))) throw new Error('Invalid model cache')
    return data
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, owned: [] }
    throw error
  }
}
async function writeJournal(root, provider, value) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const temp = join(root, `.${provider}-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temp, join(root, `${provider}.json`))
  } finally { await rm(temp, { force: true }).catch(() => {}) }
}
function automatic(profile, journal, provider) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return false
  if (journal.owned.includes(digest(profile))) return true
  return Object.keys(profile).every(key => key === 'displayName')
    && (profile.displayName === undefined || profile.displayName === MODEL_SOURCES[provider].name)
}
function snapshot(ctx, provider) {
  const settings = settingsAccess(ctx)
  const revision = settings?.describe?.({ redactSecrets: true }).find(item => item.ns === NS)?.revision
  if (!Number.isSafeInteger(revision)) throw new Error('Model settings are unavailable')
  return { settings, revision, profile: settings.section(NS)?.providers?.[provider] }
}

/**
 * Auto-owned profiles only. Journal candidates are durable BEFORE a settings
 * mutation so a crash cannot turn our model list into a frozen custom profile.
 * Recheck ownership on every namespace CAS conflict; never overwrite user edits.
 */
async function publish(ctx, root, provider, models, signal, remove = false) {
  let journal = await readJournal(root, provider)
  for (let retry = 0; retry < 3; retry++) {
    signal.throwIfAborted()
    const { settings, revision, profile } = snapshot(ctx, provider)
    if (!automatic(profile, journal, provider)) return 'custom'
    if (remove && !profile.models) return 'unchanged'
    const next = remove
      ? { ...(profile.displayName === undefined ? {} : { displayName: profile.displayName }) }
      // OpenRouter's bundled catalog spans protocols. Newly discovered ids
      // cannot infer one from that mixed catalog, so our owned route declares
      // the same Chat Completions protocol used by its discovery source.
      : { ...profile, ...(['xai', 'openrouter'].includes(provider) ? { api: MODEL_SOURCES[provider].api } : {}), models }
    const owned = [...new Set([digest(profile), digest(next)])]
    journal = { version: 1, owned, checkedAt: remove ? journal.checkedAt : Date.now(), count: models?.length ?? journal.count }
    await writeJournal(root, provider, journal)
    signal.throwIfAborted()
    // Credential reads occur before taking a fresh revision, and sign-out
    // waits for this job. No async ownership gap can overwrite a custom edit.
    try {
      if (digest(profile) !== digest(next)) {
        await settings.mutate(NS, [{ op: 'set', path: ['providers', provider], value: next }], revision)
      }
      signal.throwIfAborted()
      return 'updated'
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT' && retry < 2) continue
      throw error
    }
  }
}

function deadline(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Single-flight per account. Status is separate from the last usable catalog. */
export function installModelCatalog(ctx, { home = process.env.DSH_HOME, getAuth = catalogAuth, fetchModels = fetchModelCatalog } = {}) {
  const root = home ? join(home, 'model-catalog') : null
  const state = Object.fromEntries(Object.entries(MODEL_SOURCES).map(([id, source]) => [id, { name: source.name, status: 'idle' }]))
  const jobs = new Map(), stopped = new Set()
  const lifetime = new AbortController()
  const bundled = builtinProviders()
  const refresh = (provider, force = false) => {
    if (!MODEL_SOURCES[provider] || lifetime.signal.aborted || stopped.has(provider)) return Promise.resolve()
    if (jobs.has(provider)) return jobs.get(provider).promise
    const current = state[provider]
    if (!force && current.attemptedAt && Date.now() - current.attemptedAt < MODEL_REFRESH_MS) return Promise.resolve()
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, lifetime.signal, AbortSignal.timeout(20_000)])
    const job = { controller, promise: null }
    jobs.set(provider, job)
    job.promise = (async () => {
      try {
        // Small compositions/tests without persistence retain the bundled list.
        if (!root || !settingsAccess(ctx) || !ctx.credentials.readRecord) return
        const record = await ctx.credentials.describeRecord(keyFor(provider))
        signal.throwIfAborted()
        if (!record?.configured) { state[provider] = { name: current.name, status: 'disconnected' }; return }
        const journal = await readJournal(root, provider)
        if (!automatic(snapshot(ctx, provider).profile, journal, provider)) {
          state[provider] = { name: current.name, status: 'custom' }; return
        }
        state[provider] = { ...current, checkedAt: current.checkedAt || journal.checkedAt, count: current.count ?? journal.count,
          attemptedAt: Date.now(), status: 'refreshing' }
        const auth = await deadline(getAuth(ctx, provider, signal), signal)
        const credential = await ctx.credentials.readRecord(keyFor(provider))
        const models = await deadline(fetchModels(provider, auth, signal, bundled.find(p => p.id === provider)?.getModels() || []), signal)
        signal.throwIfAborted()
        // A different login or an external sign-out invalidates this response.
        const now = await ctx.credentials.readRecord(keyFor(provider))
        if (!now || !credential || digest(now) !== digest(credential)) throw new Error('Account changed during model refresh')
        const result = await publish(ctx, root, provider, models, signal)
        state[provider] = { ...state[provider], status: result === 'custom' ? 'custom' : 'fresh',
          ...(result === 'custom' ? {} : { checkedAt: Date.now(), count: models.length }), error: undefined }
      } catch (error) {
        if (controller.signal.aborted || lifetime.signal.aborted) return
        // No raw upstream response or exception can expose tokens in the UI/log.
        state[provider] = { ...state[provider], status: 'stale', attemptedAt: Date.now(),
          error: signal.aborted ? 'Model refresh timed out. Keeping the previous list.' : 'Could not refresh models. Keeping the previous list; retry or check your connection and sign-in.' }
      } finally { if (jobs.get(provider) === job) jobs.delete(provider) }
    })()
    return job.promise
  }
  const refreshAll = (force = false) => Promise.all(Object.keys(MODEL_SOURCES).map(id => refresh(id, force)))
  const timer = setInterval(() => { void refreshAll() }, MODEL_REFRESH_MS)
  timer.unref?.()
  return {
    state, refresh, refreshAll,
    // Call after route declaration so an early credential event cannot race it.
    connected(provider) { stopped.delete(provider); return refresh(provider, true) },
    async disconnect(provider) {
      stopped.add(provider)
      const job = jobs.get(provider)
      job?.controller.abort()
      await job?.promise
      state[provider] = { name: MODEL_SOURCES[provider]?.name || provider, status: 'disconnected' }
      if (!MODEL_SOURCES[provider] || !root || !settingsAccess(ctx)) return
      await publish(ctx, root, provider, undefined, lifetime.signal, true)
    },
    dispose() { lifetime.abort(); clearInterval(timer) },
  }
}
