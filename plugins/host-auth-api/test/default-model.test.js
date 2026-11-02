import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { ensureUsableDefaultModel } from '../lib/default-model.js'

test('ensureUsableDefaultModel retargets invalid/empty model, falls back to bundled models for OAuth providers without llm service', async () => {
  const providers = Object.create(null)
  let defaultProvider = 'openai-codex'
  let defaultModel = ''
  let revision = 0

  const settings = {
    configuration () { return [{ entry: { options: { id: 'agent-default-model' } }, override: { defaultProvider, defaultModel } }] },
    section: (ns) => {
      if (ns === 'agent-default-model') return { defaultProvider, defaultModel }
      if (ns === 'llm-pi-ai') return { providers: { ...providers } }
      return {}
    },
    describe: () => [
      { ns: 'agent-default-model', revision, value: { provider: defaultProvider, model: defaultModel } },
      { ns: 'llm-pi-ai', revision, user: { providers: { ...providers } } },
    ],
    async mutate (ns, ops) {
      for (const op of ops) {
        if (op.path[0] === 'provider') defaultProvider = op.value
        else if (op.path[0] === 'model') defaultModel = op.value
        else if (op.path[0] === 'providers') {
          if (op.op === 'set') providers[op.path[1]] = op.value
          else delete providers[op.path[1]]
        }
      }
      revision++
    },
  }

  const ctx = {
    get: (name) => {
      if (name === 'settings' || name === 'configEditor') return settings
      // llm service is undefined/unavailable
      return undefined
    },
    logger: { info () {}, warn () {} },
    authorization: {
      list: () => [{ key: credentialKey('llm-pi-ai', 'openai-codex') }],
    },
    credentials: {
      describeRecord: async (key) => ({ configured: key.includes('openai-codex') }),
    },
  }

  // 1. Current defaultModel is empty, so ensureUsableDefaultModel must retarget
  const result = await ensureUsableDefaultModel(ctx)
  assert.equal(result, 'retargeted')
  assert.equal(defaultProvider, 'openai-codex')
  assert.ok(typeof defaultModel === 'string' && defaultModel.length > 0, 'model should be resolved from bundled pi-ai catalog')

  // 2. Now that a valid provider and model are set and configured, check returns 'ok'
  const checkOk = await ensureUsableDefaultModel(ctx)
  assert.equal(checkOk, 'ok')

  // 3. If credentials become unconfigured, returns 'no-accounts'
  ctx.credentials.describeRecord = async () => ({ configured: false })
  const checkNoAccounts = await ensureUsableDefaultModel(ctx)
  assert.equal(checkNoAccounts, 'no-accounts')
})
