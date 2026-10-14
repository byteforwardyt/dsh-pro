import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createGit } from '../lib/git.js'
const exec = promisify(execFile)
async function fixture(t) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-git-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const run=(cmd,args,opts)=>exec(cmd,args,{...opts,env:{...opts.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})
 const git=(...args)=>run('git',args,{cwd:root})
 await git('init','-b','main');await git('config','user.name','DSH fixture');await git('config','user.email','fixture@example.invalid')
 const api=createGit({workspaceRegistry:{list:()=>[{path:root}]}},run)
 return {root,git,api}
}
test('stage, review, commit, modify, unstage and switch real repository',async t=>{
 const {root,git,api}=await fixture(t)
 await writeFile(join(root,'hello.txt'),'first\n')
 let s=await api.read(root);assert.equal(s.untracked,1);assert.equal(s.unborn,true)
 s=await api.change({root,revision:s.revision,action:'stage',path:'hello.txt'});assert.equal(s.staged,1);assert.match(s.stagedDiff,/first/)
 s=await api.change({root,revision:s.revision,action:'commit',message:'First commit'});assert.equal(s.changed,0);assert.equal(s.unborn,false)
 await writeFile(join(root,'hello.txt'),'second\n')
 s=await api.read(root);const stale=s.revision
 await writeFile(join(root,'hello.txt'),'third\n')
 await assert.rejects(api.change({root,revision:stale,action:'stage',path:'hello.txt'}),{status:409})
 s=await api.read(root);s=await api.change({root,revision:s.revision,action:'stage',path:'hello.txt'});assert.equal(s.staged,1)
 s=await api.change({root,revision:s.revision,action:'unstage',path:'hello.txt'});assert.equal(s.staged,0)
 await git('branch','feature');s=await api.read(root);s=await api.change({root,revision:s.revision,action:'switch',branch:'feature'});assert.equal(s.branch,'feature')
 await assert.rejects(api.change({root,revision:s.revision,action:'push',confirm:s.head}),/tracking branch/)
})
test('closed workspace remains denied until explicitly reopened, then Git recovers', async t => {
 const {root}=await fixture(t)
 const opened=[]
 const api=createGit({workspaceRegistry:{list:()=>opened}})
 await assert.rejects(api.read(root),{status:403,code:'WORKSPACE_NOT_OPEN'})
 opened.push({path:root})
 assert.equal((await api.read(root)).branch,'main')
 opened.length=0
 await assert.rejects(api.read(root),{status:403,code:'WORKSPACE_NOT_OPEN'})
})
test('Git actions fence nested folders and unknown actions; literal magic filename stages only itself',async t=>{
 const {root,api}=await fixture(t);await mkdir(join(root,'nested'))
 await assert.rejects(api.read(join(root,'nested')),{status:403})
 await assert.rejects(api.change({root,action:'reset'}),{status:400})
 await writeFile(join(root,':(glob)*'),'literal');await writeFile(join(root,'other'),'other')
 let s=await api.read(root);s=await api.change({root,revision:s.revision,action:'stage',path:':(glob)*'})
 assert.equal(s.staged,1);assert.equal(s.untracked,1)
 s=await api.change({root,revision:s.revision,action:'unstage',path:':(glob)*'});assert.equal(s.staged,0);assert.equal(s.untracked,2)
})

test('push sends only the reviewed commit to one local bare remote and refuses multiple destinations', async t => {
 const {root,api,git}=await fixture(t)
 const remote=await realpath(await mkdtemp(join(tmpdir(),'dsh-git-remote-')))
 t.after(()=>rm(remote,{recursive:true,force:true}))
 await exec('git',['init','--bare',remote])
 await writeFile(join(root,'one.txt'),'initial')
 let s=await api.read(root)
 s=await api.change({root,revision:s.revision,action:'stage',path:'one.txt'})
 s=await api.change({root,revision:s.revision,action:'commit',message:'Initial'})
 await git('remote','add','origin',remote)
 await git('push','-u','origin','main')
 await writeFile(join(root,'one.txt'),'updated')
 s=await api.read(root);s=await api.change({root,revision:s.revision,action:'stage',path:'one.txt'})
 s=await api.change({root,revision:s.revision,action:'commit',message:'Updated'})
 await assert.rejects(api.change({root,revision:s.revision,action:'push',confirm:'stale'}),/confirm/)
 const head=s.head
 s=await api.change({root,revision:s.revision,action:'push',confirm:head})
 assert.equal((await exec('git',['--git-dir',remote,'rev-parse','refs/heads/main'])).stdout.trim(),head)
 await git('remote','set-url','--add','--push','origin',remote)
await git('remote','set-url','--add','--push','origin',remote+'-other')
s=await api.read(root);assert.equal(s.push,null);assert.match(s.pushWarning,/multiple/)
})

test('init creates a repository in an opened empty folder and refuses a second init', async t => {
 const root=await realpath(await mkdtemp(join(tmpdir(),'dsh-git-empty-')))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const run=(cmd,args,opts)=>exec(cmd,args,{...opts,env:{...opts.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}})
 const api=createGit({workspaceRegistry:{list:()=>[{path:root}]}},run)
 await assert.rejects(api.read(root),{status:422,code:'NOT_A_GIT_REPOSITORY'})
 const created=await api.change({root,action:'init'})
 assert.equal(created.unborn,true)
 await assert.rejects(api.change({root,action:'init'}),{status:409})
})

test('init stays behind the workspace fence', async t => {
 const {root}=await fixture(t)
 const api=createGit({workspaceRegistry:{list:()=>[]}})
 await assert.rejects(api.change({root,action:'init'}),{status:403,code:'WORKSPACE_NOT_OPEN'})
})

test('a live session cwd is enough to use Git without a workspace record', async t => {
 const {root}=await fixture(t)
 const api=createGit({
  workspaceRegistry:{list:()=>[]},
  sessions:{list:()=>[{header:{cwd:root}}]},
 })
 assert.equal((await api.read(root)).branch,'main')
})
