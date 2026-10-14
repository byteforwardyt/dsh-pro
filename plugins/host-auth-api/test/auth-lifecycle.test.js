import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {once} from 'node:events'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import {apply} from '../lib/index.js'

const key='llm-pi-ai/fixture'
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}

// Real registered HTTP handlers and the installed authorization lifecycle. Only
// the provider flow and credential store are fixtures; no provider is contacted.
async function setup(t,run,options={}) {
  const home=await mkdtemp(join(tmpdir(),'dsh-auth-lifecycle-')),previous=process.env.DSH_HOME
  process.env.DSH_HOME=home
  const nativeFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:false})
  const callbacks=new Map(),events=[],requests=[],flows=[]
  let handler,configured=options.configured??false
  const ctx={get:()=>options.settings,logger:{warn(){},debug(){}},
    credentials:{describeRecord:async()=>{const record={configured};await options.beforeRead?.();return record},deleteRecord:async()=>{configured=false;emit('credentials/record-updated',key)}},
    webServer:{register(config){handler=config.handler;return()=>{}}},
    on(event,fn){if(!callbacks.has(event))callbacks.set(event,new Set());callbacks.get(event).add(fn);return()=>callbacks.get(event).delete(fn)},
    events:{dispatch(_mode,[event,...args]){return [...callbacks.get(event)||[]]}},
    effect(fn){const iterator=fn();const {value:dispose}=iterator.next();return()=>dispose?.()},
  }
  const emit=(event,...args)=>{for(const fn of [...callbacks.get(event)||[]])fn(...args)}
  const service=Object.create(AuthorizationService.prototype)
  Object.defineProperty(service,'ctx',{value:ctx})
  service.flows=new Map();service.running=new Map();ctx.authorization=service
  service.registerFlow({key,label:'Fixture',methods:[{id:'browser',label:'Browser'}],async run(session){flows.push(session);return run(session)}})
  apply(ctx)
  const server=createServer((req,res)=>{
    const write=res.write.bind(res)
    res.write=(frame,...args)=>{if(String(frame).startsWith('data: '))events.push(JSON.parse(String(frame).slice(6)));return write(frame,...args)}
    const done=Promise.resolve(handler(req,res)).catch(error=>res.destroy(error));requests.push(done)
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const fetch=(route,init)=>nativeFetch(`http://127.0.0.1:${server.address().port}/dsh-auth/${route}`,init)
  t.after(async()=>{
    emit('dispose');for(const key of service.running.keys())service.cancel(key)
    globalThis.fetch=nativeFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
    if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
    await rm(home,{recursive:true,force:true})
  })
  await (await fetch('state')).json()
  const response=await fetch('events'),streamDone=response.text()
  const until=async predicate=>{while(!predicate()){t.signal.throwIfAborted();await new Promise(setImmediate)}}
  await until(()=>events.some(event=>event.type==='state'))
  return {events,flows,service,ctx,until,
    post:(route,body={})=>fetch(route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:'fixture',...body})}),
    state:async()=>await (await fetch('state')).json(),
    commit(){configured=true;emit('credentials/record-updated',key)},
    async dispose(){emit('dispose');await streamDone;await Promise.all(requests)},
  }
}

test('early begin validation failures clear busy state and permit another sign-in',{timeout:5000},async t=>{
  const app=await setup(t,async()=>{})
  for(let i=0;i<2;i++){
    const response=await app.post('begin',{method:'missing'})
    assert.equal(response.status,202)
    const {attemptId}=await response.json()
    await app.until(()=>app.events.some(event=>event.type==='settled'&&event.attemptId===attemptId))
    const own=app.events.filter(event=>event.attemptId===attemptId)
    assert.deepEqual(own.map(event=>event.type),['attempt-started','outcome','settled'])
    assert.equal(own[1].status,'failed');assert.match(own[1].message,/method/i)
    const state=await app.state();assert.deepEqual(state.live,[]);assert.equal(state.accounts[0].inFlight,false)
  }
})

test('stale cancel cannot cancel a replacement login; duplicate begin and old callbacks are contained',{timeout:5000},async t=>{
  const app=await setup(t,async session=>{await session.prompt({kind:'text',message:'Fixture code'})})
  const first=await (await app.post('begin')).json()
  assert.equal((await app.post('begin')).status,409)
  const firstState=await app.state();assert.equal(firstState.live[0].attemptId,first.attemptId)
  assert.equal((await app.post('cancel',{attemptId:first.attemptId})).status,200)
  await app.until(()=>app.events.some(event=>event.type==='settled'&&event.attemptId===first.attemptId))
  const second=await (await app.post('begin')).json()
  assert.notEqual(first.attemptId,second.attemptId)
  const before=app.events.length
  app.flows[0].notify({message:'Late callback'})
  await assert.rejects(app.flows[0].prompt({kind:'text',message:'Late prompt'}),/attempt is over/)
  assert.equal(app.events.length,before)
  assert.equal((await app.post('cancel',{attemptId:first.attemptId})).status,409)
  assert.equal(app.flows[1].signal.aborted,false)
  const current=await app.state();assert.equal(current.live[0].attemptId,second.attemptId)
  assert.equal(current.live[0].prompt.message,'Fixture code')
  assert.equal((await app.post('cancel',{attemptId:second.attemptId})).status,200)
  await app.until(()=>app.events.some(event=>event.type==='settled'&&event.attemptId===second.attemptId))
  assert.deepEqual((await app.state()).live,[])
})

