import assert from 'node:assert/strict'
import { test } from 'node:test'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { chatgptSnapshot, pollChatgptUsage } from '../lib/subscription-usage.js'
import { usageSnapshots, forgetUsage, recordSnapshot } from '../lib/usage-observer.js'

const payload = () => ({plan_type:'plus',rate_limit:{primary_window:{used_percent:24,limit_window_seconds:18000,reset_at:2000000000},secondary_window:{used_percent:80,limit_window_seconds:604800,reset_after_seconds:6000}}})
test('ChatGPT maps both genuine windows, plan and absolute reset without copying account identity',()=>{
 const result=chatgptSnapshot({...payload(),account_id:'private-account',user_id:'private-user'});
 assert.equal(result.primary.usedPercent,24);assert.equal(result.primary.windowMinutes,300);
 assert.equal(result.secondary.usedPercent,80);assert.equal(result.secondary.windowMinutes,10080);
 assert.equal(result.primary.resetsAt,2000000000000);assert.equal(result.planType,'plus');
 assert.equal(JSON.stringify(result).includes('private'),false);
});
test('missing and invalid quotas are unknown; secondary-only and extra model windows remain valid',()=>{
 for(const value of [null,{}, {rate_limit:{primary_window:{used_percent:'12'}}},{rate_limit:{primary_window:{used_percent:NaN}}}])assert.equal(chatgptSnapshot(value),null);
 const result=chatgptSnapshot({rate_limit:{secondary_window:{used_percent:0}}});assert.equal(result.primary,undefined);assert.equal(result.secondary.usedPercent,0);
 const extra=chatgptSnapshot({additional_rate_limits:[{limit_name:'Code review',rate_limit:{primary_window:{used_percent:25}}}]});assert.equal(extra.additional[0].name,'Code review');
});
function fixture(t){
 const key=credentialKey('llm-pi-ai','openai-codex');let record={kind:'grant',payload:{access:'fixture-token'}};
 const ctx={authorization:{list:()=>[{key}]},credentials:{readRecord:async()=>record}};
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;forgetUsage('openai-codex')});forgetUsage('openai-codex');
 const authorize=async()=>({apiKey:'fixture-token',headers:{'ChatGPT-Account-Id':'fixture-account'}});
 return {ctx,authorize,replace(value){record=value}};
}
test('poll uses only the fixed read-only origin, with redirects refused, then publishes both windows',async t=>{
 const f=fixture(t);let requests=0;
 globalThis.fetch=async(url,options)=>{requests++;assert.equal(url,'https://chatgpt.com/backend-api/wham/usage');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer fixture-token');assert.equal(options.headers['ChatGPT-Account-Id'],'fixture-account');return Response.json(payload())};
 await pollChatgptUsage(f.ctx,{authorize:f.authorize});assert.equal(requests,1);assert.equal(usageSnapshots()['openai-codex'].secondary.windowMinutes,10080);
});
test('account switch during a poll cannot repopulate the previous account quota',async t=>{
 const f=fixture(t);
 globalThis.fetch=async()=>{f.replace({kind:'grant',payload:{access:'replacement-token'}});forgetUsage('openai-codex');return Response.json(payload())};
 await pollChatgptUsage(f.ctx,{authorize:f.authorize});assert.equal(usageSnapshots()['openai-codex'],undefined);
});
test('failure retains the timestamp of known data and marks it stale rather than resetting a quota',async t=>{
 const f=fixture(t);recordSnapshot('openai-codex',chatgptSnapshot(payload()));const before=usageSnapshots()['openai-codex'].observedAt;
 globalThis.fetch=async()=>new Response('Unavailable',{status:503});await pollChatgptUsage(f.ctx,{authorize:f.authorize});
 const snap=usageSnapshots()['openai-codex'];assert.equal(snap.primary.usedPercent,24);assert.equal(snap.observedAt,before);assert.equal(snap.status,'stale');
});
test('malformed and oversized responses publish unavailable, never an invented zero',async t=>{
 const f=fixture(t);
 for(const response of [Response.json({}),new Response('x'.repeat(140*1024))]){
  forgetUsage('openai-codex');globalThis.fetch=async()=>response;await pollChatgptUsage(f.ctx,{authorize:f.authorize});
  assert.equal(usageSnapshots()['openai-codex'].status,'unavailable');assert.equal(usageSnapshots()['openai-codex'].primary,undefined);
 }
});
test('API-key records and cancellation do not manufacture account limits',async t=>{
 const f=fixture(t);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(payload())};
 f.replace({kind:'api-key',key:'fixture'});await pollChatgptUsage(f.ctx,{authorize:f.authorize});assert.equal(calls,0);
 f.replace({kind:'grant',payload:{access:'fixture-token'}});const controller=new AbortController();controller.abort();await pollChatgptUsage(f.ctx,{authorize:f.authorize,signal:controller.signal});assert.equal(usageSnapshots()['openai-codex'],undefined);
});
