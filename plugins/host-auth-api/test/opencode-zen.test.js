import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enrichZenModel, isOurs, installOpenCodeZen, OPENCODE_NAME, OPENCODE_BASE_URL } from '../lib/opencode-zen.js'

test('enrichZenModel formats names and modalities for OpenCode Zen models', () => {
  const claude = enrichZenModel('claude-sonnet-4-6')
  assert.equal(claude.name, 'Claude Sonnet 4 6')
  assert.equal(claude.contextWindow, 200000)
  assert.deepEqual(claude.input, ['text', 'image'])

  const free = enrichZenModel('deepseek-v4.1-flash-free')
  assert.equal(free.name, 'DeepSeek V4.1 Flash (Free)')
  assert.deepEqual(free.input, ['text'])
})

test('isOurs protects user-customized OpenCode Zen profiles', () => {
  const ours = {
    displayName: OPENCODE_NAME,
    api: 'openai-completions',
    baseURL: OPENCODE_BASE_URL,
    models: [enrichZenModel('claude-sonnet-4-6')],
  }
  assert.equal(isOurs(ours), true)
  assert.equal(isOurs({ ...ours, displayName: 'Custom Zen' }), false)
  assert.equal(isOurs({ ...ours, baseURL: 'https://custom.example/v1' }), false)
  assert.equal(isOurs({ ...ours, extra: true }), false)
})

test('installOpenCodeZen connects, declares provider profile, and disconnects cleanly', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'claude-sonnet-4-6' },
        { id: 'deepseek-v4.1-flash-free' },
      ],
    }),
  })

  let record = null
  let profile = undefined
  let revision = 0
  const settings = {
    configuration () { return [{ entry: { options: { id: 'llm-pi-ai' } }, override: this.section() }] },
    section: () => ({ providers: profile ? { opencode: profile } : {} }),
    describe: () => [{ ns: 'llm-pi-ai', revision, user: { providers: profile ? { opencode: profile } : {} } }],
    async mutate (_ns, [op]) {
      profile = op.op === 'set' ? op.value : undefined
      revision++
    },
  }
  const ctx = {
    get: (name) => (name === 'settings' || name === 'configEditor' ? settings : undefined),
    credentials: {
      describeRecord: async () => ({ configured: Boolean(record), kind: record?.kind }),
      readRecord: async () => record,
      modifyRecord: async (_key, fn) => { record = await fn(record); return record },
      deleteRecord: async () => { record = null },
    },
  }

  const zen = installOpenCodeZen(ctx)
  t.after(() => zen.dispose())

  const connected = await zen.connect({ apiKey: 'sk-zen-fixture-key' })
  assert.equal(connected.configured, true)
  assert.equal(connected.modelCount, 2)
  assert.equal(record?.key, 'sk-zen-fixture-key')
  assert.equal(profile?.displayName, OPENCODE_NAME)
  assert.equal(profile?.models?.length, 2)

  const disconnected = await zen.disconnect()
  assert.equal(disconnected.configured, false)
  assert.equal(record, null)
  assert.equal(profile, undefined)
})
