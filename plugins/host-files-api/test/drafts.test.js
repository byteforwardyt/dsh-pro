import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile, symlink, realpath, open, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraftStore } from '../lib/drafts.js'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-drafts-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const path = join(home, 'project.txt')
  await writeFile(path, 'disk version')
  return { home, path, store: createDraftStore(home) }
}
const snapshot = { text: 'unsaved work', base: { text: 'disk version', version: 'v1' } }

test('drafts survive a new store instance without changing the project file', async t => {
  const f = await fixture(t)
  const saved = await f.store.replace(f.path, snapshot, null)
  const recovered = await createDraftStore(f.home).read(f.path)
  assert.deepEqual(recovered, saved)
  assert.equal(recovered.base.version, 'v1')
  assert.equal(recovered.text, 'unsaved work')
  assert.equal(await readFile(f.path, 'utf8'), 'disk version')
  const directory = join(f.home, 'file-drafts')
  const names = await readdir(directory)
  assert.equal(names.length, 1)
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600)
})

test('concurrent replacements cannot overwrite a newer backup', async t => {
  const f = await fixture(t)
  const first = await f.store.replace(f.path, snapshot, null)
  const result = await Promise.allSettled([
    f.store.replace(f.path, { ...snapshot, text: 'window A' }, first.revision),
    f.store.replace(f.path, { ...snapshot, text: 'window B' }, first.revision),
  ])
  assert.equal(result[0].status, 'fulfilled')
  assert.equal(result[1].reason.code, 'DRAFT_CONFLICT')
  assert.equal((await f.store.read(f.path)).text, 'window A')
})

test('a stale clear cannot remove a newer draft and a matching clear removes it', async t => {
  const f = await fixture(t)
  const first = await f.store.replace(f.path, snapshot, null)
  const next = await f.store.replace(f.path, { ...snapshot, text: 'new work' }, first.revision)
  await assert.rejects(f.store.replace(f.path, null, first.revision), { code: 'DRAFT_CONFLICT' })
  assert.equal((await f.store.read(f.path)).text, 'new work')
  await f.store.replace(f.path, null, next.revision)
  assert.equal(await f.store.read(f.path), null)
})

test('invalid or oversized snapshots preserve the previous backup', async t => {
  const f = await fixture(t)
  const first = await f.store.replace(f.path, snapshot, null)
  await assert.rejects(f.store.replace(f.path, { text: 'missing baseline' }, first.revision), { code: 'DRAFT_INVALID' })
  await assert.rejects(f.store.replace(f.path, { ...snapshot, text: '🔥'.repeat(600000) }, first.revision), { code: 'FS_TOO_LARGE' })
  assert.equal((await f.store.read(f.path)).revision, first.revision)
})

test('a corrupt backup is preserved instead of overwritten or silently discarded', async t => {
  const f = await fixture(t)
  await f.store.replace(f.path, snapshot, null)
  const directory = join(f.home, 'file-drafts')
  const file = join(directory, (await readdir(directory))[0])
  await writeFile(file, 'damaged record')
  await assert.rejects(f.store.read(f.path), { code: 'DRAFT_CORRUPT' })
  await assert.rejects(f.store.replace(f.path, snapshot, null), { code: 'DRAFT_CORRUPT' })
  assert.equal(await readFile(file, 'utf8'), 'damaged record')
})

test('an absent app home fails explicitly instead of writing in the project', async () => {
  await assert.rejects(createDraftStore().read('/workspace/file.txt'), { code: 'DRAFT_UNAVAILABLE' })
  await assert.rejects(createDraftStore().list(), { code: 'DRAFT_UNAVAILABLE' })
})

test('inventory is metadata-only, survives recreation, and preserves unreadable records', async t => {
  const f=await fixture(t)
  assert.deepEqual(await f.store.list(),{drafts:[],unreadable:0})
  const saved=await f.store.replace(f.path,snapshot,null)
  const inventory=await createDraftStore(f.home).list()
  assert.deepEqual(inventory,{drafts:[{path:f.path,revision:saved.revision,updatedAt:saved.updatedAt,bytes:Buffer.byteLength(snapshot.text)}],unreadable:0})
  const directory=join(f.home,'file-drafts')
  await writeFile(join(directory,'a'.repeat(64)+'.json'),'broken')
  await writeFile(join(directory,'ignored.tmp'),'unfinished')
  await symlink(f.path,join(directory,'b'.repeat(64)+'.json'))
  const again=await f.store.list()
  assert.equal(again.drafts.length,1);assert.equal(again.unreadable,1)
  assert.equal(await readFile(join(directory,'a'.repeat(64)+'.json'),'utf8'),'broken')
})

