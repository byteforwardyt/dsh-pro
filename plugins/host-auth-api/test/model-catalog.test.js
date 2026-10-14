import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { installModelCatalog, catalogAuth } from '../lib/model-catalog.js'
import { normalizeModels, fetchModelCatalog } from '../lib/model-catalog-sources.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const catalog = { models: [{ id: 'grok-4.6', input_modalities: ['text', 'image'], output_modalities: ['text'] }] }
const models = normalizeModels('xai', catalog)
async function setup(t, { provider = 'xai', profile = { displayName: provider === 'openrouter' ? 'OpenRouter' : 'Grok' }, fetchModels = async () => models, onWrite = () => {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-model-catalog-'))
  let revision = 0, writes = 0, configured = true
  const providers = { [provider]: profile }
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision }], configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section: () => ({ providers: structuredClone(providers) }),
    async mutate(ns, [op], expected) {
      await onWrite(value => { providers[provider] = value; revision++ })
      if (expected !== revision) throw new SettingsConflictError(ns, expected, revision)
      providers[op.path[1]] = structuredClone(op.value); writes++; revision++
    },
  }
  const ctx = { get: name => ['settings', 'configEditor'].includes(name) ? settings : undefined, credentials: {
    describeRecord: async () => ({ configured }), readRecord: async () => configured ? { kind: 'grant', payload: { access: 'fixture-secret' } } : undefined,
  } }
  const options = { home, getAuth: async () => ({ apiKey: 'fixture-secret' }), fetchModels }
  const scanner = installModelCatalog(ctx, options)
  t.after(async () => { scanner.dispose(); await rm(home, { recursive: true, force: true }) })
  return { scanner, ctx, options, home, profile: () => providers[provider], writes: () => writes,
    edit(value) { providers[provider] = value; revision++ }, disconnect() { configured = false } }
}

test('journal-owned older OpenRouter profiles gain an explicit protocol on refresh', async t => {
  const legacy = { displayName: 'OpenRouter', models: [{ id: 'test/previous', input: ['text'] }] }
  const next = [{ id: 'test/new', input: ['text'], contextWindow: 128000, maxTokens: 4096, reasoningEfforts: false }]
  const app = await setup(t, { provider: 'openrouter', profile: legacy, fetchModels: async () => next })
  const serialized = JSON.stringify(legacy, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)
  await mkdir(join(app.home, 'model-catalog'))
  await writeFile(join(app.home, 'model-catalog/openrouter.json'), JSON.stringify({ version: 1, owned: [createHash('sha256').update(serialized).digest('hex')] }))
  await app.scanner.refresh('openrouter')
  assert.equal(app.scanner.state.openrouter.status, 'fresh')
  assert.deepEqual(app.profile(), { ...legacy, api: 'openai-completions', models: next })
})

test('OpenRouter compatibility repair leaves custom models and wire protocols untouched', async t => {
  for (const custom of [
    { displayName: 'OpenRouter', models: [{ id: 'test/custom' }] },
    { displayName: 'My Router', api: 'openai-responses', headers: { 'X-Custom': 'fixture' } },
  ]) {
    let fetches = 0
    const app = await setup(t, { provider: 'openrouter', profile: custom, fetchModels: async () => { fetches++; return [] } })
    await app.scanner.refresh('openrouter')
    assert.equal(app.scanner.state.openrouter.status, 'custom')
    assert.equal(app.writes(), 0)
    assert.equal(fetches, 0)
    assert.deepEqual(app.profile(), custom)
  }
})

