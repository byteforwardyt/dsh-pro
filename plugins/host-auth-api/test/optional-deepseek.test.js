import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Config,apply,wantsNativeDeepSeek} from '../lib/optional-deepseek.js'
function fixture(user={},configured=false){const mounted=[],events={};const settings={configuration:()=>[{entry:{options:{id:'optional-deepseek'}},override:user}]};return {mounted,events,get:()=>settings,credentials:{describe:async()=>({configured})},plugin:(plugin,config)=>mounted.push({plugin,config}),on:(name,fn)=>events[name]=fn,logger:{warn(){}}}}
test('unconfigured DeepSeek is absent, existing keys and custom settings remain',async()=>{
 const config=Config({});const fresh=fixture();assert.equal(await wantsNativeDeepSeek(fresh,config),false);await apply(fresh,config);assert.equal(fresh.mounted.length,0);
 for(const ctx of [fixture({},true),fixture({baseURL:'https://example.test/v1'})]){await apply(ctx,config);assert.equal(ctx.mounted.length,1)}
 const custom=fixture();await apply(custom,Config({baseURL:'https://example.test/v1'}));assert.equal(custom.mounted.length,1);
});
test('metadata updates activate at most once and disposal cancels pending activation',async()=>{
 const ctx=fixture();await apply(ctx,Config({}));ctx.credentials.describe=async()=>({configured:true});await ctx.events['credentials/reference-updated']();await new Promise(r=>setImmediate(r));assert.equal(ctx.mounted.length,1);
 ctx.events['credentials/reference-updated']();assert.equal(ctx.mounted.length,1);
 const stopped=fixture();let finish;stopped.credentials.describe=()=>new Promise(r=>finish=r);const pending=apply(stopped,Config({}));stopped.events.dispose();finish({configured:true});await pending;assert.equal(stopped.mounted.length,0);
});
test('a credential metadata failure preserves the native provider without exposing secrets',async()=>{
 const ctx=fixture();ctx.credentials.describe=async()=>{throw Error('private')};await apply(ctx,Config({}));assert.equal(ctx.mounted.length,1);
});