test('plugin disposal cancels only its owned login and rejects orphaned prompts',{timeout:5000},async t=>{
  const app=await setup(t,async session=>{await session.prompt({kind:'text',message:'Fixture code'})})
  const otherKey='llm-pi-ai/unowned',release=deferred()
  app.service.registerFlow({key:otherKey,label:'Other',methods:[{id:'browser',label:'Browser'}],run:()=>release.promise})
  const other=app.service.begin({key:otherKey,interaction:{notify(){},prompt(){throw Error('unexpected prompt')}}})
  await app.post('begin');const owned=app.flows[0]
  await app.dispose()
  assert.equal(owned.signal.aborted,true)
  assert.equal(app.service.running.has(key),false)
  assert.equal(app.service.running.has(otherKey),true,'shutdown must not cancel another surface’s login')
  const before=app.events.length;owned.notify({message:'After shutdown'})
  await assert.rejects(owned.prompt({kind:'text',message:'After shutdown'}),/attempt is over/)
  assert.equal(app.events.length,before)
  app.service.cancel(otherKey);assert.equal((await other).status,'cancelled');release.resolve()
})

test('successful sign-in emits one terminal event and publishes the configured account',{timeout:5000},async t=>{
  const release=deferred()
  const app=await setup(t,async()=>{await release.promise;app.commit()})
  const {attemptId}=await (await app.post('begin')).json();release.resolve()
  await app.until(()=>app.events.some(event=>event.type==='settled'&&event.attemptId===attemptId))
  const terminal=app.events.filter(event=>event.type==='settled'&&event.key===key)
  assert.equal(terminal.length,1);assert.equal(terminal[0].settlement,'authorized')
  assert.equal(app.events.find(event=>event.type==='outcome'&&event.attemptId===attemptId).status,'authorized')
  const state=await app.state();assert.equal(state.accounts[0].configured,true);assert.deepEqual(state.live,[])
})


test('cancellation service failures return an honest HTTP error and leave the attempt retryable',{timeout:5000},async t=>{
  const app=await setup(t,async session=>{await session.prompt({kind:'text',message:'Fixture code'})})
  const {attemptId}=await (await app.post('begin')).json()
  const cancel=app.service.cancel.bind(app.service)
  for(const failing of [()=>{throw Error('Fixture failure')},async()=>{throw Error('Fixture async failure')}]){
    app.service.cancel=failing
    const response=await app.post('cancel',{attemptId})
    assert.equal(response.status,500);assert.match((await response.json()).error,/could not be cancelled/)
    assert.equal(app.flows[0].signal.aborted,false)
    assert.equal((await app.state()).live[0].attemptId,attemptId)
  }
  app.service.cancel=cancel
  assert.equal((await app.post('cancel',{attemptId})).status,200)
  await app.until(()=>app.events.some(event=>event.type==='settled'&&event.attemptId===attemptId))
})


test('sign-out holds its provider through deletion and rejects duplicate sign-out or begin',{timeout:5000},async t=>{
  const app=await setup(t,async session=>{await session.prompt({kind:'text',message:'Fixture'})})
  app.commit();const entered=deferred(),release=deferred(),remove=app.ctx.credentials.deleteRecord
  let deletes=0
  app.ctx.credentials.deleteRecord=async()=>{deletes++;if(deletes===1){entered.resolve();await release.promise}await remove()}
  const pending=app.post('signout');await entered.promise
  try {
    const duplicate=await app.post('signout'),begin=await app.post('begin')
    assert.equal(duplicate.status,409);assert.equal(begin.status,409)
    assert.equal(deletes,1);assert.equal(app.flows.length,0)
    assert.equal((await app.state()).accounts[0].signingOut,true)
  } finally {release.resolve();await pending}
  assert.equal((await app.state()).accounts[0].signingOut,false)
  assert.equal((await app.state()).accounts[0].configured,false)
  assert.equal((await app.post('begin')).status,202)
  await app.post('cancel')
})

test('sign-out refuses an in-flight login without deleting a record',{timeout:5000},async t=>{
  const app=await setup(t,async session=>{await session.prompt({kind:'text',message:'Fixture'})})
  let deletes=0;app.ctx.credentials.deleteRecord=async()=>{deletes++}
  await app.post('begin');const response=await app.post('signout')
  assert.equal(response.status,409);assert.equal(deletes,0)
  assert.equal(app.flows[0].signal.aborted,false);await app.post('cancel')
})