test('oversized stored records are refused and preserved without hiding healthy backups', async t => {
  const f=await fixture(t)
  await f.store.replace(f.path,snapshot,null)
  const directory=join(f.home,'file-drafts')
  const file=join(directory,(await readdir(directory))[0])
  const healthy=join(f.home,'healthy.txt')
  await f.store.replace(healthy,snapshot,null)
  // Syntactically valid JSON used to bypass every bound via an unknown field.
  const record=JSON.parse(await readFile(file,'utf8'))
  const handle=await open(file,'w')
  try {
    await handle.write(JSON.stringify(record).slice(0,-1)+',"padding":"')
    const chunk=Buffer.alloc(1024*1024,0x78)
    for(let i=0;i<33;i++)await handle.write(chunk)
    await handle.write('"}')
  } finally { await handle.close() }
  const size=(await stat(file)).size
  await assert.rejects(f.store.read(f.path),{code:'DRAFT_CORRUPT'})
  await assert.rejects(f.store.replace(f.path,null,record.revision),{code:'DRAFT_CORRUPT'})
  const inventory=await f.store.list()
  assert.deepEqual(inventory.drafts.map(draft=>draft.path),[healthy]);assert.equal(inventory.unreadable,1)
  assert.equal((await stat(file)).size,size)
})

test('valid maximum editor buffers remain readable even when JSON escaping expands them', async t => {
  const f=await fixture(t),text='\u0001'.repeat(2*1024*1024)
  const saved=await f.store.replace(f.path,{text,base:{text,version:'v1'}},null)
  assert.equal((await f.store.read(f.path)).text,text)
  assert.equal((await f.store.list()).drafts[0].revision,saved.revision)
  await assert.rejects(f.store.replace(f.path,{text,base:{text,version:'\u0001'.repeat(2*1024*1024)}},saved.revision),{code:'FS_TOO_LARGE'})
  assert.equal((await f.store.read(f.path)).revision,saved.revision,'oversized metadata cannot replace a valid backup')
})

test('temporarily unreadable backups remain recoverable after permission repair', async t => {
  const f=await fixture(t),saved=await f.store.replace(f.path,snapshot,null)
  const directory=join(f.home,'file-drafts'),file=join(directory,(await readdir(directory))[0])
  await chmod(file,0)
  try {
    await assert.rejects(f.store.read(f.path),{code:'DRAFT_CORRUPT'})
    assert.deepEqual(await f.store.list(),{drafts:[],unreadable:1})
    await assert.rejects(f.store.replace(f.path,snapshot,saved.revision),{code:'DRAFT_CORRUPT'})
  } finally { await chmod(file,0o600) }
  assert.equal((await f.store.read(f.path)).revision,saved.revision)
})

test('a backup replaced by a symlink cannot be read, overwritten, or cleared through the store', async t => {
  const f=await fixture(t)
  const saved=await f.store.replace(f.path,snapshot,null)
  const directory=join(f.home,'file-drafts'),file=join(directory,(await readdir(directory))[0])
  const target=join(f.home,'linked-record.json'),contents=await readFile(file,'utf8')
  await writeFile(target,contents);await rm(file);await symlink(target,file)
  await assert.rejects(f.store.read(f.path),{code:'DRAFT_CORRUPT'})
  await assert.rejects(f.store.replace(f.path,null,saved.revision),{code:'DRAFT_CORRUPT'})
  assert.equal(await readFile(target,'utf8'),contents)
})

