import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDirectProviders, DIRECT_PROVIDERS, CUSTOM_GATEWAY_ID } from '../lib/direct-providers.js'

test('DIRECT_PROVIDERS exposes major frontier and open-weights providers', () => {
  const ids = DIRECT_PROVIDERS.map((p) => p.id)
  for (const expected of ['anthropic', 'deepseek', 'google', 'openai', 'groq', 'cerebras', 'mistral', 'together']) {
    assert.ok(ids.includes(expected), `missing direct provider ${expected}`)
  }
})

test('installDirectProviders connects direct API keys, detects env vars, and manages custom gateway', async (t) => {
  const originalFetch = globalThis.fetch
  const prevAnthropicEnv = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-env-test-key'
  t.after(() => {
    globalThis.fetch = originalFetch
    if (prevAnthropicEnv === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = prevAnthropicEnv
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
  let revision = 0

  const settings = {
    configuration () { return [{ entry: { options: { id: 'llm-pi-ai' } }, override: this.section() }] },
    section: () => ({ providers: { ...providers } }),
    describe: () => [{ ns: 'llm-pi-ai', revision, user: { providers: { ...providers } } }],
    async mutate (_ns, [op]) {
      const id = op.path[1]
      if (op.op === 'set') providers[id] = op.value
      else delete providers[id]
      revision++
    },
  }

  const ctx = {
    get: (name) => (name === 'settings' || name === 'configEditor' ? settings : undefined),
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

  // 1. Initial state detects ANTHROPIC_API_KEY in env
  const initial = await direct.refreshState()
  const anthropicInitial = initial.providers.find((p) => p.id === 'anthropic')
  assert.equal(anthropicInitial.envAvailable, true)
  assert.equal(anthropicInitial.configured, false)

  // 2. Connect Anthropic using env key
  const afterAnthropic = await direct.connectProvider({ provider: 'anthropic', useEnv: true })
  assert.equal(afterAnthropic.providers.find((p) => p.id === 'anthropic').configured, true)
  assert.equal(providers.anthropic?.displayName, 'Anthropic')

  // 3. Disconnect Anthropic
  const afterDisconnect = await direct.disconnectProvider({ provider: 'anthropic' })
  assert.equal(afterDisconnect.providers.find((p) => p.id === 'anthropic').configured, false)
  assert.equal(providers.anthropic, undefined)

  // 4. Connect Custom OpenAI-Compatible Gateway with /models auto-discovery
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

  // 5. Disconnect Custom Gateway
  const afterGwDisconnect = await direct.disconnectGateway()
  assert.equal(afterGwDisconnect.gateway.configured, false)
  assert.equal(providers[CUSTOM_GATEWAY_ID], undefined)
})
