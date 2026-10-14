const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../plugins/client-ui-model-visibility/lib/client.js'), 'utf8');
function client(fetch = async () => ({ ok: true, json: async () => ({ selections: {}, revision: 0 }) })) {
  let exported;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => ({})); } } }, fetch, AbortSignal });
  return exported;
}
const plain = value => JSON.parse(JSON.stringify(value));
const directory = { current: { provider: 'a', model: 'one' }, routable: true, failures: [], groups: [
  { id: 'a', models: [{ id: 'one', reasoning: { efforts: ['high'] } }, { id: 'two' }] },
  { id: 'b', models: [{ id: 'one' }, { id: 'two' }] },
] };
test('native provider editor retains its original child-slot ownership; visibility has a separate navigation entry', () => {
  const children = { 'settings.models.provider-card': { kind: 'keyed', scope: 'root' }, 'settings.models.footer': { kind: 'list', scope: 'root' } };
  const catalog = { options: { id: 'models', priority: 0 }, children, component: () => {}, inject: () => ({ controller: {} }) };
  const entries = [], disposed = [];
  let cleanup;
  const slots = {
    inject: (_, fn) => { cleanup = fn(); }, entries: () => [catalog],
    register: (options, component) => { entries.push({ options, component }); return () => disposed.push(options.id); },
  };
  client().apply({ effect() {}, remote: { $on() {} }, on() {}, slots });
  assert.equal(entries.length, 1, 'Never clone or shadow the native provider editor');
  const models = entries.find(entry => entry.options.id === 'model-visibility');
  assert.equal(models.options.label(), 'Models');
  assert.notEqual(models.component, catalog.component);
  const advanced = slots.entries('settings.section')[0];
  assert.equal(advanced.options.id, 'models');
  assert.equal(advanced.options.label(), 'Model connections (advanced)');
  assert.equal(advanced.children, children); assert.equal(advanced.inject, catalog.inject);
  assert.equal(catalog.options.label, undefined, 'Navigation must not mutate the native registration');
  cleanup(); assert.deepEqual(disposed, ['model-visibility']);
  assert.equal(slots.entries('settings.section')[0], catalog);
});
test('defaults retain all models; curated providers hide new models independently', () => {
  const { project } = client();
  assert.deepEqual(plain(project(directory, {})), directory);
  const result = project(directory, { a: ['one'], b: ['two'] });
  assert.deepEqual(plain(result.groups.map(g => g.models.map(m => m.id))), [['one'], ['two']]);
  assert.equal(directory.groups[0].models.length, 2);
});
test('hidden current model retains routing, metadata and effort until switching', () => {
  const { project } = client();
  const result = project(directory, { a: [], b: [] });
  assert.equal(result.routable, true);
  assert.deepEqual(plain(result.current), directory.current);
  assert.deepEqual(plain(result.groups[0].models[0].reasoning), { efforts: ['high'] });
  assert.equal(project({ ...directory, current: null }, { a: [], b: [] }).groups.length, 0);
});
test('directory adapter filters composer store and slash load without modifying source', async () => {
  const { installProjection } = client(); let notify, prefs = { selections: { a: ['one'], b: [] } };
  const originalStore = { getSnapshot: () => directory, subscribe: () => () => {} };
  let selection;
  const raw = { store: originalStore, load: async () => directory, select: async s => { selection = s; } };
  const resolver = { directoryFor: () => raw }, original = resolver.directoryFor;
  const restore = installProjection(resolver, { getSnapshot: () => prefs, subscribe: fn => { notify = fn; return () => {}; } });
  const face = resolver.directoryFor('session');
  assert.equal(resolver.directoryFor('session'), face);
  assert.equal(face.store.getSnapshot(), face.store.getSnapshot());
  assert.equal(face.store.getSnapshot().groups.length, 1);
  assert.equal((await face.load()).groups.length, 1);
  let changed = 0; face.store.subscribe(() => changed++);
  prefs = { selections: {} }; notify(); assert.equal(changed, 1);
  assert.equal(face.store.getSnapshot().groups.length, 2);
  await face.select({ provider: 'b', model: 'two' }); assert.equal(selection.model, 'two');
  assert.equal(raw.store, originalStore);
  restore(); assert.equal(resolver.directoryFor, original);
});
test('saving uses host revision and survives a fresh preferences controller', async () => {
  let saved = { selections: {}, revision: 0 };
  const { createPreferences } = client(async (_, options) => {
    if (options.body) { const body = JSON.parse(options.body); assert.equal(body.revision, saved.revision);
      saved = { selections: { ...saved.selections, [body.provider]: body.models }, revision: saved.revision + 1 }; }
    return { ok: true, json: async () => saved };
  });
  const first = createPreferences(); await first.refresh(); await first.save('a', ['two']);
  const next = createPreferences(); await next.refresh();
  assert.deepEqual(plain(next.getSnapshot().selections), { a: ['two'] });
});
test('failed writes keep last saved selection and surface an error', async () => {
  const { createPreferences } = client(async (_, options) => options.body ? { ok: false, status: 409 }
    : { ok: true, json: async () => ({ selections: { a: ['one'] }, revision: 1 }) });
  const prefs = createPreferences(); await prefs.refresh(); await prefs.save('a', []);
  assert.deepEqual(plain(prefs.getSnapshot().selections), { a: ['one'] });
  assert.match(prefs.getSnapshot().error, /another window/);
  assert.equal(prefs.getSnapshot().busy, false);
});
test('host request validation rejects malformed and prototype keys', async () => {
  const { validSelection } = await import('../../plugins/client-ui-model-visibility/lib/index.js');
  assert.ok(validSelection({ provider: 'a', models: [], revision: 0 }));
  assert.ok(validSelection({ provider: 'a', models: null, revision: 0 }));
  for (const value of [{}, { provider: '__proto__', models: [], revision: 0 }, { provider: 'a', models: [3], revision: 0 }, { provider: 'a', models: [], revision: -1 }]) assert.ok(!validSelection(value));
});
test('host routes isolate catalog failure, persist bounded choices, restore defaults and reject foreign origins', async () => {
  const { apply } = await import('../../plugins/client-ui-model-visibility/lib/index.js');
  let handler, revision = 0, selections = {};
  apply({ effect: fn => fn(), webServer: { register: spec => { handler = spec.handler; } }, settings: {
    configure: () => () => {}, describe: () => [{ ns: 'desktop-model-visibility', revision }],
    mutate: async (_, [op], rev) => { assert.equal(rev, revision); if (op.op === 'unset') delete selections[op.path[1]]; else selections[op.path[1]] = op.value; revision++; },
  }, llm: { listProviders: () => [{ id: 'a' }, { id: 'b' }], listModels: async id => { if (id === 'b') throw Error('secret'); return [{ id: 'one', name: 'One' }]; } } }, { selections: { get: () => selections } });
  async function call(url, body, extra = {}) {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url, headers: { host: '127.0.0.1:9000', 'content-type': 'application/json', ...extra } });
    let status, data; await handler(req, { writeHead: code => { status = code; }, end: text => { data = JSON.parse(text); } });
    return { status, data };
  }
  assert.equal((await call('/dsh-model-visibility', undefined, { origin: 'http://localhost:8000' })).status, 403);
  const catalog = await call('/dsh-model-visibility/catalog'); assert.equal(catalog.data.groups.length, 2);
  assert.ok(catalog.data.groups[1].error); assert.ok(!JSON.stringify(catalog).includes('secret'));
  const saved = await call('/dsh-model-visibility', { provider: 'a', models: ['one', 'one'], revision });
  assert.deepEqual(saved.data.selections.a, ['one']);
  await call('/dsh-model-visibility', { provider: 'a', models: null, revision }); assert.deepEqual(selections, {});
});
