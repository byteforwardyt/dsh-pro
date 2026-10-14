'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {startHost,stopHost,READY_LINE}=require('../src/host-process.cjs')
test('authenticated startup keeps the complete private URL separate from the public origin and logs',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-launch-test-'))
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}))
 const entry=path.join(home,'fixture.cjs'),token='fixture_private_token-123_'
 fs.writeFileSync(entry,`console.error('problem ?token=${token}');console.log('dsh web: http://127.0.0.1:23456/?token=${token}');setInterval(()=>{},1000)`)
 const logs=[]
 const host=await startHost({entry,profile:'fixture',dshHome:home,cwd:home,onLog:(_stream,line)=>logs.push(line)})
 await stopHost(host.child)
 assert.equal(host.url,'http://127.0.0.1:23456')
 assert.equal(host.launchUrl,`http://127.0.0.1:23456/?token=${token}`)
 assert.ok(logs.length>=2)
 assert.ok(logs.every(line=>!line.includes(token)))
 assert.ok(logs.some(line=>line.includes('[redacted]')))
 assert.equal(READY_LINE.exec(`dsh web: ${host.launchUrl}`)[1],host.launchUrl)
})
