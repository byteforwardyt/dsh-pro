const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadClient} = require('./helpers/client-harness.cjs');

const response = payload => ({ok: true, json: async () => payload});
const entries = [{path:'/workspace/site/index.html', name:'index.html', rel:'site/index.html'}];
const discovery = {entries, ports:[], previewOrigin:'http://127.0.0.1:60002'};

test('preview server settings are an opt-in disclosure, not a permanent header form', async t => {
  const client = loadClient('client-ui-preview', async () => response(discovery));
  const pane = await client.mount({active:true, sessionId:'s1'}).flush();
  t.after(() => pane.unmount());
  const button = () => pane.find(node => node.props['aria-label'] === 'Preview server');
  const panel = () => pane.find(node => node.props.className === 'dshd-pv-server-panel');
  assert.equal(button().props['aria-expanded'], false);
  assert.equal(panel().props.hidden, true);
  assert.equal(button().props['aria-controls'], panel().props.id);
  button().props.onClick(); await pane.flush();
  assert.equal(panel().props.hidden, false);
  panel().props.onKeyDown({key:'Escape',preventDefault(){}}); await pane.flush();
  assert.equal(panel().props.hidden, true);
  button().props.onClick(); await pane.flush();
  await pane.setProps({active:true, sessionId:'s2'}).flush();
  assert.equal(panel().props.hidden, true, 'another chat does not inherit the open server drawer');
  assert.match(panel().props.id, /s2$/);
});

test('a saved managed URL waits for its server, never auto-opens a reused port or unrelated HTML', async t => {
  const storage = new Map([
    ['dshd.preview.url:s1', 'http://127.0.0.1:55444/'],
    ['dshd.preview.managed:s1', 'http://127.0.0.1:55444/'],
  ]);
  const client = loadClient('client-ui-preview', async () => response(discovery), {storage});
  const pane = await client.mount({active:true, sessionId:'s1'}).flush();
  t.after(() => pane.unmount());
  assert.equal(pane.find(node => node.type === 'webview'), undefined);
});

/** A stand-in for the browser's EventSource that the test can push through. */
function eventSourceFactory() {
  const instances = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); instances.push(this); }
    addEventListener(type, fn) { (this.listeners.get(type) || this.listeners.set(type, new Set()).get(type)).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    close() { this.closed = true; }
    emit(type, data) { for (const fn of [...(this.listeners.get(type) || [])]) fn({data: JSON.stringify({ sessionId: 's1', ...data })}); }
  }
  return {FakeEventSource, instances};
}

function sessions(cwd) {
  return selector => selector({byId: {s1: {cwd}}});
}

test('the scan is scoped to the conversation workspace, not every open folder', async t => {
  const asked = [];
  const {FakeEventSource} = eventSourceFactory();
  const client = loadClient('client-ui-preview', url => {
    asked.push(url);
    return Promise.resolve(response({entries: [], ports: [], previewOrigin: null}));
  }, {globals: {EventSource: FakeEventSource}});
  const instance = await client.mount({active: true, sessionId: 's1', useSessions: sessions('/workspace/site')}).flush();
  t.after(() => instance.unmount());

  const probe = asked.find(url => url.includes('/preview/probe'));
  assert.ok(probe, 'the pane scans on activation');
  assert.ok(probe.includes('root=' + encodeURIComponent('/workspace/site')),
    'the scan names the conversation workspace so another project\'s pages cannot appear');
});

test('a pane with no conversation workspace still scans, unscoped', async t => {
  const asked = [];
  const {FakeEventSource} = eventSourceFactory();
  const client = loadClient('client-ui-preview', url => {
    asked.push(url);
    return Promise.resolve(response({entries: [], ports: [], previewOrigin: null}));
  }, {globals: {EventSource: FakeEventSource}});
  const instance = await client.mount({active: true}).flush();
  t.after(() => instance.unmount());

  const probe = asked.find(url => url.includes('/preview/probe'));
  assert.ok(probe && !probe.includes('root='), 'the standalone pane keeps its every-workspace scan');
});

