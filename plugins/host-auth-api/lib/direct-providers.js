import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { ensureProviderDeclared, retractProviderIfAuto } from './declare.js'
import { ensureUsableDefaultModel } from './default-model.js'
import { settingsNamespace, settingsAccess } from './settings-access.js'

const NS = 'llm-pi-ai'
export const CUSTOM_GATEWAY_ID = 'custom-gateway'

export const DIRECT_PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    sub: 'Claude Opus 4.7, Sonnet 4.6 & Haiku 4.5',
    envVars: ['ANTHROPIC_API_KEY'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
    placeholder: 'sk-ant-…',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    sub: 'DeepSeek V4 Pro & V4 Flash',
    envVars: ['DEEPSEEK_API_KEY'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
    placeholder: 'sk-…',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    sub: 'Gemini 2.5 Pro, 2.5 Flash & Deep Research',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    keyUrl: 'https://aistudio.google.com/apikey',
    placeholder: 'AIza…',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    sub: 'GPT-5, o3 & GPT-4.1 direct API',
    envVars: ['OPENAI_API_KEY'],
    keyUrl: 'https://platform.openai.com/api-keys',
    placeholder: 'sk-proj-…',
  },
  {
    id: 'groq',
    name: 'Groq',
    sub: 'LPU ultra-fast Llama & Qwen',
    envVars: ['GROQ_API_KEY'],
    keyUrl: 'https://console.groq.com/keys',
    placeholder: 'gsk_…',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    sub: 'Wafer-scale 2,000+ tok/s coding models',
    envVars: ['CEREBRAS_API_KEY'],
    keyUrl: 'https://cloud.cerebras.ai',
    placeholder: 'csk-…',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    sub: 'Codestral, Devstral & Mistral Large',
    envVars: ['MISTRAL_API_KEY'],
    keyUrl: 'https://console.mistral.ai/api-keys',
    placeholder: 'API key…',
  },
  {
    id: 'together',
    name: 'Together AI',
    sub: 'Qwen, DeepSeek & MiniMax open-weights',
    envVars: ['TOGETHER_API_KEY'],
    keyUrl: 'https://api.together.ai/settings/api-keys',
    placeholder: 'API key…',
  },
]

const BUNDLED_COUNTS = (() => {
  const counts = Object.create(null)
  try {
    for (const p of builtinProviders()) {
      counts[p.id] = p.getModels?.()?.length || 0
    }
  } catch {}
  return counts
})()

function detectEnvKey (envVars) {
  for (const name of envVars) {
    const val = process.env[name]?.trim()
    if (val) return { envVar: name, key: val }
  }
  return null
}

function enrichGatewayModel (id) {
  const clean = String(id).trim()
  return {
    id: clean,
    name: clean,
    contextWindow: 131072,
    maxTokens: 16384,
    input: ['text', 'image'],
  }
}

async function discoverGatewayModels (baseURL, apiKey, signal) {
  const timeout = AbortSignal.timeout(4000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const headers = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const url = `${baseURL.replace(/\/+$/, '')}/models`
    const res = await fetch(url, { headers, signal: combined })
    if (res.ok) {
      const payload = await res.json()
      const rows = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : []
      return [...new Set(
        rows
          .map((r) => (typeof r?.id === 'string' ? r.id.trim() : typeof r?.name === 'string' ? r.name.trim() : ''))
          .filter((id) => id && !/embed/i.test(id)),
      )]
    }
  } catch {
    signal?.throwIfAborted()
  }
  return []
}

