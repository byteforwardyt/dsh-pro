import {test} from 'node:test'
import assert from 'node:assert/strict'
import {SettingsConflictError} from '@deepseek-ai/dsh-settings'
import {ensureProviderDeclared,retractProviderIfAuto} from '../lib/declare.js'

function fixture(profile,onWrite=()=>{}) {
  let document={providers:profile===undefined?{}:{xai:profile}},revision=0,writes=0
  const settings={
    configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section:()=>structuredClone(document),
    describe:()=>[{ns:'llm-pi-ai',revision,user:structuredClone(document)}],
    async mutate(ns,ops,expected){
      writes++;await onWrite({edit(next){document={...document,providers:{...document.providers,xai:next}};revision++},unrelated(){document={...document,other:true};revision++}})
      if(expected!==undefined&&expected!==revision)throw new SettingsConflictError(ns,expected,revision)
      for(const op of ops){if(op.op==='set')document.providers.xai=op.value;else delete document.providers.xai}
      revision++
    },
  }
  return {ctx:{get:()=>settings,logger:{warn(){}}},profile:()=>document.providers.xai,writes:()=>writes}
}

test('auto-declaration cannot overwrite a user edit queued after its ownership read',async()=>{
  let once=true;const custom={baseURL:'https://fixture.invalid',displayName:'My server'}
  const app=fixture(undefined,({edit})=>{if(once){once=false;edit(custom)}})
  assert.equal(await ensureProviderDeclared(app.ctx,'xai'),'already')
  assert.deepEqual(app.profile(),custom)
})

test('sign-out retraction preserves a concurrent provider edit',async()=>{
  let once=true;const custom={displayName:'Grok',headers:{'X-Fixture':'custom'}}
  const app=fixture({displayName:'Grok'},({edit})=>{if(once){once=false;edit(custom)}})
  assert.equal(await retractProviderIfAuto(app.ctx,'xai'),'kept')
  assert.deepEqual(app.profile(),custom)
})

test('a custom display name alone makes a provider user-managed',async()=>{
  const app=fixture({displayName:'My Grok'})
  assert.equal(await retractProviderIfAuto(app.ctx,'xai'),'kept')
  assert.equal(app.writes(),0)
})

test('unrelated revisions retry ownership checks before retraction',async()=>{
  let once=true;const app=fixture({displayName:'Grok'},({unrelated})=>{if(once){once=false;unrelated()}})
  assert.equal(await retractProviderIfAuto(app.ctx,'xai'),'retracted')
  assert.equal(app.profile(),undefined);assert.equal(app.writes(),2)
})

test('continuous revision conflicts are bounded and preserve the profile',async()=>{
  const app=fixture({displayName:'Grok'},({unrelated})=>unrelated())
  assert.equal(await retractProviderIfAuto(app.ctx,'xai'),'failed')
  assert.ok(app.writes()<=3);assert.deepEqual(app.profile(),{displayName:'Grok'})
})


test('redacted secret-only profiles are not mistaken for empty auto-owned profiles',async()=>{
  let writes=0
  const ctx={get:()=>({
    configuration(){return [{entry:{options:{id:'llm-pi-ai'}},override:this.section()}]},section:()=>({providers:{xai:{fixtureSecret:'fixture-only-value'}}}),
    describe:()=>[{ns:'llm-pi-ai',revision:1,user:{providers:{xai:{}}}}],
    mutate:async()=>{writes++},
  })}
  assert.equal(await ensureProviderDeclared(ctx,'xai'),'already')
  assert.equal(await retractProviderIfAuto(ctx,'xai'),'kept')
  assert.equal(writes,0)
})
