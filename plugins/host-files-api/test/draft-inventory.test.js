import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { streamDraftInventory } from '../lib/draft-inventory.js'

async function fixture(t) {
  const home=await realpath(await mkdtemp(join(tmpdir(),'dsh-inventory-stream-')))
  t.after(()=>rm(home,{recursive:true,force:true}))
  const req=new EventEmitter(),res=new EventEmitter(),chunks=[]
  Object.assign(res,{destroyed:false,writeHead(){},write(line){chunks.push(JSON.parse(line));return !res.block},
    end(line){if(line)chunks.push(JSON.parse(line));res.ended=true},destroy(){res.destroyed=true;res.emit('close')}})
  const lifetime=new AbortController();t.after(()=>lifetime.abort())
  return {home,req,res,chunks,lifetime,ctx:{workspaceRegistry:{list:()=>[{path:home}]}}}
}
async function until(predicate){for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2))}throw Error('Stream did not reach expected state')}

test('stream backpressure pauses scanning and disconnect closes the inventory iterator',async t=>{
  const f=await fixture(t);let pulled=0,closed=false
  const store={async * inventory(){try{for(let i=0;i<500;i++){pulled++;yield {draft:{path:join(f.home,`file-${i}`),revision:'r',updatedAt:'2026-09-07T00:00:00Z',bytes:12}}}}finally{closed=true}}}
  const original=f.res.write;f.res.write=line=>{const result=original(line);if(f.chunks.length===1)f.res.block=true;return result}
  const running=streamDraftInventory(f.req,f.res,store,f.ctx,f.lifetime.signal)
  await until(()=>f.chunks.length===2)
  // The elapsed-time flush can produce a smaller first batch under load.
  const pausedAt=pulled
  assert.ok(pausedAt>0&&pausedAt<=25);assert.equal(f.chunks[1].drafts.length,pausedAt)
  f.res.destroy();await running
  assert.equal(closed,true);assert.equal(pulled,pausedAt);assert.equal(f.req.listenerCount('aborted'),0)
})

test('stream yields bounded metadata batches and a terminal completion record',async t=>{
  const f=await fixture(t)
  const store={async * inventory(){for(let i=0;i<63;i++)yield {draft:{path:join(f.home,`file-${i}`),revision:'r',updatedAt:'2026-09-07T00:00:00Z',bytes:12}};yield {unreadable:true}}}
  await streamDraftInventory(f.req,f.res,store,f.ctx,f.lifetime.signal)
  assert.equal(f.res.ended,true);assert.equal(f.chunks.at(-1).done,true)
  assert.equal(f.chunks.at(-1).scanned,64);assert.equal(f.chunks.at(-1).unreadable,1)
  assert.equal(f.chunks.flatMap(x=>x.drafts).length,63)
  assert.ok(f.chunks.every(x=>x.drafts.length<=25));assert.equal(f.res.listenerCount('close'),0)
})