test('failed deletion releases the sign-out guard and preserves the configured account',{timeout:5000},async t=>{
  const app=await setup(t,async()=>{})
  app.commit();const remove=app.ctx.credentials.deleteRecord
  app.ctx.credentials.deleteRecord=async()=>{throw Error('Fixture storage failure')}
  const response=await app.post('signout')
  assert.equal(response.status,500);assert.match((await response.json()).error,/credential|sign.out/i)
  const state=await app.state();assert.equal(state.accounts[0].configured,true);assert.equal(state.accounts[0].signingOut,false)
  app.ctx.credentials.deleteRecord=remove;assert.equal((await app.post('signout')).status,200)
})

test('partial sign-out cleanup is reported in the response and account snapshot',{timeout:5000},async t=>{
  const app=await setup(t,async()=>{})
  app.commit()
  app.ctx.get=()=>({configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section:()=>({providers:{fixture:{displayName:'fixture'}}}),describe:()=>[{ns:'llm-pi-ai',revision:1,user:{providers:{fixture:{displayName:'fixture'}}}}],mutate:async()=>{throw Error('Fixture settings failure')}})
  const response=await app.post('signout');assert.equal(response.status,200)
  const result=await response.json();assert.equal(result.cleanup,'failed');assert.match(result.warning,/Models/)
  const state=await app.state();assert.equal(state.accounts[0].configured,false);assert.equal(state.accounts[0].signOutWarning,result.warning)
})


test('sign-out waits for startup declaration before removing the provider profile',{timeout:5000},async t=>{
  const entered=deferred(),release=deferred();let profile,revision=0
  const settings={
    configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section:()=>({providers:profile?{fixture:profile}:{}}),
    describe:()=>[{ns:'llm-pi-ai',revision,user:{providers:profile?{fixture:profile}:{}}}],
    async mutate(_ns,[op],expected){
      if(op.op==='set'){entered.resolve();await release.promise}
      assert.equal(expected,revision)
      profile=op.op==='set'?op.value:undefined;revision++
    },
  }
  const app=await setup(t,async()=>{},{configured:true,settings});await entered.promise
  let deletes=0;const remove=app.ctx.credentials.deleteRecord;app.ctx.credentials.deleteRecord=async()=>{deletes++;await remove()}
  const pending=app.post('signout')
  await app.until(()=>deletes>0||app.events.some(event=>event.type==='state'&&event.accounts[0].signingOut))
  try {assert.equal(deletes,0,'deletion must wait for the pending declaration')} finally {release.resolve();await pending}
  assert.equal(profile,undefined);assert.equal((await app.state()).accounts[0].configured,false)
})

test('sign-out keeps its guard through settings cleanup while another provider remains usable',{timeout:5000},async t=>{
  const app=await setup(t,async()=>{}),entered=deferred(),release=deferred()
  app.commit()
  app.ctx.get=()=>({configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section:()=>({providers:{fixture:{}}}),describe:()=>[{ns:'llm-pi-ai',revision:0,user:{providers:{fixture:{}}}}],mutate:async()=>{entered.resolve();await release.promise}})
  app.service.registerFlow({key:'llm-pi-ai/other',label:'Other',methods:[{id:'browser',label:'Browser'}],run:async session=>{await session.prompt({kind:'text',message:'Other code'})}})
  const pending=app.post('signout');await entered.promise
  try {
    const state=await app.state();assert.equal(state.accounts.find(a=>a.key===key).configured,false)
    assert.equal(state.accounts.find(a=>a.key===key).signingOut,true)
    assert.equal((await app.post('begin')).status,409)
    assert.equal((await app.post('begin',{provider:'other'})).status,202)
    await app.post('cancel',{provider:'other'})
  } finally {release.resolve();await pending}
})


test('a startup credential read captured before sign-out cannot declare after sign-out finishes',{timeout:5000},async t=>{
  const entered=deferred(),release=deferred();let reads=0,writes=0,profile
  const settings={configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section:()=>({providers:profile?{fixture:profile}:{}}),describe:()=>[{ns:'llm-pi-ai',revision:0,user:{providers:{}}}],mutate:async(_ns,[op])=>{writes++;profile=op.op==='set'?op.value:undefined}}
  const app=await setup(t,async()=>{},{configured:true,settings,beforeRead:async()=>{if(++reads===1){entered.resolve();await release.promise}}})
  await entered.promise
  try {
    assert.equal((await app.post('signout')).status,200)
  } finally {release.resolve()}
  // All declaration work after the held read is promise-only in this fixture.
  await new Promise(setImmediate)
  assert.equal(writes,0);assert.equal(profile,undefined)
  assert.equal((await app.state()).accounts[0].configured,false)
})
