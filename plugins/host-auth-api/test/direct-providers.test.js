import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { installDirectProviders, DIRECT_PROVIDERS, CUSTOM_GATEWAY_ID } from '../lib/direct-providers.js'
import { ensureUsableDefaultModel } from '../lib/default-model.js'

test('DIRECT_PROVIDERS exposes 14 major frontier, fast-inference, and open-weights providers', () => {
  const ids = DIRECT_PROVIDERS.map((p) => p.id)
  for (const expected of [
    'anthropic', 'deepseek', 'google', 'openai', 'groq', 'cerebras', 'mistral', 'together',
    'fireworks', 'nvidia', 'huggingface', 'minimax', 'zai', 'vercel-ai-gateway',
  ]) {
    assert.ok(ids.includes(expected), `missing direct provider ${expected}`)
  }
  assert.equal(DIRECT_PROVIDERS.length, 14)
})

test('installDirectProviders connects direct API keys, bulk-imports env keys, and manages custom gateway + default model', async (t) => {
  const originalFetch = globalThis.fetch
  const prevAnthropicEnv = process.env.ANTHROPIC_API_KEY
  const prevGroqEnv = process.env.GROQ_API_KEY
  const prevDeepseekEnv = process.env.DEEPSEEK_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-env-test-key'
  process.env.GROQ_API_KEY = 'gsk-groq-env-test-key'
  process.env.DEEPSEEK_API_KEY = 'bad key with spaces'
  t.after(() => {
    globalThis.fetch = originalFetch
    if (prevAnthropicEnv === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevAnthropicEnv
    if (prevGroqEnv === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = prevGroqEnv
    if (prevDeepseekEnv === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevDeepseekEnv
  })

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/models')) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'qwen3-coder-32b' },
            { id: 'deepseek-r1-distill-32b' },
          ],
        }),
      }
    }
    return { ok: false }
  }

  const records = new Map()
  const providers = Object.create(null)
  let defaultProvider = 'openai-codex'
  let defaultModel = 'gpt-5'
  let revision = 0

  const settings = {
    configuration () { return [{ entry: { options: { id: 'llm-pi-ai' } }, override: this.section() }] },
    section: () => ({ defaultProvider, defaultModel, providers: { ...providers } }),
    describe: () => [
      { ns: 'llm-pi-ai', revision, user: { defaultProvider, defaultModel, providers: { ...providers } } },
      { ns: 'agent-default-model', revision, value: { provider: defaultProvider, model: defaultModel } },
    ],
    async mutate (_ns, ops) {
      for (const op of ops) {
        if (op.path[0] === 'defaultProvider' || op.path[0] === 'provider') defaultProvider = op.value
        else if (op.path[0] === 'defaultModel' || op.path[0] === 'model') defaultModel = op.value
        else if (op.path[0] === 'providers') {
          const id = op.path[1]
          if (op.op === 'set') providers[id] = op.value
          else delete providers[id]
        }
      }
      revision++
    },
  }

  const ctx = {
    get: (name) => (name === 'settings' || name === 'configEditor' ? settings : undefined),
    authorization: { list: () => [] },
    credentials: {
      describeRecord: async (key) => ({ configured: records.has(key), kind: records.get(key)?.kind }),
      readRecord: async (key) => records.get(key) || null,
      modifyRecord: async (key, fn) => {
        const next = await fn(records.get(key) || null)
        records.set(key, next)
        return next
      },
      deleteRecord: async (key) => { records.delete(key) },
    },
  }

  const direct = installDirectProviders(ctx)
  t.after(() => direct.dispose())

  // 1. Initial state detects ANTHROPIC_API_KEY and GROQ_API_KEY in env
  const initial = await direct.refreshState()
  const anthropicInitial = initial.providers.find((p) => p.id === 'anthropic')
  assert.equal(anthropicInitial.envAvailable, true)
  assert.equal(anthropicInitial.configured, false)

  // 2. Connect Anthropic using env key and verify default model retargets to anthropic
  const afterAnthropic = await direct.connectProvider({ provider: 'anthropic', useEnv: true })
  assert.equal(afterAnthropic.providers.find((p) => p.id === 'anthropic').configured, true)
  assert.equal(providers.anthropic?.displayName, 'Anthropic')
  assert.equal(defaultProvider, 'anthropic')
  assert.ok(defaultModel.length > 0)

  // 3. Bulk-connect all remaining detected env keys (Groq succeeds, DeepSeek with spaces fails safely)
  const afterBulk = await direct.connectAllEnv()
  assert.deepEqual(afterBulk.connected, ['groq'])
  assert.equal(afterBulk.providers.find((p) => p.id === 'groq').configured, true)
  assert.equal(afterBulk.errors?.length, 1)
  assert.equal(afterBulk.errors[0].id, 'deepseek')
  assert.ok(afterBulk.errors[0].error.includes('whitespace'))

  // 4. Disconnect Anthropic and Groq
  await direct.disconnectProvider({ provider: 'groq' })
  const afterDisconnect = await direct.disconnectProvider({ provider: 'anthropic' })
  assert.equal(afterDisconnect.providers.find((p) => p.id === 'anthropic').configured, false)
  assert.equal(providers.anthropic, undefined)

  // 5. Connect Custom OpenAI-Compatible Gateway with /models auto-discovery and verify default model retargets
  const afterGateway = await direct.connectGateway({
    displayName: 'vLLM Local',
    baseURL: 'http://127.0.0.1:8000/v1/',
    models: 'custom-lora-1',
  })
  assert.equal(afterGateway.gateway.configured, true)
  assert.equal(afterGateway.gateway.displayName, 'vLLM Local')
  assert.equal(afterGateway.gateway.baseURL, 'http://127.0.0.1:8000/v1')
  assert.deepEqual(afterGateway.gateway.models, ['custom-lora-1', 'qwen3-coder-32b', 'deepseek-r1-distill-32b'])
  assert.equal(providers[CUSTOM_GATEWAY_ID]?.api, 'openai-completions')
  await ensureUsableDefaultModel(ctx)
  assert.equal(defaultProvider, CUSTOM_GATEWAY_ID)
  assert.equal(defaultModel, 'custom-lora-1')

  // 6. Disconnect Custom Gateway
  const afterGwDisconnect = await direct.disconnectGateway()
  assert.equal(afterGwDisconnect.gateway.configured, false)
  assert.equal(providers[CUSTOM_GATEWAY_ID], undefined)
})