test('switching the conversation workspace rescans against the new folder', async t => {
  const asked = [];
  const {FakeEventSource} = eventSourceFactory();
  const client = loadClient('client-ui-preview', url => {
    asked.push(url);
    return Promise.resolve(response({entries: [], ports: [], previewOrigin: null}));
  }, {globals: {EventSource: FakeEventSource}});
  const instance = await client.mount({active: true, sessionId: 's1', useSessions: sessions('/workspace/one')}).flush();
  t.after(() => instance.unmount());
  await instance.setProps({active: true, sessionId: 's1', useSessions: sessions('/workspace/two')}).flush();

  const probes = asked.filter(url => url.includes('/preview/probe'));
  assert.ok(probes.at(-1).includes(encodeURIComponent('/workspace/two')),
    'the pane follows the conversation rather than holding the first workspace it saw');
});

test('an agent address intent navigates the pane and is applied once', async t => {
  const {FakeEventSource, instances} = eventSourceFactory();
  const client = loadClient('client-ui-preview', () => Promise.resolve(response(discovery)),
    {globals: {EventSource: FakeEventSource}});
  const instance = await client.mount({active: true, sessionId: 's1', useSessions: sessions('/workspace/site')}).flush();
  t.after(() => instance.unmount());

  const stream = instances.find(source => source.url.includes('/preview/events'));
  assert.ok(stream, 'the pane subscribes to agent intents');

  stream.emit('preview', {kind: 'url', url: 'http://localhost:5173/', id: 1});
  await instance.flush();
  assert.equal(client.storage.get('dshd.preview.url:s1'), 'http://localhost:5173/');

  // A reconnect replays the retained intent. Acting on it again would drag the
  // pane back from wherever the user has since navigated.
  client.storage.set('dshd.preview.url:s1', 'http://localhost:9999/');
  stream.emit('preview', {kind: 'url', url: 'http://localhost:5173/', id: 1});
  await instance.flush();
  assert.equal(client.storage.get('dshd.preview.url:s1'), 'http://localhost:9999/');
});

test('an agent file intent opens the page through the separate preview origin', async t => {
  const {FakeEventSource, instances} = eventSourceFactory();
  const asked = [];
  const client = loadClient('client-ui-preview', url => {
    asked.push(url);
    if (url.includes('/preview/open')) {
      return Promise.resolve(response({url: 'http://127.0.0.1:60002/index.html', previewOrigin: 'http://127.0.0.1:60002'}));
    }
    return Promise.resolve(response(discovery));
  }, {globals: {EventSource: FakeEventSource}});
  const instance = await client.mount({active: true, sessionId: 's1', useSessions: sessions('/workspace/site')}).flush();
  t.after(() => instance.unmount());

  const stream = instances.find(source => source.url.includes('/preview/events'));
  stream.emit('preview', {kind: 'file', path: '/workspace/site/index.html', id: 7});
  await instance.flush();

  assert.ok(asked.some(url => url.includes('/preview/open') && url.includes(encodeURIComponent('/workspace/site/index.html'))),
    'the file intent resolves through the fenced open route rather than loading a path directly');
  assert.equal(client.storage.get('dshd.preview.url:s1'), 'http://127.0.0.1:60002/index.html');
});

