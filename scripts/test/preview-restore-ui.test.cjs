const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadClient} = require('./helpers/client-harness.cjs');
const response = payload => ({ok:true,json:async()=>payload});
const oldOrigin = 'http://127.0.0.1:60001';
const newOrigin = 'http://127.0.0.1:60002';
const route = '/nested%20page.html?view=wide#details';
const pagePath = '/workspace/site/index.html';
const saved = () => new Map([
  ['dshd.preview.url',oldOrigin+route], ['dshd.preview.origin',oldOrigin],
  ['dshd.preview.page',pagePath],
]);
const frame = instance => instance.find(n=>n.type==='webview'||n.type==='iframe');
const button = (instance,label) => instance.find(n=>n.type==='button'
  && (n.props['aria-label']===label||n.props.children.includes(label)));

test('a conversation does not inherit another game or the legacy global address', async t => {
  const storage = new Map([
    ['dshd.preview.url', 'http://127.0.0.1:5173/old-game'],
    ['dshd.preview.url:another-session', 'http://127.0.0.1:4177/other-game'],
  ]);
  const client = loadClient('client-ui-preview', async () => response({ entries: [], ports: [], previewOrigin: null }),
    { storage, webview: false });
  const instance = await client.mount({ sessionId: 'new-session' }).flush();
  t.after(() => instance.unmount());
  assert.equal(frame(instance), undefined);
  assert.equal(storage.has('dshd.preview.url:new-session'), false);
  instance.find(n => n.type === 'input').props.onChange({ target: { value: 'http://127.0.0.1:5174/new-game' } });
  await instance.flush();
  instance.find(n => n.type === 'form').props.onSubmit({ preventDefault() {} });
  await instance.flush();
  assert.equal(storage.get('dshd.preview.url:new-session'), 'http://127.0.0.1:5174/new-game');
  assert.equal(storage.get('dshd.preview.url:another-session'), 'http://127.0.0.1:4177/other-game');
});

test('a Vite source page is offered as a server project, never auto-opened raw', async t => {
  let opened = 0;
  const client = loadClient('client-ui-preview', async url => {
    if (url.includes('/open?')) opened += 1;
    return response({ entries: [{ path: '/game/index.html', rel: 'index.html', needsServer: true }],
      ports: [4177], previewOrigin: newOrigin });
  }, { webview: false });
  const instance = await client.mount({ sessionId: 'game' }).flush();
  t.after(() => instance.unmount());
  assert.equal(opened, 0);
  assert.equal(frame(instance), undefined);
  assert.ok(instance.find(n => n.type === 'h3' && n.props.children.some(text => String(text).includes('may need its dev server'))));
});

for (const webview of [true,false]) {
  test(`${webview?'native':'iframe'} Preview resolves a saved workspace origin before mounting the frame`,async t=>{
    let finish, request;
    const client=loadClient('client-ui-preview',(url,init)=>{
      if(url.includes('/open?')) { request={url,signal:init.signal}; return new Promise(resolve=>{finish=resolve}); }
      return Promise.resolve(response({entries:[],ports:[],previewOrigin:newOrigin}));
    },{storage:saved(),webview});
    const instance=await client.mount().flush();t.after(()=>instance.unmount());
    assert.equal(frame(instance),undefined,'never load the previous process’s port while resolving');
    assert.equal(new URL(request.url,'http://fixture').searchParams.get('path'),pagePath);
    finish(response({previewOrigin:newOrigin,url:newOrigin+'/index.html'}));await instance.flush();
    const target=new URL(frame(instance).props.src);target.searchParams.delete('__dshd');
    assert.equal(target.href,newOrigin+route);
    assert.equal(client.storage.get('dshd.preview.origin'),newOrigin);
    assert.equal(client.storage.get('dshd.preview.url'),newOrigin+route);
    assert.equal(client.storage.get('dshd.preview.page'),pagePath);
  });
}

test('saved dev-server addresses are not remapped even when an older workspace source is remembered',async t=>{
  const storage=saved();storage.set('dshd.preview.url','http://127.0.0.1:5173/project?q=1#view');
  const calls=[];
  const client=loadClient('client-ui-preview',async url=>{
    calls.push(url);return response({entries:[],ports:[5173],previewOrigin:newOrigin});
  },{storage,webview:false});
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.ok(frame(instance).props.src.startsWith('http://127.0.0.1:5173/project?'));
  assert.equal(calls.some(url=>url.includes('/open?')),false);
  assert.equal(storage.get('dshd.preview.url'),'http://127.0.0.1:5173/project?q=1#view');
});

test('missing saved workspace pages show a retryable failure without loading an old port',async t=>{
  let fail=true,opens=0;
  const client=loadClient('client-ui-preview',async url=>{
    if(url.includes('/open?')) { opens++;return fail?{ok:false,status:404,json:async()=>({error:'HTML file not found'})}:response({previewOrigin:newOrigin,url:newOrigin+'/index.html'}); }
    return response({entries:[],ports:[],previewOrigin:newOrigin});
  },{storage:saved(),webview:false});
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.equal(frame(instance),undefined);
  assert.equal(opens,1,'failure must not cause an automatic retry loop');
  assert.ok(instance.find(n=>n.type==='p'&&n.props.children.includes('HTML file not found')));
  fail=false;button(instance,'Try again').props.onClick();await instance.flush();
  assert.equal(opens,2);assert.ok(frame(instance).props.src.startsWith(newOrigin));
});

