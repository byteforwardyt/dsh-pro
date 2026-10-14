const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const KEY='dshd.accounts.onboarding-dismissed';
const account={key:'fixture',provider:'openai-codex',label:'Fixture',configured:false,methods:[{id:'oauth'}]};
const button=(view,key)=>view.find(n=>n.type==='button'&&n.props.key===key);

function fixture({storage=new Map(),accounts=[account],reply={ok:true,status:200,json:async()=>({})},slot='settings.onboarding'}={}) {
  const streams=[], timers=new Map(), calls=[], opened=[];let completed=0;
  class EventSource {
    constructor(){streams.push(this);queueMicrotask(()=>{if(!this.closed&&accounts!==null)this.onmessage?.({data:JSON.stringify({type:'state',accounts})})});}
    close(){this.closed=true;}
  }
  const client=loadClient('client-ui-accounts',async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return reply;},{storage,slot,
    globals:{EventSource,setTimeout(fn,delay){const id={};timers.set(id,{fn,delay});return id},clearTimeout(id){timers.delete(id)}}});
  return {client,storage,streams,timers,calls,opened,get completed(){return completed},
    mount:()=>client.mount({complete(){completed++},openSection(id){opened.push(id)}})};
}

test('skipping setup persists across renderer recreation without advancing to the second key prompt',async()=>{
  const f=fixture();const view=await f.mount().flush();
  assert.ok(button(view,'skip'));button(view,'skip').props.onClick();await view.flush();
  assert.equal(view.tree,null);assert.equal(f.completed,0);assert.equal(f.storage.get(KEY),'1');
  assert.ok(f.streams.every(stream=>stream.closed));assert.equal(f.timers.size,0);view.unmount();
  const next=fixture({storage:f.storage});const restored=await next.mount().flush();
  assert.equal(restored.tree,null);assert.equal(next.completed,0);assert.equal(next.streams.length,0);assert.equal(next.timers.size,0);restored.unmount();
});

test('API-key setup opens Models directly and records the onboarding choice',async()=>{
  const f=fixture();const view=await f.mount().flush();button(view,'key').props.onClick();await view.flush();
  assert.deepEqual(f.opened,['models']);assert.equal(f.storage.get(KEY),'1');assert.equal(f.completed,0);assert.equal(view.tree,null);view.unmount();
});

test('accepted sign-in opens Accounts without a second onboarding modal',async()=>{
  const f=fixture();const view=await f.mount().flush();await button(view,'fixture').props.onClick();await view.flush();
  assert.deepEqual(f.calls,[{url:'/dsh-auth/begin',body:{provider:'openai-codex',method:'oauth'}}]);
  assert.deepEqual(f.opened,['accounts']);assert.equal(f.storage.get(KEY),'1');assert.equal(view.tree,null);assert.equal(f.completed,0);view.unmount();
});

test('a rejected sign-in remains visible, retryable, and does not persist dismissal',async()=>{
  const f=fixture({reply:{ok:false,status:409,json:async()=>({ok:true,error:'Another sign-in is running'})}});
  const view=await f.mount().flush();button(view,'fixture').props.onClick();await view.flush();
  assert.ok(view.find(n=>n.props.role==='alert'&&n.props.children.includes('Another sign-in is running')));
  assert.equal(button(view,'fixture').props.disabled,false);assert.equal(button(view,'skip').props.disabled,false);
  assert.equal(f.storage.has(KEY),false);assert.deepEqual(f.opened,[]);assert.equal(f.completed,0);view.unmount();
});

test('in-flight sign-in cannot race the skip or model-setup actions',async()=>{
  let resolve;
  const f=fixture({reply:new Promise(r=>{resolve=r})});const view=await f.mount().flush();
  button(view,'fixture').props.onClick();await view.flush();
  assert.equal(button(view,'skip').props.disabled,true);assert.equal(button(view,'key').props.disabled,true);
  resolve({ok:false,status:503,json:async()=>({error:'Try again'})});await view.flush();assert.equal(button(view,'skip').props.disabled,false);view.unmount();
});

test('unavailable local storage still honors skip across component remounts in this renderer',async()=>{
  class UnavailableStorage extends Map {get(){throw Error('blocked')}set(){throw Error('blocked')}}
  const f=fixture({storage:new UnavailableStorage()});const first=await f.mount().flush();
  button(first,'skip').props.onClick();await first.flush();assert.equal(first.tree,null);first.unmount();
  const second=await f.mount().flush();assert.equal(second.tree,null);assert.equal(f.streams.length,1);second.unmount();
});

test('an auth-stream timeout does not permanently dismiss onboarding',async()=>{
  const f=fixture({accounts:null});const view=await f.mount().flush();
  const timeout=[...f.timers.values()].find(timer=>timer.delay===8000);assert.ok(timeout);timeout.fn();
  assert.equal(f.completed,1);assert.equal(f.storage.has(KEY),false);view.unmount();
});

test('dismissed onboarding does not disable the Accounts settings section',async()=>{
  const f=fixture({slot:'settings.section',storage:new Map([[KEY,'1']])});const view=await f.mount().flush();
  assert.equal(f.streams.length,1);assert.ok(view.find(n=>n.type?.name==='Card'&&n.props.account.key==='fixture'));view.unmount();
});