test('every direct provider can connect, declare profile, retarget default model, and cleanly disconnect', async (t) => {
  const records = new Map()
  const providers = Object.create(null)
  let defaultProvider = 'none'
  let defaultModel = 'none'
  let revision = 0

  const settings = {
    configuration () { return [{ entry: { options: { id: 'llm-pi-ai' } }, override: this.section() }] },
    section: () => ({ defaultProvider, defaultModel, providers: { ...providers } }),
    describe: () => [
      { ns: 'llm-pi-ai', revision, user: { defaultProvider, defaultModel, providers: { ...providers } } },
      { ns: 'agent-default-model', revision, value: { provider: defaultProvider, model: defaultModel } },
    ],
    async mutate (_ns, ops) {
      for (const op of ops) {
        if (op.path[0] === 'defaultProvider' || op.path[0] === 'provider') defaultProvider = op.value
        else if (op.path[0] === 'defaultModel' || op.path[0] === 'model') defaultModel = op.value
        else if (op.path[0] === 'providers') {
          const id = op.path[1]
          if (op.op === 'set') providers[id] = op.value
          else delete providers[id]
        }
      }
      revision++
    },
  }

  const ctx = {
    get: (name) => (name === 'settings' || name === 'configEditor' ? settings : undefined),
    authorization: { list: () => [] },
    credentials: {
      describeRecord: async (key) => ({ configured: records.has(key), kind: records.get(key)?.kind }),
      readRecord: async (key) => records.get(key) || null,
      modifyRecord: async (key, fn) => {
        const next = await fn(records.get(key) || null)
        records.set(key, next)
        return next
      },
      deleteRecord: async (key) => { records.delete(key) },
    },
  }

  const direct = installDirectProviders(ctx)
  t.after(() => direct.dispose())

  for (const item of DIRECT_PROVIDERS) {
    const rawKey = `key-for-${item.id}-12345`
    const recKey = credentialKey('llm-pi-ai', item.id)
    // 1. Connect provider
    const connectedState = await direct.connectProvider({ provider: item.id, apiKey: `  ${rawKey}  ` })
    const itemState = connectedState.providers.find((p) => p.id === item.id)
    assert.equal(itemState.configured, true, `${item.id} should be configured`)
    assert.equal(records.get(recKey)?.key, rawKey, `${item.id} key should be stored without whitespace`)
    assert.equal(records.get(recKey)?.kind, 'api-key')
    assert.ok(providers[item.id]?.displayName, `${item.id} should have a declared displayName`)

    // 2. Default model retargeting selects an actual bundled model for this provider
    assert.equal(defaultProvider, item.id)
    assert.ok(typeof defaultModel === 'string' && defaultModel.length > 0)

    // 3. Clean disconnect
    const disconnectedState = await direct.disconnectProvider({ provider: item.id })
    assert.equal(disconnectedState.providers.find((p) => p.id === item.id).configured, false)
    assert.equal(records.has(recKey), false)
    assert.equal(providers[item.id], undefined)
  }
})

