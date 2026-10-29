import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, settingsAccess } from './settings-access.js'
import { ensureUsableDefaultModel } from './default-model.js'

const NS = 'llm-pi-ai'
export const OPENCODE_ID = 'opencode'
export const OPENCODE_NAME = 'OpenCode Zen'
export const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
export const OPENCODE_MODELS_URL = 'https://opencode.ai/zen/v1/models'
export const OPENCODE_AUTH_URL = 'https://opencode.ai/auth'
export const OPENCODE_RECORD_KEY = credentialKey(NS, OPENCODE_ID)

const AUTO_WRITTEN_KEYS = ['displayName', 'api', 'baseURL', 'models']

const FALLBACK_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'gpt-5.4',
  'gpt-5.3-codex',
  'deepseek-v4-pro',
  'gemini-3.8-flash',
  'grok-4.7',
  'kimi-k2.7-code',
  'qwen3.8-max',
  'minimax-m3',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-super-vl-free',
  'big-pickle',
]

function formatModelName (id) {
  if (id === 'big-pickle') return 'Big Pickle (Free)'
  const isFree = id.endsWith('-free')
  const base = isFree ? id.slice(0, -5) : id
  const parts = base.split('-')
  const formatted = parts.map((part) => {
    const lower = part.toLowerCase()
    if (lower === 'gpt') return 'GPT'
    if (lower === 'glm') return 'GLM'
    if (lower === 'vl') return 'VL'
    if (lower === 'mimo') return 'MiMo'
    if (lower === 'deepseek') return 'DeepSeek'
    if (lower === 'minimax') return 'MiniMax'
    if (lower === 'qwen3.5') return 'Qwen 3.5'
    if (lower === 'qwen3.6') return 'Qwen 3.6'
    if (lower === 'qwen3.8') return 'Qwen 3.8'
    if (/^[kmv]\d+(\.\d+)?$/i.test(part)) return part.toUpperCase()
    if (/^\d+(\.\d+)?[a-z]*$/i.test(part)) return part.toUpperCase()
    return part.charAt(0).toUpperCase() + part.slice(1)
  }).join(' ')
  return isFree ? `${formatted} (Free)` : formatted
}

export function enrichZenModel (id) {
  const lower = id.toLowerCase()
  const vision = /^(claude-|gpt-5|gpt-6|gemini-|grok-|kimi-|qwen)/.test(lower) || lower.includes('-vl')
  const largeContext = /^(claude-|gpt-5|gpt-6|gemini-|grok-|kimi-)/.test(lower)
  const contextWindow = largeContext ? 200000 : 131072
  const maxTokens = largeContext ? 32768 : 16384
  return {
    id,
    name: formatModelName(id),
    contextWindow,
    maxTokens,
    input: vision ? ['text', 'image'] : ['text'],
  }
}

export function isOurs (profile) {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return false
  if (!Object.keys(profile).every((key) => AUTO_WRITTEN_KEYS.includes(key))) return false
  return profile.displayName === OPENCODE_NAME
    && profile.api === 'openai-completions'
    && profile.baseURL === OPENCODE_BASE_URL
}

async function readCliKey () {
  const envKey = process.env.OPENCODE_API_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const candidates = [
    join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    join(homedir(), '.config', 'opencode', 'auth.json'),
  ]
  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      const entry = parsed?.opencode || parsed?.['opencode-zen']
      const key = typeof entry?.key === 'string' ? entry.key.trim() : typeof entry?.apiKey === 'string' ? entry.apiKey.trim() : ''
      if (key) return { key, source: 'cli' }
    } catch { /* ignore absent or unreadable CLI auth */ }
  }
  return null
}

async function fetchZenModels (apiKey, signal) {
  const timeout = AbortSignal.timeout(6000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const headers = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(OPENCODE_MODELS_URL, { headers, signal: combined })
    if (res.ok) {
      const payload = await res.json()
      const rows = Array.isArray(payload?.data) ? payload.data : []
      const ids = [...new Set(
        rows
          .map((r) => (typeof r?.id === 'string' ? r.id.trim() : ''))
          .filter((id) => id && id !== 'test' && !/embed/i.test(id) && !id.endsWith('-backup')),
      )]
      if (ids.length > 0) return ids.map(enrichZenModel)
    }
  } catch {
    signal?.throwIfAborted()
  }
  return FALLBACK_MODELS.map(enrichZenModel)
}

