import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'
import { usageSummary, collectUsage } from '../lib/usage-history.js'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'

const time = Date.UTC(2026, 8, 7, 15)
const header = (provider = 'openai-codex', model = 'main-model') => ({type:'request/header', time, data:{header:{config:{provider, model}}}})
const chunk = (step, input, output, cacheRead = 0, cacheWrite = 0) => ({type:'assistant/chunk', time, data:{turn:1, step, chunk:{type:'usage', usage:{inputTokens:input, outputTokens:output, cacheReadTokens:cacheRead, cacheWriteTokens:cacheWrite}}}})
const final = (step, usage, source) => ({type:'assistant/message', time, data:{turn:1, step, usage, message:{source}}})

async function history(t, events, compressed = false) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-usage-history-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, {recursive:true, force:true}) })
  const dir = join(home, 'sessions', 'workspace', 'session-a')
  await mkdir(dir, {recursive:true})
  const bytes = events.map(event => Buffer.from(JSON.stringify(event) + '\n'))
  await writeFile(join(dir, compressed ? 'session.jsonl.zstd' : 'session.jsonl'), Buffer.concat(compressed ? bytes.map(bytes => zstdCompressSync(bytes)) : bytes))
  return dir
}

test('usage replaces repeated samples with final turn/step usage and includes every token bucket', async t => {
  await history(t, [header(), chunk(1, 10, 2, 30, 4), chunk(1, 12, 3, 40, 5),
    final(1, {inputTokens:15, outputTokens:4, cacheReadTokens:50, cacheWriteTokens:6}, {provider:'openai-codex', model:'main-model'}),
    chunk(2, 0, 0, 0, 9)], true)
  const summary = await usageSummary()
  assert.equal(summary.totals.turns, 2)
  assert.equal(summary.totals.input, 15)
  assert.equal(summary.totals.output, 4)
  assert.equal(summary.totals.cacheRead, 50)
  assert.equal(summary.totals.cacheWrite, 15)
  assert.equal(summary.totals.total, 84)
  assert.equal(summary.models[0].total, 84)
  assert.equal(summary.days[0].total, 84)
  assert.equal(summary.hours.reduce((a,b) => a+b, 0), 84)
})

test('title requests cannot change attribution of later model calls', async t => {
  await history(t, [header(), chunk(1, 10, 2),
    {type:'session/title-llm-request', time, data:{route:{provider:'other', model:'title-model'}}}, chunk(2, 20, 3)])
  const summary = await usageSummary()
  assert.equal(summary.models.length, 1)
  assert.equal(summary.models[0].model, 'main-model')
  assert.equal(summary.models[0].input, 30)
})

test('message-only usage is counted with its actual provider and malformed samples do not replace valid usage', async t => {
  await history(t, [header(), chunk(1, 10, 2), chunk(1, -100, 5),
    final(2, {inputTokens:7, outputTokens:1}, {provider:'anthropic', model:'final-model'})])
  const summary = await usageSummary()
  assert.equal(summary.totals.input, 17)
  assert.equal(summary.totals.turns, 2)
  assert.ok(summary.models.some(model => model.model === 'final-model' && model.provider === 'anthropic'))
})

test('backup artifacts matching a session prefix are not counted as live logs', async t => {
  const dir = await history(t, [header(), chunk(1, 10, 2)])
  await writeFile(join(dir, 'session.jsonl.backup'), [header(), chunk(1, 100, 20)].map(event => JSON.stringify(event)).join('\n'))
  assert.equal((await usageSummary()).totals.input, 10)
})

test('appended logs refresh even when filesystem modification time has not advanced', async t => {
  const dir = await history(t, [header(), chunk(1, 10, 2)])
  const file = join(dir, 'session.jsonl')
  await utimes(file, 1700000000, 1700000000)
  assert.equal((await usageSummary()).totals.input, 10)
  await appendFile(file, JSON.stringify(chunk(2, 20, 3)) + '\n')
  await utimes(file, 1700000000, 1700000000)
  assert.equal((await usageSummary()).totals.input, 30)
})

test('provider/model path separators do not merge different model identities', async t => {
  await history(t, [header('provider/path','model'),chunk(1,10,2),header('provider','path/model'),chunk(2,20,3)])
  assert.equal((await usageSummary()).models.length, 2)
})

