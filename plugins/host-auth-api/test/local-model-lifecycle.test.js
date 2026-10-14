import {test} from 'node:test'
import assert from 'node:assert/strict'
import {SettingsConflictError} from '@deepseek-ai/dsh-settings'
import {syncLocalModels,installLocalModels,LOCAL_SERVERS} from '../lib/local-models.js'

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
const model={id:'fixture',name:'fixture',contextWindow:8192,maxTokens:4096}
const owned={displayName:'Ollama',api:'openai-completions',baseURL:LOCAL_SERVERS[0].baseURL,headers:{Authorization:'Bearer local'},models:[model]}
const response=body=>({ok:true,json:async()=>body})
function setup(t,{profile,available=true,onWrite=()=>{}}={}){
  const profiles=profile===undefined?{}:{ollama:profile};let revision=0,writes=0
  const nativeFetch=globalThis.fetch
  globalThis.fetch=async url=>String(url).endsWith('/api/tags')?(available?response({models:[{name:'fixture'}]}):{ok:false}):String(url).endsWith('/api/show')?response({model_info:{}}):{ok:false}
  t.after(()=>{globalThis.fetch=nativeFetch})
  const settings={configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section:()=>({providers:structuredClone(profiles)}),describe:()=>[{ns:'llm-pi-ai',revision}],
    async mutate(ns,[op],expected){writes++;await onWrite(next=>{if(next===undefined)delete profiles.ollama;else profiles.ollama=next;revision++});if(expected!==undefined&&expected!==revision)throw new SettingsConflictError(ns,expected,revision);if(op.op==='set')profiles[op.path[1]]=op.value;else delete profiles[op.path[1]];revision++},
  }
  return {ctx:{get:()=>settings,logger:{info(){},warn(){}}},profile:(id='ollama')=>profiles[id],writes:()=>writes}
}

test('local discovery cannot overwrite a user edit queued after its read',async t=>{
  let once=true;const custom={...owned,baseURL:'http://fixture.invalid/v1'}
  const app=setup(t,{onWrite:edit=>{if(once){once=false;edit(custom)}}}),state={}
  await syncLocalModels(app.ctx,state)
  assert.deepEqual(app.profile(),custom);assert.equal(state.ollama.sync,'user-managed')
})

test('local retraction preserves a concurrent custom edit when the server is unavailable',async t=>{
  let once=true;const custom={...owned,displayName:'My local server'}
  const app=setup(t,{profile:owned,available:false,onWrite:edit=>{if(once){once=false;edit(custom)}}}),state={}
  await syncLocalModels(app.ctx,state)
  assert.deepEqual(app.profile(),custom);assert.equal(state.ollama.sync,'user-managed')
})

test('disposing the scanner aborts its active probe and prevents later settings writes',async t=>{
  const app=setup(t),pending=deferred();let signal
  globalThis.fetch=async(_url,init)=>{signal=init.signal;return pending.promise}
  const scanner=installLocalModels(app.ctx);scanner.dispose()
  pending.resolve(response({models:[{name:'fixture'}],model_info:{},data:[]}))
  await new Promise(setImmediate)
  assert.equal(signal.aborted,true);assert.deepEqual(scanner.state,{});assert.equal(app.writes(),0)
})

test('Ollama metadata discovery limits concurrent requests and deduplicates model ids',async t=>{
  const app=setup(t),release=deferred();let active=0,peak=0,shows=0
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/api/tags'))return response({models:[...Array.from({length:12},(_,i)=>({name:'fixture-'+i})),{name:'fixture-0'}]})
    if(String(url).endsWith('/api/show')){shows++;active++;peak=Math.max(peak,active);await release.promise;active--;return response({model_info:{}})}
    return {ok:false}
  }
  const pending=syncLocalModels(app.ctx,{})
  await new Promise(setImmediate);release.resolve();await pending
  assert.ok(peak<=4,`saw ${peak} concurrent probes`);assert.equal(shows,12);assert.equal(app.profile().models.length,12)
})

test('malformed model identifiers do not become selectable model names',async t=>{
  const app=setup(t)
  globalThis.fetch=async url=>String(url).endsWith('/api/tags')?response({models:[{name:{bad:true}},{name:7},{name:'fixture'},{name:'fixture'},{name:'embedding-model'}]}):String(url).endsWith('/api/show')?response({model_info:{}}):{ok:false}
  const state={};await syncLocalModels(app.ctx,state)
  assert.deepEqual(state.ollama.models,['fixture'])
})

test('periodic scans do not overlap per server and a slow Ollama does not block LM Studio',async t=>{
  const app=setup(t),pending=deferred();let tick,tags=0,lm=0
  const oldSet=globalThis.setInterval,oldClear=globalThis.clearInterval
  globalThis.setInterval=fn=>{tick=fn;return 1};globalThis.clearInterval=()=>{}
  t.after(()=>{globalThis.setInterval=oldSet;globalThis.clearInterval=oldClear})
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/api/tags')){tags++;return pending.promise}
    if(String(url).endsWith('/api/v0/models')){lm++;return response({data:[]})}
    return {ok:false}
  }
  const scanner=installLocalModels(app.ctx)
  try {
    await new Promise(setImmediate);assert.equal(lm,1);assert.equal(scanner.state.lmstudio.up,true)
    tick();tick();await new Promise(setImmediate)
    assert.equal(tags,1);assert.equal(lm,2)
  } finally {scanner.dispose();pending.resolve({ok:false})}
  const before=lm;tick();await new Promise(setImmediate);assert.equal(lm,before)
})

