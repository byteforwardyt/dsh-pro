import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {mkdtemp,realpath,readFile,rm,symlink,mkdir,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createUploads,UPLOAD_LIMIT} from '../lib/uploads.js'
const stream=(bytes,headers={})=>Object.assign(Readable.from([bytes]),{headers:{'content-type':'application/octet-stream',...headers}})
test('uploads preserve bytes, original names and unique paths; never overwrite',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-upload-')));t.after(()=>rm(root,{recursive:true,force:true}));const api=createUploads({workspaceRegistry:{list:()=>[{path:root}]}})
 const bytes=Buffer.from([0,1,255,128,42]);const a=await api.receive(stream(bytes),root,'clip.mp3'),b=await api.receive(stream(bytes),root,'clip.mp3')
 assert.equal(a.type,'audio/mpeg');assert.equal(a.size,bytes.length);assert.notEqual(a.path,b.path);assert.deepEqual(await readFile(a.path),bytes)
 await assert.rejects(api.receive(stream(bytes),root,'../escape'),{status:400})
 await assert.rejects(api.receive(stream(bytes,{'content-length':String(UPLOAD_LIMIT+1)}),root,'large'),{status:413})
 await assert.rejects(api.receive(stream(bytes,{'content-type':'text/plain'}),root,'other'),{status:415})
 await assert.rejects(api.receive(stream(bytes),tmpdir(),'other'),{status:403})
})
test('uploads refuse symlink storage escape',async t=>{
 const parent=await realpath(await mkdtemp(join(tmpdir(),'dsh-upload-link-')));t.after(()=>rm(parent,{recursive:true,force:true}));const root=join(parent,'root'),outside=join(parent,'outside');await mkdir(root);await mkdir(outside);await symlink(outside,join(root,'.dsh-attachments'))
 const api=createUploads({workspaceRegistry:{list:()=>[{path:root}]}});await assert.rejects(api.receive(stream(Buffer.from('x')),root,'x'),{status:403});assert.deepEqual(await readdir(outside),[])
})