async function mutateGatewayProfile (ctx, next, signal) {
  const settings = settingsAccess(ctx)
  if (!settings || typeof settings.describe !== 'function' || typeof settings.section !== 'function') {
    return 'settings-unavailable'
  }
  for (let retry = 0; retry < 3; retry++) {
    signal?.throwIfAborted()
    const snapshot = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === NS)
    if (!snapshot || !Number.isSafeInteger(snapshot.revision)) return 'settings-unavailable'
    try {
      await settings.mutate(
        settingsNamespace(NS),
        [next
          ? { op: 'set', path: ['providers', CUSTOM_GATEWAY_ID], value: next }
          : { op: 'unset', path: ['providers', CUSTOM_GATEWAY_ID] }],
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

export function installDirectProviders (ctx) {
  const lifetime = new AbortController()

  const readGatewayState = () => {
    const settings = settingsAccess(ctx)
    const profile = settings?.section?.(settingsNamespace(NS))?.providers?.[CUSTOM_GATEWAY_ID]
    if (!profile || typeof profile !== 'object') {
      return {
        configured: false,
        displayName: 'Custom Gateway',
        baseURL: '',
        models: [],
        modelCount: 0,
      }
    }
    const models = Array.isArray(profile.models) ? profile.models.map((m) => m.id || m).filter(Boolean) : []
    return {
      configured: true,
      displayName: profile.displayName || 'Custom Gateway',
      baseURL: profile.baseURL || '',
      models,
      modelCount: models.length,
    }
  }

  const refreshState = async (signal = lifetime.signal) => {
    signal?.throwIfAborted()
    const providers = await Promise.all(DIRECT_PROVIDERS.map(async (meta) => {
      const env = detectEnvKey(meta.envVars)
      let record = null
      try {
        record = await ctx.credentials?.describeRecord?.(credentialKey(NS, meta.id))
      } catch {
        record = null
      }
      return {
        id: meta.id,
        name: meta.name,
        sub: meta.sub,
        keyUrl: meta.keyUrl,
        placeholder: meta.placeholder,
        configured: Boolean(record?.configured),
        envAvailable: Boolean(env),
        envVar: env?.envVar || meta.envVars[0],
        modelCount: BUNDLED_COUNTS[meta.id] || 0,
      }
    }))
    return {
      providers,
      gateway: readGatewayState(),
    }
  }

  const connectProvider = async ({ provider, apiKey, useEnv } = {}, signal = lifetime.signal) => {
    const meta = DIRECT_PROVIDERS.find((p) => p.id === provider)
    if (!meta) throw new Error(`Unsupported direct provider "${provider}".`)
    let key = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (!key && useEnv) {
      key = detectEnvKey(meta.envVars)?.key || ''
    }
    if (!key) {
      throw new Error(`Enter your ${meta.name} API key.`)
    }
    if (/[\u0000-\u0020\u007f]/.test(key)) {
      throw new Error('API key contains spaces or invalid characters. Paste the raw key only.')
    }
    const recKey = credentialKey(NS, meta.id)
    if (typeof ctx.credentials?.modifyRecord === 'function') {
      await ctx.credentials.modifyRecord(recKey, async () => ({
        kind: 'api-key',
        key,
      }))
    }
    await ensureProviderDeclared(ctx, meta.id)
    await ensureUsableDefaultModel(ctx).catch(() => {})
    return refreshState(signal)
  }

  const disconnectProvider = async ({ provider } = {}, signal = lifetime.signal) => {
    const meta = DIRECT_PROVIDERS.find((p) => p.id === provider)
    if (!meta) throw new Error(`Unsupported direct provider "${provider}".`)
    const recKey = credentialKey(NS, meta.id)
    if (typeof ctx.credentials?.deleteRecord === 'function') {
      await ctx.credentials.deleteRecord(recKey)
    }
    await retractProviderIfAuto(ctx, meta.id)
    return refreshState(signal)
  }

  const connectGateway = async ({ displayName, baseURL, apiKey, models } = {}, signal = lifetime.signal) => {
    const cleanUrl = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : ''
    if (!cleanUrl) throw new Error('Enter a base URL (for example http://127.0.0.1:8000/v1).')
    let parsedUrl
    try {
      parsedUrl = new URL(cleanUrl)
    } catch {
      throw new Error('Base URL must be a valid http:// or https:// URL.')
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Base URL must start with http:// or https://.')
    }

    const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (cleanKey && /[\u0000-\u0020\u007f]/.test(cleanKey)) {
      throw new Error('API key contains spaces or invalid characters.')
    }

    const manualIds = Array.isArray(models)
      ? models.map((m) => String(m).trim()).filter(Boolean)
      : typeof models === 'string'
        ? models.split(/[\n,]+/).map((m) => m.trim()).filter(Boolean)
        : []

    const discoveredIds = await discoverGatewayModels(cleanUrl, cleanKey, signal)
    const combinedIds = [...new Set([...manualIds, ...discoveredIds])]
    if (combinedIds.length === 0) {
      throw new Error('No models discovered at /models. Enter at least one model ID (for example qwen3-coder or llama-3.3-70b).')
    }

    const recKey = credentialKey(NS, CUSTOM_GATEWAY_ID)
    if (cleanKey) {
      if (typeof ctx.credentials?.modifyRecord === 'function') {
        await ctx.credentials.modifyRecord(recKey, async () => ({
          kind: 'api-key',
          key: cleanKey,
        }))
      }
    } else if (typeof ctx.credentials?.deleteRecord === 'function') {
      await ctx.credentials.deleteRecord(recKey).catch(() => {})
    }

    const profile = {
      displayName: (typeof displayName === 'string' && displayName.trim()) || 'Custom Gateway',
      api: 'openai-completions',
      baseURL: cleanUrl,
      ...(cleanKey ? {} : { headers: { Authorization: 'Bearer local' } }),
      models: combinedIds.map(enrichGatewayModel),
    }
    await mutateGatewayProfile(ctx, profile, signal)
    await ensureUsableDefaultModel(ctx).catch(() => {})
    return refreshState(signal)
  }

  const disconnectGateway = async (signal = lifetime.signal) => {
    const recKey = credentialKey(NS, CUSTOM_GATEWAY_ID)
    if (typeof ctx.credentials?.deleteRecord === 'function') {
      await ctx.credentials.deleteRecord(recKey).catch(() => {})
    }
    await mutateGatewayProfile(ctx, null, signal).catch(() => {})
    return refreshState(signal)
  }

  return {
    refreshState,
    connectProvider,
    disconnectProvider,
    connectGateway,
    disconnectGateway,
    dispose () { lifetime.abort() },
  }
}