test('a malformed intent cannot break the stream or move the pane', async t => {
  const {FakeEventSource, instances} = eventSourceFactory();
  const client = loadClient('client-ui-preview', () => Promise.resolve(response(discovery)),
    {globals: {EventSource: FakeEventSource}});
  const instance = await client.mount({active: true, sessionId: 's1', useSessions: sessions('/workspace/site')}).flush();
  t.after(() => instance.unmount());
  const stream = instances.find(source => source.url.includes('/preview/events'));

  for (const fn of [...(stream.listeners.get('preview') || [])]) fn({data: 'not json'});
  stream.emit('preview', {kind: 'url'});
  stream.emit('preview', {});
  await instance.flush();
  assert.equal(client.storage.has('dshd.preview.url:s1'), false);

  stream.emit('preview', {kind: 'url', url: 'http://localhost:4321/', id: 2});
  await instance.flush();
  assert.equal(client.storage.get('dshd.preview.url:s1'), 'http://localhost:4321/',
    'the listener survives bad input and still serves the next real intent');
});

test('closing the pane closes its intent stream', async () => {
  const {FakeEventSource, instances} = eventSourceFactory();
  const client = loadClient('client-ui-preview', () => Promise.resolve(response(discovery)),
    {globals: {EventSource: FakeEventSource}});
  const instance = await client.mount({active: true}).flush();
  instance.unmount();
  const stream = instances.find(source => source.url.includes('/preview/events'));
  assert.equal(stream.closed, true);
});

test('choosing a dev server survives retained intents on replacement streams and remount', async t => {
  const {FakeEventSource, instances} = eventSourceFactory();
  const client = loadClient('client-ui-preview', async () => response({entries: [], ports: [4173, 4179]}),
    {globals: {EventSource: FakeEventSource}});
  const pane = await client.mount({active:true, sessionId:'s1'}).flush();
  const intent = {kind:'url', url:'http://127.0.0.1:4173/', id:20, at:100};
  instances.at(-1).emit('preview', intent); await pane.flush();
  pane.find(n => n.type === 'button' && n.props.children.includes('Sources')).props.onClick(); await pane.flush();
  assert.equal(pane.find(n => n.props.className === 'dshd-pv-canvas').props.style.visibility, 'hidden');
  pane.find(n => n.type === 'button' && n.props.children.includes('127.0.0.1:4179')).props.onClick(); await pane.flush();
  instances.at(-1).emit('preview', intent); await pane.flush();
  assert.equal(pane.find(n => n.type === 'webview').props.src, 'http://127.0.0.1:4179/');
  assert.equal(pane.find(n => n.props.className === 'dshd-pv-canvas').props.style.visibility, undefined);
  pane.unmount();
  const restored = await client.mount({active:true, sessionId:'s1'}).flush(); t.after(() => restored.unmount());
  instances.at(-1).emit('preview', intent); await restored.flush();
  assert.equal(restored.find(n => n.type === 'webview').props.src, 'http://127.0.0.1:4179/');
});

test('two chats retain independent preview targets and browser partitions', async t => {
  const {FakeEventSource, instances} = eventSourceFactory();
  const client = loadClient('client-ui-preview', async () => response({entries: [], ports: []}),
    {globals: {EventSource: FakeEventSource}});
  const one = await client.mount({active:true, sessionId:'s1'}).flush();
  const streamOne = instances.at(-1);
  const two = await client.mount({active:true, sessionId:'s2'}).flush();
  const streamTwo = instances.at(-1);
  t.after(() => {one.unmount(); two.unmount();});
  streamOne.emit('preview', {sessionId:'s1', kind:'url', url:'http://localhost:4173/', id:1});
  streamTwo.emit('preview', {sessionId:'s2', kind:'url', url:'http://localhost:4179/', id:2});
  await one.flush(); await two.flush();
  instances.filter(s => !s.closed).forEach(s => s.emit('preview', {sessionId:'other', kind:'url', url:'http://localhost:9999/', id:3}));
  await one.flush(); await two.flush();
  assert.equal(one.find(n => n.type === 'webview').props.src, 'http://localhost:4173/');
  assert.equal(two.find(n => n.type === 'webview').props.src, 'http://localhost:4179/');
  assert.notEqual(one.find(n => n.type === 'webview').props.partition, two.find(n => n.type === 'webview').props.partition);
});
