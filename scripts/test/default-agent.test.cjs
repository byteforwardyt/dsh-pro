const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('the default-agent plugin preserves saved selection and only configures its settings form', async () => {
  const { apply } = await import('../../plugins/client-ui-agent-default/lib/index.js');
  for (const original of ['standard', 'dispatch', 'my-custom']) {
    let defaultId = original, configured = 0;
    const ctx = { effect: fn => fn(), settings: {
      configure(options) { assert.equal(options.auto, false); configured++; return () => {}; },
      mutate: () => assert.fail('selection belongs to the registry, not startup UI'),
    } };
    await apply(ctx);
    assert.equal(defaultId, original);
    assert.equal(configured, 1);
    defaultId = 'minimal';
    await apply(ctx);
    assert.equal(defaultId, 'minimal');
  }
});

test('legacy selected preset identity is preserved by the pre-boot migration', () => {
  const { translateSettings } = require('../../shell/src/upstream-migration.cjs');
  for (const id of ['standard', 'dispatch', 'dsh-agent', 'my-custom']) {
    assert.deepEqual(translateSettings({'agent-presets': {default: id}}), [{id: 'agent-preset-registry', config: {default: 'dsh-agent', selectedDefault: id}}]);
  }
});

test('preset seats are hidden and existing management is nested under Advanced', () => {
  let exported;
  const h = (type, props, ...children) => ({ type, props, children });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../plugins/client-ui-agent-default/lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => ({ createElement: h })); } } },
  });
  const upstream = { options: { id: 'agent-presets', order: 20 }, locale: 'settings.agentPreset', inject: () => {}, component: () => {} };
  const registered = [], cleanups = [];
  let loaded = false, changed, unsubscribed = false;
  const slots = { entries: () => loaded ? [upstream] : [], inject: (_, fn) => cleanups.push(fn()),
    subscribe: (key, fn) => { assert.equal(key, 'settings.section'); changed=fn; return () => {unsubscribed=true}; },
    register: (options, component) => { registered.push({ options, component }); return () => {}; } };
  const original = slots.entries;
  exported.apply({ slots, effect: fn => cleanups.push(fn()) });
  assert.equal(registered.length, 3);
  for (const row of registered.slice(0, 3)) { assert.equal(row.component(), null); assert.equal(row.options.priority, -100); }
  loaded=true; changed();
  assert.equal(registered.length,4,'register a real renderer override after async metadata arrives');
  const advanced = registered[3];
  assert.equal(advanced.options.id, 'agent-presets');
  assert.equal(advanced.options.label(), 'Advanced');
  assert.equal(advanced.options.inject, upstream.inject);
  assert.equal(advanced.options.locale, upstream.locale);
  const props = { hooks: { sentinel: true } };
  const tree = advanced.component(props);
  const details = tree.children.find(child => child.type === 'details');
  assert.equal(details.props, null); // Closed by default.
  assert.equal(details.children.at(-1).type, upstream.component);
  assert.equal(details.children.at(-1).props, props);
  assert.equal(slots.entries('settings.section').length, 1);
  assert.equal(slots.entries('other').length, 1);
  cleanups.filter(Boolean).reverse().forEach(fn => fn());
  assert.equal(slots.entries, original);
  assert.equal(unsubscribed,true);
});