test('registered draft API preserves backups across host recreation and fences workspace access', async t => {
  const {apply}=await import('../lib/index.js')
  const {createServer}=await import('node:http')
  const {once}=await import('node:events')
  const f=await fixture(t)
  const alias=join(f.home,'workspace-alias')
  await symlink(f.home,alias)
  let roots=[alias]
  async function host() {
    let handler,dispose
    const previous=process.env.DSH_HOME
    process.env.DSH_HOME=f.home
    try {
      apply({workspaceRegistry:{list:()=>roots.map(path=>({path}))},
        fs:{},webServer:{register(config){handler=config.handler;return()=>{}}},
        on(event,fn){if(event==='dispose')dispose=fn}})
    } finally {if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous}
    const server=createServer((req,res)=>handler(req,res))
    server.listen(0,'127.0.0.1');await once(server,'listening')
    const origin=`http://127.0.0.1:${server.address().port}`
    const stop=async()=>{dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
    t.after(stop)
    return {origin,stop}
  }
  const first=await host()
  const listedRoots=await (await fetch(first.origin+'/dsh-files/roots')).json()
  const workspace=listedRoots.roots.find(root=>root.path===alias)
  assert.equal(workspace.canonicalPath,await realpath(f.home),'root discovery must share the file/draft path identity')
  const post=(origin,body)=>fetch(origin+'/dsh-files/draft',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const saved=await post(first.origin,{path:f.path,draft:snapshot,revision:null})
  assert.equal(saved.status,200)
  const revision=(await saved.json()).revision
  await first.stop()
  const next=await host()
  const url=next.origin+'/dsh-files/draft?path='+encodeURIComponent(f.path)
  const restored=await fetch(url)
  assert.equal(restored.status,200)
  assert.equal((await restored.json()).draft.text,snapshot.text)
  await f.store.replace(join(tmpdir(),'outside-recovery.txt'),snapshot,null)
  const inventoryUrl=next.origin+'/dsh-files/drafts'
  const inventory=await (await fetch(inventoryUrl)).json()
  assert.deepEqual(inventory.drafts.map(entry=>entry.path),[await realpath(f.path)])
  assert.equal(Object.hasOwn(inventory.drafts[0],'text'),false)
  const streamUrl=inventoryUrl+'/stream'
  const streamed=await fetch(streamUrl)
  assert.match(streamed.headers.get('content-type'),/application\/x-ndjson/)
  const batches=(await streamed.text()).trim().split('\n').map(line=>JSON.parse(line))
  assert.equal(batches.at(-1).done,true)
  assert.deepEqual(batches.flatMap(batch=>batch.drafts).map(entry=>entry.path),[await realpath(f.path)])
  assert.ok(batches.flatMap(batch=>batch.drafts).every(entry=>!Object.hasOwn(entry,'text')&&!Object.hasOwn(entry,'base')))
  assert.equal((await fetch(streamUrl,{headers:{origin:'https://untrusted.example','sec-fetch-site':'cross-site'}})).status,403)
  assert.equal((await fetch(inventoryUrl,{headers:{origin:'https://untrusted.example','sec-fetch-site':'cross-site'}})).status,403)
  assert.equal((await fetch(url,{headers:{origin:'https://untrusted.example','sec-fetch-site':'cross-site'}})).status,403)
  assert.equal((await fetch(next.origin+'/dsh-files/draft?path='+encodeURIComponent(join(tmpdir(),'outside.txt')))).status,403)
  assert.equal((await post(next.origin,{path:f.path,draft:null,revision:'stale'})).status,409)
  await rm(f.path)
  assert.equal((await (await fetch(url)).json()).draft.text,snapshot.text,'deleted project files retain their backup')
  assert.equal((await (await fetch(inventoryUrl)).json()).drafts.length,1,'missing project files stay discoverable')
  roots=[]
  assert.equal((await fetch(url)).status,403,'removing a workspace revokes access to its recovery records')
  assert.deepEqual((await (await fetch(inventoryUrl)).json()).drafts,[])
  const revoked=(await (await fetch(streamUrl)).text()).trim().split('\n').map(line=>JSON.parse(line))
  assert.deepEqual(revoked.flatMap(batch=>batch.drafts),[])
  roots=[f.home]
  assert.equal((await post(next.origin,{path:f.path,draft:null,revision})).status,200)
  assert.equal((await (await fetch(url)).json()).draft,null)
})

test('new inventory headers remain valid JSON and legacy records stay compatible', async t => {
  const f=await fixture(t),saved=await f.store.replace(f.path,snapshot,null)
  const directory=join(f.home,'file-drafts'),file=join(directory,(await readdir(directory))[0])
  const raw=await readFile(file,'utf8'),stored=JSON.parse(raw)
  assert.equal(stored.inventoryVersion,1);assert.equal(stored.bytes,Buffer.byteLength(snapshot.text))
  assert.ok(raw.indexOf('\n')<1024,'metadata precedes the editor buffers')
  assert.deepEqual(await f.store.read(f.path),saved,'the public record shape stays compatible')
  await writeFile(file,JSON.stringify(saved))
  assert.equal((await createDraftStore(f.home).list()).drafts[0].revision,saved.revision)
  assert.deepEqual(await f.store.read(f.path),saved)
})

test('metadata listing never treats a header as proof that the draft body is valid', async t => {
  const f=await fixture(t);await f.store.replace(f.path,snapshot,null)
  const directory=join(f.home,'file-drafts'),file=join(directory,(await readdir(directory))[0])
  const raw=await readFile(file,'utf8');await writeFile(file,raw.slice(0,raw.indexOf('\n')+1)+'broken body')
  assert.equal((await f.store.list()).drafts.length,1,'inventory reads only metadata for the new format')
  await assert.rejects(f.store.read(f.path),{code:'DRAFT_CORRUPT'})
  await assert.rejects(f.store.replace(f.path,null,null),{code:'DRAFT_CORRUPT'})
  assert.match(await readFile(file,'utf8'),/broken body$/)
})

test('metadata scan cancellation stops iteration and preserves every backup', async t => {
  const f=await fixture(t)
  for(let i=0;i<120;i++)await f.store.replace(join(f.home,`file-${i}.txt`),snapshot,null)
  const controller=new AbortController(),scan=f.store.inventory({signal:controller.signal})
  assert.equal((await scan.next()).done,false);controller.abort()
  await assert.rejects(scan.next(),{name:'AbortError'})
  assert.equal((await f.store.list()).drafts.length,120)
})