test('aborting a detail batch stops queued probes and leaves the last published state intact',async t=>{
  const app=setup(t),release=deferred(),controller=new AbortController();let shows=0
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/api/tags'))return response({models:Array.from({length:20},(_,i)=>({name:'fixture-'+i}))})
    if(String(url).endsWith('/api/show')){shows++;await release.promise;return response({model_info:{}})}
    return {ok:false}
  }
  const old={up:true,models:['previous']},state={ollama:old}
  const pending=syncLocalModels(app.ctx,state,{signal:controller.signal})
  const rejected=assert.rejects(pending,{name:'AbortError'})
  await new Promise(setImmediate);controller.abort();release.resolve();await rejected
  assert.equal(shows,4);assert.equal(state.ollama,old);assert.equal(app.writes(),0)
})

test('continuous settings conflicts are bounded and reported without changing the custom route',async t=>{
  const app=setup(t,{onWrite:edit=>edit(undefined)}),state={}
  await syncLocalModels(app.ctx,state)
  assert.equal(app.writes(),3);assert.equal(app.profile(),undefined);assert.match(state.ollama.sync,/^failed:/)
})

test('LM Studio supports modern and fallback inventories with sane context sizes',async t=>{
  const app=setup(t);let modern=true,fallbacks=0
  globalThis.fetch=async url=>{
    if(String(url).endsWith('/api/v0/models'))return modern?response({data:[
      {id:'vision',type:'vlm',max_context_length:32768},{id:'vision',type:'llm'},
      {id:'tiny',type:'llm',max_context_length:1024},{id:'invalid-context',type:'llm',max_context_length:Infinity},
      {id:{bad:true},type:'llm'},{id:'embedding-fixture',type:'embedding'},
    ]}):{ok:false}
    if(String(url).endsWith('/v1/models')){fallbacks++;return response({data:[{id:'legacy'},{id:'legacy'},{id:7},{id:'embed-only'}]})}
    return {ok:false}
  }
  const state={};await syncLocalModels(app.ctx,state)
  assert.deepEqual(state.lmstudio.models,['vision','tiny','invalid-context']);assert.equal(fallbacks,0)
  assert.deepEqual(app.profile('lmstudio').models.map(m=>[m.id,m.contextWindow,m.maxTokens]),[['vision',32768,4096],['tiny',1024,1024],['invalid-context',8192,4096]])
  modern=false;await syncLocalModels(app.ctx,state)
  assert.deepEqual(state.lmstudio.models,['legacy']);assert.equal(fallbacks,1)
})

test('a failed detail lookup keeps the model with a fallback instead of dropping it',async t=>{
  const app=setup(t)
  globalThis.fetch=async url=>String(url).endsWith('/api/tags')?response({models:[{name:'fixture'}]}):{ok:false}
  await syncLocalModels(app.ctx,{})
  assert.equal(app.profile().models[0].contextWindow,8192)
})


test('simultaneous server discoveries retry namespace conflicts without losing either profile',async t=>{
  const release=deferred(),app=setup(t,{onWrite:()=>release.promise})
  globalThis.fetch=async url=>String(url).endsWith('/api/tags')?response({models:[{name:'fixture'}]}):String(url).endsWith('/api/show')?response({model_info:{}}):response({data:[{type:'llm',id:'studio-fixture'}]})
  const pending=syncLocalModels(app.ctx,{})
  await new Promise(setImmediate);const initialWrites=app.writes();release.resolve();await pending
  assert.equal(initialWrites,2);assert.equal(app.writes(),3)
  assert.equal(app.profile().models[0].id,'fixture');assert.equal(app.profile('lmstudio').models[0].id,'studio-fixture')
})

test('scanner disposal closes actual HTTP probes stalled in response bodies',{timeout:5000},async t=>{
  const {createServer}=await import('node:http'),{once}=await import('node:events')
  const nativeFetch=globalThis.fetch,app=setup(t),entered=deferred(),closed=deferred()
  let requests=0,closures=0
  const server=createServer((_req,res)=>{
    res.writeHead(200,{'content-type':'application/json'});res.write('{')
    res.on('close',()=>{if(++closures===2)closed.resolve()})
    if(++requests===2)entered.resolve()
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const origin=`http://127.0.0.1:${server.address().port}`
  globalThis.fetch=(url,init)=>nativeFetch(origin+new URL(url).pathname,init)
  const scanner=installLocalModels(app.ctx);t.after(()=>scanner.dispose())
  await entered.promise;scanner.dispose();await closed.promise;await new Promise(setImmediate)
  assert.equal(requests,2);assert.equal(closures,2);assert.deepEqual(scanner.state,{});assert.equal(app.writes(),0)
})
