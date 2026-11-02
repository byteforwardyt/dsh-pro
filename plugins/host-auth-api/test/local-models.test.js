import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncLocalModels, installLocalModels, LOCAL_SERVERS, isOurs } from '../lib/local-models.js'

test('isOurs protects a user-edited local route from the reconciler', () => {
  const server = LOCAL_SERVERS[0] // ollama
  const ours = {
    displayName: server.displayName,
    api: 'openai-completions',
    baseURL: server.baseURL,
    headers: { Authorization: 'Bearer local' },
    models: [{ id: 'llama3', name: 'llama3', contextWindow: 8192, maxTokens: 4096 }],
  }
  // A profile we wrote (only the model list differs from any given pass) is ours.
  assert.equal(isOurs(server, ours), true)
  assert.equal(isOurs(server, { ...ours, models: [] }), true)

  // A user edit to any non-model field makes it THEIRS — must not be clobbered.
  assert.equal(isOurs(server, { ...ours, baseURL: 'http://192.168.1.9:11434/v1' }), false)
  assert.equal(isOurs(server, { ...ours, displayName: 'My Ollama' }), false)
  assert.equal(isOurs(server, { ...ours, headers: { Authorization: 'Bearer mine' } }), false)
  // An extra key (their own field) is theirs too.
  assert.equal(isOurs(server, { ...ours, note: 'hi' }), false)
  // Not an object.
  assert.equal(isOurs(server, null), false)
})

/**
 * Regression: at packaged-boot apply time the settings service is not attached
 * yet, so `ctx.get('settings')` is undefined — and cordis makes a bare
 * `ctx.settings` property read THROW ("cannot get property without inject").
 * That one throw killed the whole host at launch (fatal load failure, exit 1).
 * A sync pass must survive every shape of that context and simply mark the
 * pass 'settings-unavailable' so the 20s reconciler can retry.
 */

/** A ctx that behaves like cordis toward non-injected services. */
function cordisLikeCtx (settingsService) {
  const base = {
    get (name) { return name === 'settings' ? settingsService : undefined },
    logger: { info () {}, warn () {} },
  }
  return new Proxy(base, {
    get (target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'settings') throw new Error('cannot get property "settings" without inject')
      return undefined
    },
  })
}

test('sync survives settings not yet attached (the boot-crash shape)', async () => {
  const state = {}
  // ctx.get returns undefined AND property access throws — exactly the
  // packaged-boot shape that took the host down.
  await syncLocalModels(cordisLikeCtx(undefined), state)
  for (const server of LOCAL_SERVERS) {
    assert.ok(state[server.id], `${server.id} entry recorded`)
    if (state[server.id].up) {
      // A real local server happens to be running on this machine; the pass
      // must still have declined to touch settings.
      assert.equal(state[server.id].sync, 'settings-unavailable')
    }
  }
})

test('sync survives a ctx with no get() at all', async () => {
  const state = {}
  const ctx = new Proxy({}, {
    get (target, prop) {
      if (prop === 'get') return undefined
      if (prop === 'settings') throw new Error('cannot get property "settings" without inject')
      if (prop === 'logger') return undefined
      return undefined
    },
  })
  await syncLocalModels(ctx, state)
  assert.ok(state.ollama && state.lmstudio, 'both servers recorded')
})

test('installLocalModels calls onDeclared when a server is declared with models', async (t) => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) {
      return { ok: true, json: async () => ({ models: [{ name: 'llama3:8b' }] }) }
    }
    if (String(url).endsWith('/api/show')) {
      return { ok: true, json: async () => ({ model_info: { 'llama.context_length': 8192 } }) }
    }
    return { ok: false }
  }
  t.after(() => { globalThis.fetch = originalFetch })

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
    get: (name) => (name === 'settings' ? settings : undefined),
    logger: { info () {}, warn () {} },
  }

  const declared = []
  const scanner = installLocalModels(ctx, 60_000, {
    onDeclared: (id) => { declared.push(id) },
  })
  t.after(() => scanner.dispose())

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(declared.includes('ollama'), 'ollama should trigger onDeclared')
  assert.equal(profiles.ollama?.displayName, 'Ollama')
  assert.equal(profiles.ollama?.models?.[0]?.id, 'llama3:8b')
})

