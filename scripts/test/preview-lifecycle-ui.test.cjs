const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadClient} = require('./helpers/client-harness.cjs');

const response = payload => ({ok: true, json: async () => payload});
const button = (instance, label) => instance.find(n => n.type === 'button'
  && (n.props['aria-label'] === label || n.props.children.includes(label)));
const previous = 'http://localhost:3000/previous';
const opened = 'http://127.0.0.1:60002/index.html';
const entries = [{path:'/workspace/site/index.html', name:'index.html', rel:'site/index.html'}];

async function pendingPage() {
  let resolveOpen, openSignal;
  const client = loadClient('client-ui-preview', (url, init) => {
    if (url.includes('/open?')) {
      openSignal = init.signal;
      // Deliberately deliver even after cancellation: a body/callback already
      // in flight must still be rejected by the component's navigation identity.
      return new Promise(resolve => { resolveOpen = resolve; });
    }
    return Promise.resolve(response({entries, ports:[], previewOrigin:'http://127.0.0.1:60002'}));
  }, {storage:new Map([['dshd.preview.url', previous]])});
  const instance = await client.mount({active:true}).flush();
  button(instance, 'Sources').props.onClick(); await instance.flush();
  const opening = button(instance, 'site/index.html').props.onClick();
  return {client, instance, signal:() => openSignal, async finish() {
    resolveOpen(response({url:opened, previewOrigin:'http://127.0.0.1:60002'}));
    await opening; await instance.flush();
  }};
}

test('closing Preview rejects a late page-open response and preserves the previous source', async t => {
  const f = await pendingPage(); t.after(() => f.instance.unmount());
  await f.instance.setProps({active:false}).flush();
  await f.finish();
  assert.equal(f.client.storage.get('dshd.preview.url'), previous);
  assert.equal(f.client.storage.has('dshd.preview.page'), false);
  assert.equal(f.signal()?.aborted, true);
});

test('unmounting Preview cancels page opening before it can change the next mount', async () => {
  const f = await pendingPage(); f.instance.unmount();
  await f.finish();
  assert.equal(f.client.storage.get('dshd.preview.url'), previous);
  assert.equal(f.signal()?.aborted, true);
});

test('Reload supersedes a pending workspace-page selection', async t => {
  const f = await pendingPage(); t.after(() => f.instance.unmount());
  let reloaded = 0; f.instance.guest.reload = () => reloaded++;
  button(f.instance, 'Reload').props.onClick();
  await f.finish();
  assert.equal(reloaded, 1);
  assert.equal(f.client.storage.get('dshd.preview.url'), previous);
  assert.equal(f.signal()?.aborted, true);
});

test('a replacement scan and closing Preview abort obsolete requests without showing failures', async t => {
  const requests = [];
  const client = loadClient('client-ui-preview', (url, init) => new Promise(resolve => {
    requests.push({resolve, signal:init.signal});
  }));
  const instance = await client.mount({active:true}).flush(); t.after(() => instance.unmount());
  button(instance, 'Scan again').props.onClick(); await instance.flush();
  assert.equal(requests[0].signal?.aborted, true);
  await instance.setProps({active:false}).flush();
  assert.equal(requests[1].signal?.aborted, true);
  for (const request of requests) request.resolve(response({entries, ports:[], previewOrigin:'http://127.0.0.1:60002'}));
  await instance.flush();
  assert.equal(instance.find(n => n.type === 'webview'), undefined);
  assert.equal(instance.find(n => n.props.role === 'alert'), undefined);
});

test('Back, Forward, and dismissing Sources supersede a pending page selection', async t => {
  for (const action of ['Back', 'Forward', 'Back to preview', 'Sources']) {
    await t.test(action, async () => {
      const f = await pendingPage();
      let navigation = '';
      f.instance.guest.goBack = () => { navigation = 'Back'; };
      f.instance.guest.goForward = () => { navigation = 'Forward'; };
      button(f.instance, action).props.onClick();
      await f.finish();
      assert.equal(f.client.storage.get('dshd.preview.url'), previous);
      assert.equal(f.signal()?.aborted, true);
      if (action === 'Back' || action === 'Forward') assert.equal(navigation, action);
      assert.equal(button(f.instance, 'Back to preview'), undefined);
      f.instance.unmount();
    });
  }
});