test('new Grok ids and documented 4.6 capabilities reach the declared profile', async t => {
  const app = await setup(t)
  await app.scanner.refresh('xai')
  assert.equal(app.scanner.state.xai.status, 'fresh')
  assert.equal(app.profile().models[0].id, 'grok-4.6')
  assert.equal(app.profile().models[0].contextWindow, 500000)
  assert.equal(app.profile().models[0].reasoningEfforts.xhigh, 'xhigh')
  const text = await readFile(join(app.home, 'model-catalog/xai.json'), 'utf8')
  assert.ok(!text.includes('fixture-secret')); assert.ok(!text.includes('access'))
})
test('Grok 4.7 exposes only its documented reasoning levels when the account lists it', () => {
  const [model] = normalizeModels('xai', { models: [
    { id: 'grok-4.7', input_modalities: ['text', 'image'], output_modalities: ['text'] },
  ] })
  assert.equal(model.contextWindow, 500000)
  assert.deepEqual(model.reasoningEfforts, { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' })
  assert.equal(normalizeModels('xai', { models: [
    { id: 'grok-unknown', output_modalities: ['text'] },
  ] })[0].reasoningEfforts, false)
})
test('saved ownership survives restart and accepts the next provider release', async t => {
  const app = await setup(t); await app.scanner.refresh('xai'); app.scanner.dispose()
  const next = installModelCatalog(app.ctx, { ...app.options, fetchModels: async () => [{ ...models[0], id: 'grok-fixture-next' }] })
  t.after(() => next.dispose()); await next.refresh('xai')
  assert.equal(next.state.xai.status, 'fresh'); assert.equal(app.profile().models[0].id, 'grok-fixture-next')
})
test('provider failure preserves the last successful list and reports staleness', async t => {
  let fail = false
  const app = await setup(t, { fetchModels: async () => { if (fail) throw new Error('fixture-secret'); return models } })
  await app.scanner.refresh('xai'); const before = structuredClone(app.profile()); fail = true
  await app.scanner.refresh('xai', true)
  assert.deepEqual(app.profile(), before); assert.equal(app.scanner.state.xai.status, 'stale')
  assert.ok(!JSON.stringify(app.scanner.state).includes('fixture-secret'))
  assert.ok(app.scanner.state.xai.checkedAt)
})
test('custom model-only edits are preserved across restart', async t => {
  const app = await setup(t); await app.scanner.refresh('xai'); app.scanner.dispose()
  const custom = { ...app.profile(), models: [{ id: 'my-model' }] }; app.edit(custom)
  let calls = 0
  const next = installModelCatalog(app.ctx, { ...app.options, fetchModels: async () => { calls++; return models } })
  t.after(() => next.dispose()); await next.refresh('xai')
  assert.deepEqual(app.profile(), custom); assert.equal(next.state.xai.status, 'custom'); assert.equal(calls, 0)
})
test('CAS conflict rechecks ownership and preserves an intervening user edit', async t => {
  const custom = { displayName: 'Grok', headers: { 'X-Custom': 'fixture' } }
  const app = await setup(t, { onWrite: edit => edit(custom) })
  await app.scanner.refresh('xai'); assert.deepEqual(app.profile(), custom)
  assert.equal(app.scanner.state.xai.status, 'custom'); assert.equal(app.writes(), 0)
})
test('refreshes coalesce, throttle automatic retries, and allow explicit refresh', async t => {
  let calls = 0; const gate = deferred()
  const app = await setup(t, { fetchModels: async () => { calls++; await gate.promise; return models } })
  const first = app.scanner.refresh('xai'); const second = app.scanner.refresh('xai', true)
  gate.resolve(); await Promise.all([first, second]); assert.equal(calls, 1)
  await app.scanner.refresh('xai'); assert.equal(calls, 1)
  await app.scanner.refresh('xai', true); assert.equal(calls, 2)
})
test('disconnect cancels late discovery before cleaning the auto model fields', async t => {
  const gate = deferred(), entered = deferred()
  const app = await setup(t, { fetchModels: async () => { entered.resolve(); return gate.promise } })
  const pending = app.scanner.refresh('xai'); await entered.promise
  await app.scanner.disconnect('xai'); app.disconnect()
  gate.resolve(models); await pending
  assert.deepEqual(app.profile(), { displayName: 'Grok' }); assert.equal(app.writes(), 0)
  await app.scanner.refresh('xai', true); assert.equal(app.scanner.state.xai.status, 'disconnected')
})
test('sign-out strips auto catalog fields while keeping a user-edited profile', async t => {
  const app = await setup(t); await app.scanner.refresh('xai'); await app.scanner.disconnect('xai')
  assert.deepEqual(app.profile(), { displayName: 'Grok' })
  await app.scanner.connected('xai'); const custom = { ...app.profile(), displayName: 'My Grok' }; app.edit(custom)
  await app.scanner.disconnect('xai'); assert.deepEqual(app.profile(), custom)
})
test('disposal and external account removal prevent late publication', async t => {
  for (const action of ['dispose', 'disconnect']) {
    const gate = deferred(), entered = deferred()
    const app = await setup(t, { fetchModels: async () => { entered.resolve(); return gate.promise } })
    const pending = app.scanner.refresh('xai'); await entered.promise
    if (action === 'dispose') app.scanner.dispose(); else app.disconnect()
    gate.resolve(models); await pending; assert.equal(app.writes(), 0)
  }
})
test('provider parsers filter incompatible rows, validate ids, and use current metadata', () => {
  assert.throws(() => normalizeModels('xai', { models: [] }))
  assert.throws(() => normalizeModels('xai', { models: [{ id: {}, output_modalities: ['text'] }] }))
  const xai = normalizeModels('xai', { models: [...catalog.models, ...catalog.models, { id: 'image', output_modalities: ['image'] }] })
  assert.equal(xai.length, 1)
  const codex = normalizeModels('openai-codex', { models: [
    { slug: 'gpt-fixture-new', visibility: 'list', context_window: 123000, supported_reasoning_levels: [{ effort: 'high' }, { effort: 'future-unsupported' }] },
    { slug: 'private', visibility: 'hide' },
  ] })
  assert.equal(codex.length, 1); assert.equal(codex[0].contextWindow, 123000); assert.deepEqual(codex[0].reasoningEfforts, { high: 'high' })
  const router = normalizeModels('openrouter', { data: [
    { id: 'new/model', context_length: 98765, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'], top_provider: { max_completion_tokens: 10000 } },
    { id: 'new/image', architecture: { output_modalities: ['image'] }, supported_parameters: ['tools'] },
  ] })
  assert.equal(router.length, 1); assert.equal(router[0].maxTokens, 10000)
  const kimi = normalizeModels('kimi-coding', { data: [{ id: 'kimi-fixture-next', context_length: 120000, supports_image_in: true, supports_reasoning: true }] })
  assert.equal(kimi[0].contextWindow, 120000); assert.deepEqual(kimi[0].input, ['text', 'image'])
})
test('model requests use provider origins, refuse redirects, and sanitize wire data', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.x.ai/v1/language-models'); assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer fixture-secret')
    return Response.json(catalog)
  }
  assert.equal((await fetchModelCatalog('xai', { apiKey: 'fixture-secret' }, AbortSignal.timeout(1000)))[0].id, 'grok-4.6')
  globalThis.fetch = async () => Response.json({ error: 'fixture-secret' }, { status: 401 })
  await assert.rejects(fetchModelCatalog('xai', { apiKey: 'fixture-secret' }, AbortSignal.timeout(1000)), /HTTP 401/)
})
test('valid OAuth credentials resolve through the installed adapter without inference', async () => {
  const ctx = { credentials: { readRecord: async () => ({ kind: 'grant', payload: { type: 'oauth', access: 'fixture-secret', refresh: 'fixture-refresh', expires: Date.now() + 1000000 } }) } }
  for (const provider of ['xai', 'openai-codex', 'openrouter', 'kimi-coding']) {
    const auth = await catalogAuth(ctx, provider, AbortSignal.timeout(1000))
    assert.equal(auth.apiKey, 'fixture-secret')
  }
})

