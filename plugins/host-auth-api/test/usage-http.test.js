import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'
import { recordSnapshot } from '../lib/usage-observer.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return {promise,resolve} }

async function setup(t) {
  const home = await fs.mkdtemp(join(tmpdir(),'dsh-usage-http-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    await fs.rm(home,{recursive:true,force:true})
  })
  for (const name of ['a','b','c']) {
    const dir = join(home,'sessions','workspace',name)
    await fs.mkdir(dir,{recursive:true})
    await fs.writeFile(join(dir,'session.jsonl'),JSON.stringify({type:'assistant/chunk',time:1,
      data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}})+'\n')
  }
  // No real provider/local-model traffic: the registered plugin's detection
  // seam receives unavailable responses. Test HTTP requests use nativeFetch.
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async () => ({ok:false})
  let handler,accountReads=0,disposed=false
  const callbacks = new Map()
  apply({
    authorization:{list:()=>{accountReads++;return[]}},credentials:{},
    webServer:{register(config){handler=config.handler;return()=>{}}},
    on(event,fn){callbacks.set(event,fn)},
  })
  const responses = new Map()
  const server = createServer((req,res)=>{
    const done=deferred(),closed=deferred()
    responses.set(req.url,{res,done:done.promise,closed:closed.promise})
    res.once('close',closed.resolve)
    Promise.resolve(handler(req,res)).then(done.resolve,error=>{res.destroy(error);done.resolve(error)})
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const dispose=()=>{if(!disposed){disposed=true;callbacks.get('dispose')()}}
  t.after(async()=>{
    dispose()
    globalThis.fetch=nativeFetch
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  })
  const original=fs.open, entered=deferred(),release=deferred(),firstClosed=deferred()
  let opens=0
  fs.open=async(...args)=>{
    const first=++opens===1
    entered.resolve();await release.promise
    const handle=await original(...args)
    if(first){const close=handle.close.bind(handle);handle.close=async()=>{try{return await close()}finally{firstClosed.resolve()}}}
    return handle
  }
  syncBuiltinESMExports()
  t.after(()=>{release.resolve();fs.open=original;syncBuiltinESMExports()})
  const origin=`http://127.0.0.1:${server.address().port}`
  return {home,fetch:(route,init)=>nativeFetch(origin+route,init),responses,callbacks,dispose,accountReads:()=>accountReads,
    reads:{entered:entered.promise,release:release.resolve,firstClosed:firstClosed.promise,count:()=>opens}}
}

test('closing a real Usage HTTP response abandons its scan and reopening reads all sessions',{timeout:5000},async t=>{
  const app=await setup(t),controller=new AbortController()
  const request=app.fetch('/dsh-auth/usage',{signal:controller.signal})
  const rejected=assert.rejects(request,{name:'AbortError'})
  await app.reads.entered
  controller.abort();await rejected
  await app.responses.get('/dsh-auth/usage').closed
  app.reads.release()
  await app.responses.get('/dsh-auth/usage').done
  await app.reads.firstClosed
  assert.equal(app.reads.count(),1,'disconnected request must not open remaining sessions')
  const response=await app.fetch('/dsh-auth/usage')
  assert.equal(response.status,200)
  const summary=await response.json()
  assert.equal(summary.totals.total,36);assert.equal(summary.coverage.read,3)
  assert.equal(app.reads.count(),4)
})

test('an account-state reader keeps shared usage work alive when the Usage reader closes',{timeout:5000},async t=>{
  const app=await setup(t),controller=new AbortController()
  const request=app.fetch('/dsh-auth/usage',{signal:controller.signal})
  const rejected=assert.rejects(request,{name:'AbortError'})
  await app.reads.entered
  const stateRequest=app.fetch('/dsh-auth/state')
  // Wait for the second route to enter. Its credential list is empty, so the
  // next event-loop turn reaches its shared usage subscription.
  while(!app.responses.has('/dsh-auth/state')) await new Promise(setImmediate)
  await new Promise(setImmediate)
  controller.abort();await rejected
  await app.responses.get('/dsh-auth/usage').closed
  app.reads.release()
  const state=await (await stateRequest).json()
  assert.equal(state.spend.total.total,36);assert.equal(state.spend.coverage.complete,true)
  assert.equal(app.reads.count(),3,'the surviving reader must reuse the initial scan')
})

test('credential and usage events do not scan history with no subscribed surfaces',{timeout:5000},async t=>{
  const app=await setup(t)
  app.reads.release()
  const before=app.accountReads()
  app.callbacks.get('credentials/record-updated')('fixture')
  recordSnapshot('fixture',{primary:{usedPercent:1}})
  assert.equal(app.accountReads(),before,'no state read should start without subscribers')
  await new Promise(setImmediate);await new Promise(setImmediate)
  assert.equal(app.reads.count(),0)
})

test('closing the initial account SSE stream cancels its history read',{timeout:5000},async t=>{
  const app=await setup(t),controller=new AbortController()
  const response=await app.fetch('/dsh-auth/events',{signal:controller.signal})
  assert.equal(response.status,200)
  await app.reads.entered
  controller.abort()
  await app.responses.get('/dsh-auth/events').closed
  app.reads.release();await app.reads.firstClosed
  assert.equal(app.reads.count(),1)
})

test('plugin disposal stops outstanding reads and closes their HTTP responses',{timeout:5000},async t=>{
  const app=await setup(t)
  const request=app.fetch('/dsh-auth/usage')
  const rejected=assert.rejects(request)
  await app.reads.entered
  app.dispose()
  await rejected
  app.reads.release();await app.reads.firstClosed
  assert.equal(app.reads.count(),1)
})

test('account event streams remain subscribed after GET completion and refresh changed history',{timeout:5000},async t=>{
  const app=await setup(t),controller=new AbortController()
  const response=await app.fetch('/dsh-auth/events',{signal:controller.signal})
  const reader=response.body.getReader(),decoder=new TextDecoder()
  let pending=''
  const nextState=async()=>{
    for(;;){
      const end=pending.indexOf('\n\n')
      if(end>=0){
        const frame=pending.slice(0,end);pending=pending.slice(end+2)
        if(frame.startsWith('data: ')){const event=JSON.parse(frame.slice(6));if(event.type==='state')return event}
        continue
      }
      const chunk=await reader.read()
      assert.equal(chunk.done,false)
      pending+=decoder.decode(chunk.value,{stream:true})
    }
  }
  app.reads.release()
  assert.equal((await nextState()).spend.total.total,36)
  await fs.appendFile(join(app.home,'sessions','workspace','a','session.jsonl'),JSON.stringify({type:'assistant/chunk',time:2,
    data:{turn:1,step:2,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}})+'\n')
  app.callbacks.get('credentials/record-updated')('fixture')
  assert.equal((await nextState()).spend.total.total,48)
  assert.equal(app.reads.count(),4)
  controller.abort();await app.responses.get('/dsh-auth/events').closed
  const before=app.accountReads()
  app.callbacks.get('credentials/record-updated')('fixture')
  assert.equal(app.accountReads(),before)
})