test('secondary environment variable aliases are correctly detected for Z.AI, NVIDIA, Together, Fireworks', async (t) => {
  const prevZhipu = process.env.ZHIPUAI_API_KEY
  const prevNvidiaNim = process.env.NVIDIA_NIM_API_KEY
  const prevTogetherAi = process.env.TOGETHERAI_API_KEY
  const prevFireworksAi = process.env.FIREWORKS_AI_API_KEY
  const prevOpenaiBase = process.env.OPENAI_BASE_URL

  process.env.ZHIPUAI_API_KEY = 'zhipu-test-key'
  process.env.NVIDIA_NIM_API_KEY = 'nv-nim-test-key'
  process.env.TOGETHERAI_API_KEY = 'together-ai-test-key'
  process.env.FIREWORKS_AI_API_KEY = 'fw-ai-test-key'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1'

  t.after(() => {
    if (prevZhipu === undefined) delete process.env.ZHIPUAI_API_KEY; else process.env.ZHIPUAI_API_KEY = prevZhipu
    if (prevNvidiaNim === undefined) delete process.env.NVIDIA_NIM_API_KEY; else process.env.NVIDIA_NIM_API_KEY = prevNvidiaNim
    if (prevTogetherAi === undefined) delete process.env.TOGETHERAI_API_KEY; else process.env.TOGETHERAI_API_KEY = prevTogetherAi
    if (prevFireworksAi === undefined) delete process.env.FIREWORKS_AI_API_KEY; else process.env.FIREWORKS_AI_API_KEY = prevFireworksAi
    if (prevOpenaiBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = prevOpenaiBase
  })

  const ctx = {
    get: () => undefined,
    authorization: { list: () => [] },
    credentials: {
      describeRecord: async () => ({ configured: false }),
    },
  }

  const direct = installDirectProviders(ctx)
  t.after(() => direct.dispose())
  const state = await direct.refreshState()

  const zai = state.providers.find((p) => p.id === 'zai')
  assert.equal(zai.envAvailable, true)
  assert.equal(zai.envVar, 'ZHIPUAI_API_KEY')

  const nvidia = state.providers.find((p) => p.id === 'nvidia')
  assert.equal(nvidia.envAvailable, true)
  assert.equal(nvidia.envVar, 'NVIDIA_NIM_API_KEY')

  const together = state.providers.find((p) => p.id === 'together')
  assert.equal(together.envAvailable, true)
  assert.equal(together.envVar, 'TOGETHERAI_API_KEY')

  const fireworks = state.providers.find((p) => p.id === 'fireworks')
  assert.equal(fireworks.envAvailable, true)
  assert.equal(fireworks.envVar, 'FIREWORKS_AI_API_KEY')

  assert.equal(state.gateway.detectedEnvURL, 'http://127.0.0.1:11434/v1')
})

test('gateway discovery supports string array, root array, v1 fallback resolution, and rejects hostless URLs', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })

  const routesHit = []
  globalThis.fetch = async (url) => {
    const s = String(url)
    routesHit.push(s)
    if (s === 'http://127.0.0.1:8000/models') {
      return { ok: false, status: 404 }
    }
    if (s === 'http://127.0.0.1:8000/v1/models') {
      return {
        ok: true,
        json: async () => ({ data: ['qwen2.5-coder:32b', 'llama3:8b'] }),
      }
    }
    if (s === 'http://127.0.0.1:9000/models') {
      return {
        ok: true,
        json: async () => ([{ id: 'array-root-model' }]),
      }
    }
    return { ok: false }
  }

  const profiles = Object.create(null)
  let revision = 0
  const settings = {
    configuration () { return [{ entry: { options: { id: 'llm-pi-ai' } }, override: this.section() }] },
    section: () => ({ providers: { ...profiles } }),
    describe: () => [{ ns: 'llm-pi-ai', revision, user: { providers: { ...profiles } } }],
    async mutate (_ns, ops) {
      for (const op of ops) {
        if (op.op === 'set') profiles[op.path[1]] = op.value
        else delete profiles[op.path[1]]
      }
      revision++
    },
  }

  const ctx = {
    get: (name) => (name === 'settings' || name === 'configEditor' ? settings : undefined),
    authorization: { list: () => [] },
    credentials: {
      describeRecord: async () => ({ configured: false }),
      modifyRecord: async () => {},
      deleteRecord: async () => {},
    },
  }

  const direct = installDirectProviders(ctx)
  t.after(() => direct.dispose())

  // 1. Invalid URLs and non-http schemes fail cleanly
  await assert.rejects(
    direct.connectGateway({ baseURL: 'http://:8000/v1' }),
    /Base URL must be a valid http:\/\/ or https:\/\/ URL/,
  )
  await assert.rejects(
    direct.connectGateway({ baseURL: 'ftp://127.0.0.1:8000' }),
    /Base URL must start with http:\/\/ or https:\/\//,
  )

  // 2. v1 fallback resolution from http://127.0.0.1:8000 (which 404s on /models but succeeds on /v1/models)
  const state1 = await direct.connectGateway({
    displayName: 'Local vLLM',
    baseURL: 'http://127.0.0.1:8000///',
  })
  assert.equal(state1.gateway.configured, true)
  assert.equal(state1.gateway.baseURL, 'http://127.0.0.1:8000/v1')
  assert.deepEqual(state1.gateway.models, ['qwen2.5-coder:32b', 'llama3:8b'])
  assert.equal(profiles['custom-gateway']?.baseURL, 'http://127.0.0.1:8000/v1')

  // 3. Array-root models payload
  const state2 = await direct.connectGateway({
    displayName: 'Array Gateway',
    baseURL: 'http://127.0.0.1:9000',
  })
  assert.equal(state2.gateway.configured, true)
  assert.equal(state2.gateway.baseURL, 'http://127.0.0.1:9000')
  assert.deepEqual(state2.gateway.models, ['array-root-model'])
})

test('trailing slashes in OPENAI_BASE_URL are stripped in detectedEnvURL', async (t) => {
  const prev = process.env.OPENAI_BASE_URL
  process.env.OPENAI_BASE_URL = 'http://192.168.1.150:8000/v1///'
  t.after(() => {
    if (prev === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prev
  })

  const ctx = {
    get: () => undefined,
    authorization: { list: () => [] },
    credentials: { describeRecord: async () => ({ configured: false }) },
  }
  const direct = installDirectProviders(ctx)
  t.after(() => direct.dispose())
  const state = await direct.refreshState()
  assert.equal(state.gateway.detectedEnvURL, 'http://192.168.1.150:8000/v1')
})



