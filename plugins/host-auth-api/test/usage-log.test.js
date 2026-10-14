import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, symlink, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync, constants } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { readUsageLog, MAX_LOG_BYTES } from '../lib/usage-log.js'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'

const event={type:'assistant/chunk',time:1,data:{turn:1,step:1,chunk:{type:'usage',usage:{inputTokens:10,outputTokens:2}}}}
const line=Buffer.from(JSON.stringify(event)+'\n')
async function fixture(t,bytes,name='session.jsonl.zstd') {
  const dir=await mkdtemp(join(tmpdir(),'dsh-usage-log-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const file=join(dir,name);await writeFile(file,bytes)
  return {file,dir}
}

test('Zstandard magic inside an uncompressed payload is not mistaken for a frame boundary',async t=>{
  const payload=Buffer.concat([Buffer.from('{"type":"request/header","note":"'),Buffer.from([0x28,0xb5,0x2f,0xfd]),Buffer.from('"}\n')])
  const header=Buffer.from([0x28,0xb5,0x2f,0xfd,0x20,payload.length,0,0,0])
  header.writeUIntLE((payload.length<<3)|1,6,3)
  const {file}=await fixture(t,Buffer.concat([header,payload,zstdCompressSync(line)]))
  const result=await readUsageLog(file)
  assert.equal(result.issue,null);assert.equal(result.events.length,2)
  assert.deepEqual(result.events[1],event)
})

test('decoded output is capped even when a small frame expands dramatically',async t=>{
  const huge=Buffer.from(JSON.stringify({type:'unrelated',text:'a'.repeat(1024*1024)})+'\n')
  const {file}=await fixture(t,Buffer.concat([zstdCompressSync(line),zstdCompressSync(huge)]))
  const result=await readUsageLog(file,{maxDecodedBytes:1024})
  assert.equal(result.issue,'oversized');assert.deepEqual(result.events,[event])
})

test('checksum corruption stops at the confirmed prefix without reading later frames',async t=>{
  const bad=zstdCompressSync(line,{params:{[constants.ZSTD_c_checksumFlag]:1}})
  bad[bad.length-1]^=1
  const {file}=await fixture(t,Buffer.concat([zstdCompressSync(line),bad,zstdCompressSync(line)]))
  const result=await readUsageLog(file)
  assert.equal(result.issue,'corrupt');assert.deepEqual(result.events,[event])
})

test('partial JSON records across complete frames are reassembled, but unterminated tails are not counted',async t=>{
  const middle=Math.floor(line.length/2)
  const {file}=await fixture(t,Buffer.concat([zstdCompressSync(line.subarray(0,middle)),zstdCompressSync(line.subarray(middle))]))
  assert.deepEqual((await readUsageLog(file)).events,[event])
  await writeFile(file,zstdCompressSync(line.subarray(0,line.length-1)))
  const result=await readUsageLog(file)
  assert.equal(result.issue,'truncated');assert.deepEqual(result.events,[])
})

test('malformed JSON ends the readable prefix instead of silently skipping to a later model context',async t=>{
  const {file}=await fixture(t,Buffer.concat([line,Buffer.from('broken\n'),line]),'session.jsonl')
  const result=await readUsageLog(file)
  assert.equal(result.issue,'corrupt');assert.deepEqual(result.events,[event])
})

test('oversized files, symlinks, and nonregular artifacts are refused before reading',async t=>{
  const {file,dir}=await fixture(t,Buffer.alloc(0))
  const handle=await open(file,'r+');await handle.truncate(MAX_LOG_BYTES+1);await handle.close()
  assert.equal((await readUsageLog(file)).issue,'oversized')
  const link=join(dir,'link.zstd');await symlink(file,link)
  assert.equal((await readUsageLog(link)).issue,'unreadable')
  assert.equal((await readUsageLog(dir)).issue,'unreadable')
  if(process.platform!=='win32') {
    const fifo=join(dir,'pipe');execFileSync('mkfifo',[fifo])
    assert.equal((await readUsageLog(fifo)).issue,'unreadable')
  }
})

test('an unsupported session version and an empty in-flight artifact remain incomplete',async t=>{
  const {file}=await fixture(t,Buffer.from('{"type":"session","version":100}\n'),'session.jsonl')
  assert.equal((await readUsageLog(file)).issue,'corrupt')
  await writeFile(file,'');assert.equal((await readUsageLog(file)).issue,'truncated')
})

test('aborted log reads reject instead of reporting corrupt or partial history',async t=>{
  const {file}=await fixture(t,zstdCompressSync(line))
  await assert.rejects(readUsageLog(file,{signal:AbortSignal.abort()}),{name:'AbortError'})
})

test('parsing a loaded log yields so a pending cancellation can stop record processing',async t=>{
  const {file}=await fixture(t,Buffer.concat(Array.from({length:2048},()=>line)),'session.jsonl')
  const controller=new AbortController(),original=fs.open
  fs.open=async(...args)=>{
    const handle=await original(...args),close=handle.close.bind(handle)
    handle.close=async()=>{
      await close()
      // Schedule from the completed file read: this cannot abort before I/O.
      setImmediate(()=>controller.abort())
    }
    return handle
  }
  syncBuiltinESMExports()
  t.after(()=>{fs.open=original;syncBuiltinESMExports()})
  await assert.rejects(readUsageLog(file,{signal:controller.signal}),{name:'AbortError'})
})

test('streaming consumers receive events without retaining their message bodies in the result',async t=>{
  const message={...event,type:'assistant/message',data:{turn:1,step:1,usage:{inputTokens:10,outputTokens:2},message:{content:'x'.repeat(10000)}}}
  const {file}=await fixture(t,zstdCompressSync(Buffer.from((JSON.stringify(message)+'\n').repeat(200))))
  let seen=0
  const result=await readUsageLog(file,{onEvent:row=>{assert.equal(row.data.message.content.length,10000);seen++}})
  assert.equal(seen,200);assert.equal(result.issue,null);assert.deepEqual(result.events,[])
})

test('a streaming consumer failure is not mislabeled as a corrupt log',async t=>{
  const {file}=await fixture(t,zstdCompressSync(line))
  const expected=new Error('consumer failed')
  await assert.rejects(readUsageLog(file,{onEvent:()=>{throw expected}}),error=>error===expected)
})