test('legacy unkeyed chunks remain readable and zero-valued usage still represents a reported call', async t => {
  const legacy=chunk(1,10,2);delete legacy.data.turn;delete legacy.data.step
  await history(t, [header(),legacy,chunk(2,0,0)])
  const summary=await usageSummary()
  assert.equal(summary.totals.turns,2);assert.equal(summary.totals.total,12)
})

test('a truncated log keeps confirmed usage but reports incomplete coverage until repaired', async t => {
  const dir = await history(t, [header(), chunk(1,10,2)], true)
  const file = join(dir,'session.jsonl.zstd')
  const next = zstdCompressSync(Buffer.from(JSON.stringify(chunk(2,20,3))+'\n'))
  await appendFile(file,next.subarray(0,next.length-2))
  const partial = await usageSummary()
  assert.equal(partial.totals.total,12)
  assert.equal(partial.coverage.complete,false)
  assert.equal(partial.coverage.partial,1)
  assert.equal(partial.coverage.issues.truncated,1)
  await appendFile(file,next.subarray(next.length-2))
  const repaired = await usageSummary()
  assert.equal(repaired.totals.total,35)
  assert.equal(repaired.coverage.complete,true)
})

test('an invalid log cannot be presented as an empty complete history', async t => {
  const dir=await history(t,[])
  await writeFile(join(dir,'session.jsonl'),'not JSON\n')
  const summary=await usageSummary()
  assert.equal(summary.totals.turns,0)
  assert.equal(summary.coverage.complete,false)
  assert.equal(summary.coverage.skipped,1)
  assert.equal(summary.coverage.issues.corrupt,1)
})

test('simultaneous compressed and plain artifacts are flagged rather than double counted', async t => {
  const dir=await history(t,[header(),chunk(1,10,2)])
  await writeFile(join(dir,'session.jsonl.zstd'),zstdCompressSync(Buffer.from(JSON.stringify(chunk(1,10,2))+'\n')))
  const summary=await usageSummary()
  assert.equal(summary.totals.turns,0)
  assert.equal(summary.coverage.skipped,2)
  assert.equal(summary.coverage.issues.ambiguous,1)
})

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return {promise,resolve} }
function observeReads(t) {
  const original = fs.open
  const entered = deferred(), release = deferred()
  let reads = 0
  fs.open = async (...args) => {
    reads++; entered.resolve()
    await release.promise
    return original(...args)
  }
  syncBuiltinESMExports()
  t.after(() => { release.resolve(); fs.open = original; syncBuiltinESMExports() })
  return { entered: entered.promise, release: release.resolve, count: () => reads }
}

test('concurrent Usage and account reads decode each session once, then refresh new writes', async t => {
  const dir = await history(t,[header(),chunk(1,10,2)],true)
  const reads = observeReads(t)
  const requests = Array.from({length:8},()=>usageSummary())
  await reads.entered
  reads.release()
  const summaries = await Promise.all(requests)
  assert.ok(summaries.every(s => s.totals.total === 12))
  assert.equal(reads.count(),1,'overlapping readers must share decoding')
  await appendFile(join(dir,'session.jsonl.zstd'),zstdCompressSync(Buffer.from(JSON.stringify(chunk(2,20,3))+'\n')))
  assert.equal((await usageSummary()).totals.total,35,'completed scans must not become a stale response cache')
  assert.equal(reads.count(),2)
})

test('cancelling one reader does not cancel a surviving reader', async t => {
  await history(t,[header(),chunk(1,10,2)],true)
  const reads = observeReads(t), controller = new AbortController()
  const cancelled = usageSummary({signal:controller.signal})
  const rejected = assert.rejects(cancelled,{name:'AbortError'})
  const survivor = usageSummary()
  await reads.entered
  controller.abort(); reads.release()
  await rejected
  assert.equal((await survivor).totals.total,12)
  assert.equal(reads.count(),1)
})

test('an abandoned scan is not reused by an immediate reopen and does not populate the cache', async t => {
  await history(t,[header(),chunk(1,10,2)],true)
  const reads = observeReads(t), controller = new AbortController()
  const first = usageSummary({signal:controller.signal})
  const rejected = assert.rejects(first,{name:'AbortError'})
  await reads.entered
  controller.abort()
  const reopened = usageSummary()
  reads.release()
  await rejected
  assert.equal((await reopened).totals.total,12)
  assert.equal(reads.count(),2)
})

test('already-aborted usage requests do not open any history files', async t => {
  await history(t,[header(),chunk(1,10,2)],true)
  const reads = observeReads(t)
  reads.release()
  await assert.rejects(usageSummary({signal:AbortSignal.abort()}),{name:'AbortError'})
  assert.equal(reads.count(),0)
})