test('discovered catalogs resolve through the real harness adapter and update its picker list', async t => {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const shellRequire = createRequire(new URL('../../../shell/package.json', import.meta.url))
  const runtimeRequire = createRequire(shellRequire.resolve('@deepseek-ai/dsh/package.json'))
  const { apply } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
  const router = await setup(t, { provider: 'openrouter', fetchModels: async () => normalizeModels('openrouter', { data: [{ id: 'test/new', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'], context_length: 128000 }] }) })
  await router.scanner.refresh('openrouter')
  assert.equal(router.scanner.state.openrouter.status, 'fresh')
  assert.equal(router.profile().api, 'openai-completions')
  const profiles = {
    xai: { api: 'openai-responses', models },
    'openai-codex': { models: normalizeModels('openai-codex', { models: [{ slug: 'gpt-fixture-new', visibility: 'list', context_window: 128000, supported_reasoning_levels: [{ effort: 'high' }] }] }) },
    'kimi-coding': { api: 'anthropic-messages', models: normalizeModels('kimi-coding', { data: [{ id: 'kimi-fixture-new', supports_reasoning: true, context_length: 128000 }] }) },
    openrouter: router.profile(),
  }
  let adapter, current = { providers: profiles }
  const ctx = { on() {}, fiber: { state: 2 }, logger: { warn() {}, error(error) { throw error } }, get: () => undefined,
    llm: { registerConfigurableProviders: () => ({ replace() {} }), registerModelDiscovery() {}, registerAdapter(_ids, value) { adapter = value; return { replace() {} } } },
    inject(deps, fn) {
      if (deps[0] === 'settings') fn({ settings: { configure() {} }, effect() {} })
    },
  }
  apply(ctx, { providers: { get: () => current.providers } })
  assert.equal((await adapter.listModels('xai'))[0].id, 'grok-4.6')
  const info = await adapter.resolveModel('xai', 'grok-4.6')
  assert.equal(info.context.contextWindow, 500000)
  assert.ok(info.reasoning.efforts.some(x => x.id === 'xhigh'))
  for (const provider of ['openai-codex', 'kimi-coding', 'openrouter']) assert.equal((await adapter.listModels(provider)).length, 1)
  current = { providers: { ...profiles, xai: { ...profiles.xai, models: [{ ...models[0], id: 'grok-fixture-new' }] } } }
  assert.equal((await adapter.listModels('xai'))[0].id, 'grok-fixture-new')
})

test('expired OAuth refresh uses the shared record mutation and retains the grant on failure', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  let record = { kind: 'grant', payload: { type: 'oauth', access: 'old', refresh: 'fixture-refresh', expires: 0 } }, locks = 0
  const ctx = { credentials: {
    readRecord: async () => structuredClone(record),
    async modifyRecord(_key, mutate) { locks++; const next = await mutate(structuredClone(record)); if (next) record = next; return record },
  } }
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://auth.x.ai/oauth2/token'); assert.ok(init.signal)
    return Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 })
  }
  assert.equal((await catalogAuth(ctx, 'xai', AbortSignal.timeout(1000))).apiKey, 'fresh')
  assert.equal(locks, 1); assert.equal(record.payload.refresh, 'rotated')
  record.payload.expires = 0; const before = structuredClone(record)
  globalThis.fetch = async () => Response.json({ error: 'denied' }, { status: 401 })
  await assert.rejects(catalogAuth(ctx, 'xai', AbortSignal.timeout(1000)))
  assert.deepEqual(record, before)
})
