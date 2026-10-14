'use strict'
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createRequire}=require('node:module');
const {ensureProfile}=require('../src/profile.cjs');

test('the real loader disables the mandatory adapter and mounts the optional adapter',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-provider-composition-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const profile=ensureProfile(home,path.resolve(__dirname,'..'));
 const modules=path.resolve(__dirname,'../../node_modules/.pnpm');
 const installed=fs.readdirSync(modules).find(name=>name.startsWith('@deepseek-ai+cordis-plugin-include@'));
 const packageFile=path.join(modules,installed,'node_modules/@deepseek-ai/cordis-plugin-include/package.json');
 const requireInclude=createRequire(packageFile);
 const {parse}=requireInclude('yaml');
 const {applyEntryPatches}=await import(requireInclude.resolve('@deepseek-ai/cordis-plugin-include'));
 const patches=parse(fs.readFileSync(path.join(profile.dir,'node_modules/@dsh-desktop/profile/desktop.patch.yml'),'utf8'));
 const warnings=[];
 const entries=applyEntryPatches(patches.filter(row=>row.id).map(row=>({id:row.id,name:row.id==='authorization'?'@deepseek-ai/dsh-authorization':row.name||'upstream-placeholder'})),patches,(...args)=>warnings.push(args));
 assert.deepEqual(warnings,[]);
 assert.equal(entries.find(e=>e.id==='llm-deepseek').disabled,true);
 assert.equal(entries.filter(e=>e.name==='@dsh-desktop/host-auth-api/optional-deepseek'&&!e.disabled).length,1);
 assert.equal(entries.filter(e=>e.id==='authorization').length,1);
 assert.equal(entries.find(e=>e.id==='authorization').disabled,true);
 assert.equal(entries.filter(e=>e.name==='@dsh-desktop/auth-allowlist'&&!e.disabled).length,1);
});
