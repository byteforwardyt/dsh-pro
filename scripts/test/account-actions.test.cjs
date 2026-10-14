const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const reply=(body={},ok=true,status=ok?200:503)=>({ok,status,json:async()=>body});
const account={key:'fixture',provider:'fixture',label:'Fixture',configured:false,inFlight:false,methods:[{id:'oauth',label:'Browser'}]};
const button=(view,label)=>view.find(n=>n.type==='button'&&n.props.children.includes(label));
const alert=view=>view.find(n=>n.props.role==='alert');

async function setup(t,{prompt={id:'p1',kind:'secret',message:'Enter key'},configured=false,fetcher=async()=>reply()}={}){
  const streams=[],calls=[],timers=new Map(),mounted=[];
  class EventSource{constructor(){streams.push(this)}close(){}}
  const client=loadClient('client-ui-accounts',(url,init)=>{calls.push({url,init,body:JSON.parse(init.body)});return fetcher(url,init)},
    {slot:'settings.section',globals:{EventSource,setTimeout(fn,delay){const id={};timers.set(id,{fn,delay});return id},clearTimeout(id){timers.delete(id)}}});
  const root=client.mount();mounted.push(root);await root.flush();
  streams[0].onmessage({data:JSON.stringify({type:'state',accounts:[{...account,configured}],live:configured?[]:[{key:'fixture',attemptId:'a1',notices:[],prompt}]})});await root.flush();
  const cardNode=root.find(n=>n.type?.name==='Card'),card=client.mount(cardNode.props,cardNode.type);mounted.push(card);await card.flush();
  const node=card.find(n=>n.type?.name===(configured?'SignOutButton':'Prompt'));
  const view=node?client.mount(node.props,node.type):null;if(view){mounted.push(view);await view.flush()}
  t.after(()=>mounted.forEach(v=>v.unmount()));
  return {view,card,calls,timers,node};
}
const fill=(view,value)=>view.find(n=>n.type==='input').props.onChange({target:{value}});
const submit=view=>view.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});

test('failed prompt delivery preserves input and gives a retryable error',async t=>{
  const app=await setup(t,{fetcher:async()=>reply({error:'Host unavailable'},false)});
  fill(app.view,'fixture-secret');await app.view.flush();submit(app.view);await app.view.flush();
  assert.ok(alert(app.view));assert.equal(app.view.find(n=>n.type==='input').props.value,'fixture-secret');
  assert.equal(button(app.view,'Submit').props.disabled,false);
})

test('select prompts send once while pending and explain an expired prompt',async t=>{
  const gate=deferred(),app=await setup(t,{prompt:{id:'p1',kind:'select',message:'Choose',options:[{id:'a',label:'A'},{id:'b',label:'B'}]},fetcher:()=>gate.promise});
  const choose=button(app.view,'A').props.onClick;choose();choose();await app.view.flush();
  const count=app.calls.length;gate.resolve(reply({delivered:false}));await app.view.flush();
  assert.equal(count,1);assert.ok(alert(app.view));assert.match(alert(app.view).props.children.join(''),/no longer|expired/i);
})

test('pending prompt requests abort on unmount without later component updates',async t=>{
  const gate=deferred(),app=await setup(t,{fetcher:()=>gate.promise});
  fill(app.view,'fixture-secret');await app.view.flush();submit(app.view);await app.view.flush();
  app.view.unmount();app.view.dirty=false;
  gate.resolve(reply({error:'Late failure'},false));await new Promise(setImmediate);
  assert.equal(app.calls[0].init.signal?.aborted,true);assert.equal(app.view.dirty,false);
})

test('cancel failures are visible and rapid repeat clicks send only one request',async t=>{
  const gate=deferred(),app=await setup(t,{fetcher:()=>gate.promise});
  const cancel=button(app.card,'Cancel sign-in').props.onClick;cancel();cancel();await app.card.flush();
  const count=app.calls.length;gate.resolve(reply({error:'Cancellation failed'},false));await app.card.flush();
  assert.equal(count,1);assert.ok(alert(app.card));assert.equal(button(app.card,'Cancel sign-in').props.disabled,false);
})

test('sign-out failures require a fresh confirmation and show an error',async t=>{
  const app=await setup(t,{configured:true,fetcher:async()=>reply({error:'Could not remove account'},false)});
  button(app.view,'Sign out').props.onClick();await app.view.flush();
  assert.equal(app.calls.length,0);button(app.view,'Confirm sign out').props.onClick();await app.view.flush();
  assert.equal(app.calls.length,1);assert.ok(alert(app.view));
  button(app.view,'Sign out').props.onClick();await app.view.flush();assert.equal(app.calls.length,1);
})

