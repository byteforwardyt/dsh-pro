import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createRequire} from 'node:module'
import runtime from '../lib/runtime.cjs'
const require=createRequire(import.meta.url)
const {createSetupHandler}=require('../../../shell/src/development-setup.cjs')

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dsh-setup-test-')))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const bin=path.join(root,'bin');await fs.mkdir(bin)
  const command=async(name,version)=>{await fs.writeFile(path.join(bin,name),'#!/bin/sh\nprintf "%s\\n" '+JSON.stringify(version)+'\n',{mode:0o755})}
  return {root,bin,env:{...process.env,PATH:bin},command}
}
test('missing tools are reported without installing or assuming python exists',async t=>{
  const f=await fixture(t), state=await runtime.inspect(f.root,{env:f.env})
  assert.ok(state.tools.every(tool=>!tool.installed));assert.equal(state.pythonCommand,null)
  assert.deepEqual(await fs.readdir(f.root),['bin'])
})
test('Python 3 without python supplies the exact working command',async t=>{
  const f=await fixture(t);await f.command('python3','Python 3.12.8')
  const state=await runtime.inspect(f.root,{env:f.env})
  assert.equal(state.pythonCommand,path.join(f.bin,'python3'))
  assert.equal(state.tools.find(t=>t.id==='python').installed,false)
})
test('conflicting JavaScript lockfiles require a choice and use argv, not a shell',async t=>{
  const f=await fixture(t);await f.command('npm','10.8.2');await f.command('pnpm','10.8.2')
  await fs.writeFile(path.join(f.root,'package.json'),'{}')
  await fs.writeFile(path.join(f.root,'package-lock.json'),'{}');await fs.writeFile(path.join(f.root,'pnpm-lock.yaml'),'lockfileVersion: 9')
  assert.equal((await runtime.inspect(f.root,{env:f.env})).project.js.ambiguous,true)
  await assert.rejects(runtime.plan(f.root,'javascript',null,{env:f.env}),/Choose a package manager/)
  const plan=await runtime.plan(f.root,'javascript','pnpm',{env:f.env})
  assert.deepEqual(plan.steps,[{command:path.join(f.bin,'pnpm'),args:['install'],cwd:f.root}])
  await assert.rejects(runtime.plan(f.root,'javascript','npm; touch /tmp/pwn',{env:f.env}),/Choose/)
})
test('large lockfiles are detected without loading their contents',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.root,'package.json'),'{}');await fs.writeFile(path.join(f.root,'package-lock.json'),' '.repeat(1100000))
  assert.equal((await runtime.inspect(f.root,{env:f.env})).project.js.manager,'npm')
})
test('pinned package-manager versions cannot match a different major accidentally',async t=>{
  const f=await fixture(t);await f.command('pnpm','11.2.3');await fs.writeFile(path.join(f.root,'package.json'),JSON.stringify({packageManager:'pnpm@1.2.3'}))
  await assert.rejects(runtime.plan(f.root,'javascript',null,{env:f.env}),/requests pnpm 1.2.3/)
})
test('Python installs into .venv and validates packages afterwards',async t=>{
  const f=await fixture(t);await f.command('python3','Python 3.12.8');await fs.writeFile(path.join(f.root,'requirements.txt'),'')
  const plan=await runtime.plan(f.root,'python-project',null,{env:f.env})
  assert.deepEqual(plan.steps.map(s=>s.args),[['-m','venv','.venv'],['-m','pip','install','-r','requirements.txt'],['-m','pip','check']])
  await fs.mkdir(path.join(f.root,'.venv'))
  await assert.rejects(runtime.plan(f.root,'python-project',null,{env:f.env}),/not a Python environment/)
})
test('project metadata links outside the workspace are rejected',async t=>{
  const f=await fixture(t);await fs.symlink('/etc/hosts',path.join(f.root,'package.json'))
  await assert.rejects(runtime.inspect(f.root,{env:f.env}),/outside this workspace/)
})
test('already configured projects are reported without being modified',async t=>{
  const f=await fixture(t);await f.command('node','v24.0.0');await f.command('npm','11.0.0');await fs.writeFile(path.join(f.root,'package.json'),'{}');await fs.mkdir(path.join(f.root,'node_modules'))
  assert.equal((await runtime.inspect(f.root,{env:f.env})).project.js.installed,true)
})
async function finished(runner) {
  for(let i=0;i<100;i++){const state=runner.status();if(state.state!=='running')return state;await new Promise(r=>setTimeout(r,20))}
  throw Error('setup did not finish')
}
test('runner reports real subprocess success and failure',async t=>{
  const f=await fixture(t),runner=runtime.createRunner()
  await runner.start({task:'test',root:f.root,steps:[{command:process.execPath,args:['-e','console.log("setup completed")'],cwd:f.root}]},process.env)
  let state=await finished(runner);assert.equal(state.state,'complete');assert.match(state.output,/setup completed/)
  await runner.start({task:'test',root:f.root,steps:[{command:process.execPath,args:['-e','process.exit(7)'],cwd:f.root}]},process.env)
  state=await finished(runner);assert.equal(state.state,'failed');assert.match(state.error,/code 7/)
})
test('runner cancellation prevents later steps from executing',async t=>{
  const f=await fixture(t),runner=runtime.createRunner()
  await runner.start({task:'test',root:f.root,steps:[{command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:f.root},{command:process.execPath,args:['-e','require("fs").writeFileSync("unexpected","")'],cwd:f.root}]},process.env)
  await new Promise(r=>setTimeout(r,50));assert.equal(runner.cancel().state,'cancelled')
  await new Promise(r=>setTimeout(r,50));await assert.rejects(fs.access(path.join(f.root,'unexpected')))
})
test('desktop handler rejects unregistered roots and cancelled native reviews',async t=>{
  const f=await fixture(t);await f.command('npm','11.0.0');await fs.writeFile(path.join(f.root,'package.json'),'{}')
  const handler=createSetupHandler({runtime,getRoots:async()=>[{canonicalPath:f.root}],getEnv:()=>f.env,toolsDir:path.join(f.root,'tools'),confirm:async()=>false,openExternal:async()=>{}})
  await assert.rejects(handler.handle('check',{root:'/tmp'}),/not an open workspace/)
  assert.equal((await handler.handle('install',{root:f.root,task:'javascript'})).state,'cancelled')
  assert.equal((await handler.handle('status')).state,'idle')
  await assert.rejects(handler.handle('open-installer',{tool:'https://attacker.test'}),/Unknown/)
  await assert.rejects(handler.handle('execute',{command:'anything'}),/Unknown/)
})
test('changing project configuration during native review invalidates installation',async t=>{
  const f=await fixture(t);await f.command('npm','11.0.0');await fs.writeFile(path.join(f.root,'package.json'),'{}')
  const handler=createSetupHandler({runtime,getRoots:async()=>[{canonicalPath:f.root}],getEnv:()=>f.env,toolsDir:path.join(f.root,'tools'),confirm:async()=>{await fs.writeFile(path.join(f.root,'package.json'),'{"name":"changed"}');return true;},openExternal:async()=>{}})
  await assert.rejects(handler.handle('install',{root:f.root,task:'javascript'}),/changed during review/)
})