test('overlapping requests capture their own profile before asynchronous scanning',async t=>{
  await history(t,[header(),chunk(1,10,2)],true)
  const firstHome=process.env.DSH_HOME
  const secondHome=await mkdtemp(join(tmpdir(),'dsh-usage-second-profile-'))
  t.after(()=>rm(secondHome,{recursive:true,force:true}))
  const dir=join(secondHome,'sessions','workspace','session-a')
  await mkdir(dir,{recursive:true})
  await writeFile(join(dir,'session.jsonl'),JSON.stringify(chunk(1,20,3))+'\n')
  const first=usageSummary()
  process.env.DSH_HOME=secondHome
  const second=usageSummary()
  process.env.DSH_HOME=firstHome
  const [a,b]=await Promise.all([first,second])
  assert.equal(a.totals.total,12);assert.equal(b.totals.total,23)
})

test('histories larger than the summary cache keep complete totals without evicting unread hits',async t=>{
  const dir=await history(t,[header(),chunk(1,10,2)],true)
  const workspace=join(dir,'..')
  for(let i=0;i<270;i++) {
    const next=join(workspace,'extra-'+String(i).padStart(3,'0'))
    await mkdir(next)
    await writeFile(join(next,'session.jsonl'),JSON.stringify(chunk(1,1,1))+'\n')
  }
  const reads=observeReads(t);reads.release()
  const first=await usageSummary()
  assert.equal(first.totals.total,552);assert.equal(first.totals.sessions,271);assert.equal(first.coverage.read,271)
  assert.equal(reads.count(),271)
  const second=await usageSummary()
  assert.deepEqual(second,first)
  assert.equal(reads.count()-271,15,'256 cached summaries should survive until read, even during a larger scan')
})

test('cached summaries recompute local calendar days and hours after a timezone change',async t=>{
  const oldZone=process.env.TZ
  t.after(()=>{if(oldZone===undefined)delete process.env.TZ;else process.env.TZ=oldZone})
  const row=chunk(1,10,2);row.time=Date.UTC(2026,8,7,2)
  await history(t,[header(),row],true)
  process.env.TZ='UTC'
  assert.equal((await usageSummary()).days[0].day,'2026-09-07')
  process.env.TZ='America/Los_Angeles'
  const local=await usageSummary()
  assert.equal(local.days[0].day,'2026-09-06');assert.equal(local.hours[19],12)
})

test('the rows-only API remains complete and independent of cached summary objects',async t=>{
  await history(t,[header(),chunk(1,10,2),chunk(1,20,3),chunk(2,1,2)],true)
  const expected=await usageSummary()
  const rows=await collectUsage()
  assert.equal(rows.length,2);assert.equal(rows[0].input,20)
  assert.equal(rows.reduce((n,row)=>n+row.input+row.output+row.cacheRead+row.cacheWrite,0),expected.totals.total)
  rows[0].input=0
  assert.deepEqual(await usageSummary(),expected)
})

test('cached and freshly changed sessions merge every model, day, hour, and timestamp correctly',async t=>{
  const dir=await history(t,[header('a','same'),chunk(1,10,2,3,4)],true)
  const second=join(dir,'..','session-b');await mkdir(second)
  const nextTime=time+86400000
  const other={...chunk(1,20,3,4,5),time:nextTime}
  await writeFile(join(second,'session.jsonl'),[header('b','same'),other].map(row=>JSON.stringify(row)+'\n').join(''))
  const first=await usageSummary()
  assert.equal(first.totals.total,51);assert.equal(first.days.length,2);assert.equal(first.models.length,2)
  const updated={...chunk(1,30,4,5,6),time:nextTime+3600000}
  await appendFile(join(second,'session.jsonl'),JSON.stringify(updated)+'\n')
  const result=await usageSummary()
  assert.deepEqual(result.totals,{input:40,output:6,cacheRead:8,cacheWrite:10,total:64,turns:2,sessions:2,firstAt:time,lastAt:updated.time})
  assert.equal(result.models.find(row=>row.provider==='b').total,45)
  assert.equal(result.days[1].total,45)
  assert.equal(result.hours[new Date(updated.time).getHours()],45)
  assert.equal(result.hours[new Date(time).getHours()],19)
  assert.deepEqual(await usageSummary(),result)
})
