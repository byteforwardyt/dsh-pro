import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {apply} from '../lib/index.js'

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
async function setup(t) {
  const home=await mkdtemp(join(tmpdir(),'dsh-account-state-')),previous=process.env.DSH_HOME
  process.env.DSH_HOME=home
  const nativeFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:false})
  let configured=false,hold=null,reads=0,handler,failNext=false
  const callbacks=new Map(),states=[],gates=[]
  apply({get:()=>undefined,
    authorization:{list:()=>[{key:'llm-pi-ai/fixture',label:'Fixture',inFlight:false,methods:[{id:'browser',label:'Browser'}]}]},
    credentials:{describeRecord:async()=>{
      reads++;const record={configured,kind:configured?'grant':undefined}
      if(failNext){failNext=false;throw new Error('Fixture credential read failure')}
      if(hold){const gate=hold;hold=null;gate.entered.resolve();await gate.release.promise}
      return record
    }},
    webServer:{register(config){handler=config.handler;return()=>{}}},on(event,fn){callbacks.set(event,fn)},
  })
  const server=createServer((req,res)=>{
    const write=res.write.bind(res)
    res.write=(frame,...args)=>{
      if(String(frame).startsWith('data: ')){const event=JSON.parse(String(frame).slice(6));if(event.type==='state')states.push(event)}
      return write(frame,...args)
    }
    Promise.resolve(handler(req,res)).catch(error=>res.destroy(error))
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{
    for(const gate of gates)gate.release.resolve()
    callbacks.get('dispose')();globalThis.fetch=nativeFetch
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
    if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous
    await rm(home,{recursive:true,force:true})
  })
  const fetch=(route,init)=>nativeFetch(`http://127.0.0.1:${server.address().port}/dsh-auth/${route}`,init)
  await (await fetch('state')).json() // Finish first-read declaration reconciliation.
  return {fetch,states,reads:()=>reads,
    failNext(){failNext=true},
    change(value){configured=value;callbacks.get('credentials/record-updated')('llm-pi-ai/fixture')},
    hold(){const gate={entered:deferred(),release:deferred()};hold=gate;gates.push(gate);return gate},
    async waitStates(count){while(states.length<count)await new Promise(setImmediate)},
  }
}

test('account snapshots retry if credentials change during an asynchronous read',{timeout:5000},async t=>{
  const app=await setup(t),gate=app.hold()
  const pending=app.fetch('state')
  await gate.entered.promise
  app.change(true);gate.release.resolve()
  const result=await (await pending).json()
  assert.equal(result.accounts[0].configured,true,'older credential read must not be published after invalidation')
  assert.ok(Number.isSafeInteger(result.revision));assert.ok(result.revision>0)
})

test('bursts of account changes coalesce while a state read is pending',{timeout:5000},async t=>{
  const app=await setup(t),controller=new AbortController()
  await app.fetch('events',{signal:controller.signal});await app.waitStates(1)
  const gate=app.hold();app.change(false);await gate.entered.promise
  const started=app.reads()
  for(let i=0;i<20;i++)app.change(true)
  assert.equal(app.reads(),started,'event bursts must not start parallel credential reads')
  gate.release.resolve();await app.waitStates(2)
  assert.equal(app.states.at(-1).accounts[0].configured,true)
  assert.ok(app.states.at(-1).revision>app.states[0].revision)
  controller.abort()
})

test('an initial state read failure closes the event stream so clients can retry',{timeout:5000},async t=>{
  const app=await setup(t)
  app.failNext()
  const response=await app.fetch('events')
  assert.equal(await response.text(),': connected\n\n')
  assert.equal(app.states.length,0)
  const controller=new AbortController()
  await app.fetch('events',{signal:controller.signal});await app.waitStates(1)
  assert.equal(app.states[0].accounts[0].configured,false)
  controller.abort()
})

test('a later state read failure ends a stale stream instead of silently leaving it open',{timeout:5000},async t=>{
  const app=await setup(t)
  const response=await app.fetch('events')
  const closed=response.text()
  await app.waitStates(1)
  app.failNext();app.change(true)
  const text=await closed
  assert.ok(text.includes('"type":"state"'))
  const controller=new AbortController()
  await app.fetch('events',{signal:controller.signal});await app.waitStates(2)
  assert.equal(app.states[1].accounts[0].configured,true)
  controller.abort()
})