test('a stalled action times out with an uncertain-result message and releases controls',async t=>{
  const app=await setup(t,{fetcher:(_url,{signal})=>new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});
  fill(app.view,'fixture-secret');await app.view.flush();submit(app.view);await app.view.flush();
  const timeout=[...app.timers.values()].find(timer=>timer.delay===15000);
  assert.ok(timeout,'mutation requests need a finite deadline');timeout.fn();await app.view.flush();
  assert.equal(app.calls[0].init.signal.aborted,true);assert.ok(alert(app.view));assert.match(alert(app.view).props.children.join(''),/status|received/i);
  assert.equal(button(app.view,'Submit').props.disabled,false);
})


test('acknowledged prompt delivery clears the secret and prevents further editing',async t=>{
  const app=await setup(t,{fetcher:async()=>reply({delivered:true})});
  fill(app.view,'fixture-secret');await app.view.flush();submit(app.view);await app.view.flush();
  const input=app.view.find(n=>n.type==='input');assert.equal(input.props.value,'');assert.equal(input.props.disabled,true);
  assert.equal(button(app.view,'Submit').props.disabled,true);assert.ok(app.view.find(n=>n.props.role==='status'));
})

test('prompt replacement clears old input and ignores its late response and callback',async t=>{
  const gate=deferred(),app=await setup(t,{fetcher:()=>gate.promise});
  fill(app.view,'fixture-secret');await app.view.flush();const oldSubmit=app.view.find(n=>n.type==='form').props.onSubmit;
  oldSubmit({preventDefault(){}});await app.view.flush();
  app.view.setProps({...app.node.props,prompt:{id:'p2',kind:'text',message:'Next code'}});await app.view.flush();
  gate.resolve(reply({error:'Old failure'},false));await app.view.flush();
  oldSubmit({preventDefault(){}});await app.view.flush();
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].init.signal.aborted,true);
  assert.equal(alert(app.view),undefined);assert.equal(app.view.find(n=>n.type==='input').props.value,'');
})

test('malformed host acknowledgements surface an error instead of silently succeeding',async t=>{
  const app=await setup(t,{fetcher:async()=>({ok:true,status:200,json:async()=>{throw Error('not JSON')}})});
  fill(app.view,'fixture-secret');await app.view.flush();submit(app.view);await app.view.flush();
  assert.match(alert(app.view).props.children.join(''),/unreadable response/);
  assert.equal(app.view.find(n=>n.type==='input').props.value,'fixture-secret');
})

test('pending sign-out cannot be submitted twice',async t=>{
  const gate=deferred(),app=await setup(t,{configured:true,fetcher:()=>gate.promise});
  button(app.view,'Sign out').props.onClick();await app.view.flush();
  const confirm=button(app.view,'Confirm sign out').props.onClick;confirm();confirm();await app.view.flush();
  assert.equal(app.calls.length,1);assert.equal(button(app.view,'Signing out…').props.disabled,true);
  gate.resolve(reply({ok:true,revokedRemotely:false}));await app.view.flush();
  assert.equal(alert(app.view),undefined);
})


test('account-wide sign-out state disables sign-in across surfaces and retains cleanup warnings',async t=>{
  const app=await setup(t);
  app.card.setProps({account:{...account,signingOut:true},live:undefined,outcome:null});await app.card.flush();
  assert.equal(button(app.card,'Signing out…').props.disabled,true);
  app.card.setProps({account:{...account,signingOut:false,signOutWarning:'Review provider settings in Models.'},live:undefined,outcome:null});await app.card.flush();
  assert.equal(button(app.card,'Sign in').props.disabled,false);
  const warning=app.card.find(n=>n.props.role==='status');assert.ok(warning);assert.match(warning.props.children.join(''),/Models/);
})

test('a sign-in in progress disarms and disables the sign-out confirmation',async t=>{
  const app=await setup(t,{configured:true});button(app.view,'Sign out').props.onClick();await app.view.flush();
  app.view.setProps({...app.node.props,disabled:true});await app.view.flush();
  assert.equal(button(app.view,'Sign out').props.disabled,true);
  button(app.view,'Sign out').props.onClick();await app.view.flush();assert.equal(app.calls.length,0);
  // A fresh enabled view must ask for confirmation again.
  app.view.setProps({...app.node.props,disabled:false});await app.view.flush();
  assert.ok(button(app.view,'Sign out'));
})
