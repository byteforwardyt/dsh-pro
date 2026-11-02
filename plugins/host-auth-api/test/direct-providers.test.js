import { test } from 'node:test'
import assert from 'node:assert/strict'
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