test('a fresh activation auto-opens current discovery, never the previous hidden scan', async t => {
  const scans = [], openedPaths = [];
  const client = loadClient('client-ui-preview', (url) => {
    if (url.includes('/open?')) {
      openedPaths.push(new URL(url, 'http://fixture').searchParams.get('path'));
      return Promise.resolve(response({url:opened, previewOrigin:'http://127.0.0.1:60002'}));
    }
    return new Promise(resolve => scans.push(resolve));
  });
  const instance = await client.mount({active:false}).flush(); t.after(() => instance.unmount());
  assert.equal(scans.length, 0);
  await instance.setProps({active:true}).flush();
  await instance.setProps({active:false}).flush();
  scans[0](response({entries:[{...entries[0],path:'/old/index.html'}], ports:[], previewOrigin:'http://127.0.0.1:60001'}));
  await instance.flush(); assert.deepEqual(openedPaths, []);
  await instance.setProps({active:true}).flush();
  scans[1](response({entries, ports:[], previewOrigin:'http://127.0.0.1:60002'}));
  await instance.flush();
  assert.deepEqual(openedPaths, [entries[0].path]);
  assert.equal(instance.find(n => n.type === 'webview').props.src, opened);
  assert.equal(client.storage.get('dshd.preview.page'), entries[0].path);
});

test('late restart healing cannot replace a source after Preview closes', async t => {
  let finishHeal, healSignal, opens = 0;
  const oldOrigin = 'http://127.0.0.1:60001';
  const client = loadClient('client-ui-preview', (url, init) => {
    if (url.includes('/open?')) {
      if (++opens === 1) return Promise.resolve(response({url:oldOrigin+'/index.html',previewOrigin:oldOrigin}));
      healSignal = init.signal;
      return new Promise(resolve => { finishHeal = resolve; });
    }
    return Promise.resolve(response({entries:[], ports:[], previewOrigin:'http://127.0.0.1:60002'}));
  }, {storage:new Map([
    ['dshd.preview.url',oldOrigin+'/index.html'], ['dshd.preview.origin',oldOrigin],
    ['dshd.preview.page',entries[0].path],
  ])});
  const instance = await client.mount().flush(); t.after(() => instance.unmount());
  assert.ok(instance.find(n => n.type === 'webview'), 'initial restore mounted the native guest');
  instance.guest.emit('did-fail-load', {isMainFrame:true,errorCode:-102,validatedURL:oldOrigin+'/index.html'});
  await instance.setProps({active:false}).flush();
  finishHeal(response({url:opened,previewOrigin:'http://127.0.0.1:60002'})); await instance.flush();
  assert.equal(healSignal?.aborted, true);
  assert.equal(client.storage.get('dshd.preview.url'),oldOrigin+'/index.html');
  assert.equal(client.storage.get('dshd.preview.origin'),oldOrigin);
});

test('superseding a page request with an address ignores its late failure', async t => {
  let rejectOpen, signal;
  const client = loadClient('client-ui-preview', (url, init) => {
    if (url.includes('/open?')) { signal = init.signal; return new Promise((_, reject) => { rejectOpen = reject; }); }
    return Promise.resolve(response({entries, ports:[], previewOrigin:'http://127.0.0.1:60002'}));
  }, {storage:new Map([['dshd.preview.url', previous]])});
  const instance = await client.mount().flush(); t.after(() => instance.unmount());
  button(instance, 'Sources').props.onClick(); await instance.flush();
  const opening = button(instance, 'site/index.html').props.onClick();
  instance.find(n => n.type === 'input').props.onChange({target:{value:'http://localhost:5173/new'}}); await instance.flush();
  instance.find(n => n.type === 'form').props.onSubmit({preventDefault(){}}); await instance.flush();
  rejectOpen(Error('Previous workspace no longer exists')); await opening; await instance.flush();
  assert.equal(signal?.aborted, true);
  assert.equal(client.storage.get('dshd.preview.url'), 'http://localhost:5173/new');
  assert.equal(instance.find(n => n.props.role === 'alert'), undefined);
});