test('a cancelled restore retries on activation and rejects the obsolete response',async t=>{
  const requests=[];
  const client=loadClient('client-ui-preview',(url,init)=>{
    if(url.includes('/open?')) return new Promise(resolve=>requests.push({resolve,signal:init.signal}));
    return Promise.resolve(response({entries:[],ports:[],previewOrigin:newOrigin}));
  },{storage:saved(),webview:false});
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  await instance.setProps({active:false}).flush();assert.equal(requests[0].signal.aborted,true);
  requests[0].resolve(response({url:newOrigin+'/index.html',previewOrigin:newOrigin}));await instance.flush();
  assert.equal(frame(instance),undefined);assert.equal(client.storage.get('dshd.preview.origin'),oldOrigin);
  await instance.setProps({active:true}).flush();assert.equal(requests.length,2);
  requests[1].resolve(response({url:newOrigin+'/index.html',previewOrigin:newOrigin}));await instance.flush();
  assert.ok(frame(instance).props.src.startsWith(newOrigin));
});

test('a manually entered address supersedes startup restoration',async t=>{
  let finish,signal;
  const client=loadClient('client-ui-preview',(url,init)=>{
    if(url.includes('/open?')) {signal=init.signal;return new Promise(resolve=>{finish=resolve});}
    return Promise.resolve(response({entries:[],ports:[],previewOrigin:newOrigin}));
  },{storage:saved(),webview:false});
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  instance.find(n=>n.type==='input').props.onChange({target:{value:'http://localhost:5173/my-project'}});await instance.flush();
  instance.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await instance.flush();
  assert.equal(signal.aborted,true);
  finish(response({url:newOrigin+'/index.html',previewOrigin:newOrigin}));await instance.flush();
  assert.ok(frame(instance).props.src.startsWith('http://localhost:5173/my-project?'));
  assert.equal(client.storage.get('dshd.preview.url'),'http://localhost:5173/my-project');
});

test('legacy saved workspace URLs without a page key resolve through the original probe route',async t=>{
  const storage=saved();storage.delete('dshd.preview.page');
  const calls=[];
  const client=loadClient('client-ui-preview',async url=>{
    calls.push(url);return response({entries:[],ports:[],previewOrigin:newOrigin});
  },{storage,webview:false});
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.equal(calls.some(url=>url.includes('/open?')),false);
  assert.ok(frame(instance).props.src.startsWith(newOrigin+'/nested%20page.html?'));
});

test('invalid restored origins are refused without persisting an external address',async t=>{
  for(const previewOrigin of ['https://example.com','http://127.0.0.1:60002/wrong','javascript:alert(1)']) {
    await t.test(previewOrigin,async()=>{
      const storage=saved();
      const client=loadClient('client-ui-preview',async url=>response(url.includes('/open?')
        ? {previewOrigin,url:previewOrigin+'/index.html'} : {entries:[],ports:[],previewOrigin:newOrigin}),{storage,webview:false});
      const instance=await client.mount().flush();
      assert.equal(frame(instance),undefined);
      assert.equal(storage.get('dshd.preview.origin'),oldOrigin);
      assert.ok(button(instance,'Try again'));
      instance.unmount();
    });
  }
});

const workspacePage = {path:pagePath, name:'index.html', rel:'index.html'};

test('a failed loopback restore falls back to workspace HTML once',async t=>{
  const storage=new Map([
    ['dshd.preview.url','http://127.0.0.1:5173/project?q=1#view'],
    ['dshd.preview.origin',oldOrigin],
    ['dshd.preview.page',pagePath],
  ]);
  let opens=0;
  const client=loadClient('client-ui-preview',async url=>{
    if(url.includes('/open?')){
      opens++;
      return response({previewOrigin:newOrigin,url:newOrigin+'/index.html'});
    }
    return response({entries:[workspacePage],ports:[],previewOrigin:newOrigin});
  },{storage});
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.ok(frame(instance).props.src.startsWith('http://127.0.0.1:5173/project?'));
  assert.equal(opens,0,'must not remap a live-looking dev server on mount');
  instance.guest.emit('did-fail-load',{isMainFrame:true,errorCode:-102,validatedURL:'http://127.0.0.1:5173/project?q=1#view'});
  instance.guest.emit('did-fail-load',{isMainFrame:true,errorCode:-102,validatedURL:'http://127.0.0.1:5173/project?q=1#view'});
  await instance.flush();
  assert.equal(opens,1,'fallback must not loop');
  assert.ok(frame(instance).props.src.startsWith(newOrigin+'/index.html'));
  assert.equal(client.storage.get('dshd.preview.origin'),newOrigin);
  assert.equal(client.storage.get('dshd.preview.page'),pagePath);
});

test('a failed public address does not steal workspace HTML',async t=>{
  const storage=new Map([['dshd.preview.url','https://www.google.com/']]);
  let opens=0;
  const client=loadClient('client-ui-preview',async url=>{
    if(url.includes('/open?')){opens++;return response({previewOrigin:newOrigin,url:newOrigin+'/index.html'});}
    return response({entries:[workspacePage],ports:[],previewOrigin:newOrigin});
  },{storage});
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.ok(frame(instance).props.src.startsWith('https://www.google.com/'));
  instance.guest.emit('did-fail-load',{isMainFrame:true,errorCode:-102,validatedURL:'https://www.google.com/'});
  await instance.flush();
  assert.equal(opens,0);
  assert.ok(instance.find(n=>n.type==='h3'&&String(n.props.children).includes("Couldn't reach")));
  assert.ok(frame(instance)===undefined || frame(instance).props.src.startsWith('https://www.google.com/'));
});