async function syncZenProfile (ctx, models, signal) {
  const settings = settingsAccess(ctx)
  if (!settings || typeof settings.describe !== 'function' || typeof settings.section !== 'function') {
    return 'settings-unavailable'
  }
  const next = models ? {
    displayName: OPENCODE_NAME,
    api: 'openai-completions',
    baseURL: OPENCODE_BASE_URL,
    models,
  } : null
  for (let retry = 0; retry < 3; retry++) {
    signal?.throwIfAborted()
    const snapshot = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === NS)
    if (!snapshot || !Number.isSafeInteger(snapshot.revision)) return 'settings-unavailable'
    const existing = settings.section(settingsNamespace(NS))?.providers?.[OPENCODE_ID]
    if (existing !== undefined && !isOurs(existing)) return 'user-managed'
    if (!next && existing === undefined) return 'absent'
    if (next && existing !== undefined && JSON.stringify(existing) === JSON.stringify(next)) return 'declared'
    try {
      await settings.mutate(
        settingsNamespace(NS),
        [next
          ? { op: 'set', path: ['providers', OPENCODE_ID], value: next }
          : { op: 'unset', path: ['providers', OPENCODE_ID] }],
        snapshot.revision,
      )
      return next ? 'declared' : 'retracted'
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT' && retry < 2) continue
      throw error
    }
  }
  return 'failed'
}

export function installOpenCodeZen (ctx) {
  const lifetime = new AbortController()
  const state = {
    provider: OPENCODE_ID,
    name: OPENCODE_NAME,
    authUrl: OPENCODE_AUTH_URL,
    configured: false,
    cliAvailable: false,
    cliSource: null,
    modelCount: 0,
    models: [],
    status: 'idle',
    error: null,
  }

  const refreshState = async (signal = lifetime.signal) => {
    const cli = await readCliKey()
    state.cliAvailable = Boolean(cli?.key)
    state.cliSource = cli?.source || null
    let record = null
    try {
      record = await ctx.credentials?.describeRecord?.(OPENCODE_RECORD_KEY)
    } catch { record = null }
    state.configured = Boolean(record?.configured)
    if (!state.configured) {
      state.status = 'disconnected'
      return { ...state }
    }
    const settings = settingsAccess(ctx)
    const profile = settings?.section?.(settingsNamespace(NS))?.providers?.[OPENCODE_ID]
    if (profile && Array.isArray(profile.models) && profile.models.length > 0) {
      state.models = profile.models.map((m) => m.id)
      state.modelCount = state.models.length
      state.status = 'connected'
    } else {
      const models = await fetchZenModels(undefined, signal)
      await syncZenProfile(ctx, models, signal).catch(() => {})
      state.models = models.map((m) => m.id)
      state.modelCount = state.models.length
      state.status = 'connected'
    }
    return { ...state }
  }

  const connect = async ({ apiKey, useCli } = {}, signal = lifetime.signal) => {
    let key = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!key && useCli) {
      const cli = await readCliKey()
      key = cli?.key || ''
    }
    if (!key) {
      throw new Error('Enter your OpenCode Zen API key from opencode.ai/auth.')
    }
    if (/[\u0000-\u0020\u007f]/.test(key)) {
      throw new Error('API key contains spaces or invalid characters. Paste the raw key only.')
    }
    if (typeof ctx.credentials?.modifyRecord === 'function') {
      await ctx.credentials.modifyRecord(OPENCODE_RECORD_KEY, async () => ({
        kind: 'api-key',
        key,
      }))
    }
    const models = await fetchZenModels(key, signal)
    await syncZenProfile(ctx, models, signal)
    await ensureUsableDefaultModel(ctx).catch(() => {})
    state.configured = true
    state.models = models.map((m) => m.id)
    state.modelCount = state.models.length
    state.status = 'connected'
    state.error = null
    return refreshState(signal)
  }

  const disconnect = async (signal = lifetime.signal) => {
    if (typeof ctx.credentials?.deleteRecord === 'function') {
      await ctx.credentials.deleteRecord(OPENCODE_RECORD_KEY)
    }
    await syncZenProfile(ctx, null, signal).catch(() => {})
    state.configured = false
    state.models = []
    state.modelCount = 0
    state.status = 'disconnected'
    state.error = null
    return refreshState(signal)
  }

  const refreshModels = async (signal = lifetime.signal) => {
    let key
    try {
      const rec = await ctx.credentials?.readRecord?.(OPENCODE_RECORD_KEY)
      key = rec?.key
    } catch {}
    const models = await fetchZenModels(key, signal)
    if (state.configured) {
      await syncZenProfile(ctx, models, signal)
    }
    state.models = models.map((m) => m.id)
    state.modelCount = state.models.length
    return refreshState(signal)
  }

  return {
    get state () { return { ...state } },
    refreshState,
    connect,
    disconnect,
    refreshModels,
    dispose () { lifetime.abort() },
  }
}
