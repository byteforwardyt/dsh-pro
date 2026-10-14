const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const now=2000000000000;
const usage={observedAt:now,primary:{usedPercent:20,windowMinutes:300,resetAfterSeconds:3600},secondary:{usedPercent:90,windowMinutes:10080,resetsAt:now+86400000}};
function setup(){let module;const streams=[];const client=loadClient('client-ui-accounts',async()=>({ok:false}),{onModule:value=>module=value,globals:{EventSource:class{constructor(){streams.push(this)}close(){}},setInterval(){return 1},clearInterval(){},setTimeout(){return 1},clearTimeout(){}}});return{client,module,streams};}
test('quota windows show remaining allowance and reset time for both five-hour and weekly limits',async t=>{
 const {client,module}=setup();const view=await client.mount({usage,now},module.UsageBar).flush();t.after(()=>view.unmount());
 assert.equal(view.find(n=>n.props['aria-label']==='5 hours remaining').props['aria-valuenow'],80);
 assert.equal(view.find(n=>n.props['aria-label']==='Weekly remaining').props['aria-valuenow'],10);
 assert.ok(view.find(n=>n.type==='small'&&n.props.children.includes('Resets in 1h 0m')));
});
test('expired and missing windows cannot read as a fresh full allowance',async t=>{
 const {client,module}=setup();const view=await client.mount({usage,now:now+86400001},module.UsageBar).flush();t.after(()=>view.unmount());assert.equal(view.find(n=>n.props.role==='progressbar'),undefined);
 assert.ok(view.find(n=>n.props.children.includes('Reset passed · waiting for refresh')));
 assert.equal(module.quotaRows({primary:{usedPercent:null}},now).length,0);
});
test('account usage handles connect, sign-out and unavailable quotas through the real state stream',async t=>{
 const {client,module,streams}=setup();const view=await client.mount({compact:true},module.AccountUsage).flush();t.after(()=>view.unmount());
 streams[0].onmessage({data:JSON.stringify({type:'state',revision:1,accounts:[{key:'codex',provider:'openai-codex',methods:[],configured:true,usage}],live:[]})});await view.flush();
 assert.ok(view.find(n=>n.props['data-dshd-provider']==='openai-codex'));
 assert.ok(view.find(n=>n.type===module.UsageBar));
 streams[0].onmessage({data:JSON.stringify({type:'state',revision:2,accounts:[],live:[]})});await view.flush();assert.equal(view.find(n=>n.type===module.UsageBar),undefined);
 assert.ok(view.find(n=>n.props.children.includes('Connect an account in Settings to see plan limits.')));
});
test('the compact card lists only the accounts that can report a quota',async t=>{
 const {client,module,streams}=setup();const view=await client.mount({compact:true},module.AccountUsage).flush();t.after(()=>view.unmount());
 streams[0].onmessage({data:JSON.stringify({type:'state',revision:1,live:[],accounts:[
  {key:'codex',provider:'openai-codex',methods:[],configured:true,usage},
  {key:'grok',provider:'xai',methods:[],configured:true,usage:{observedAt:now}}]})});await view.flush();
 assert.ok(view.find(n=>n.props['data-dshd-provider']==='openai-codex'));
 assert.equal(view.find(n=>n.props['data-dshd-provider']==='xai'),undefined);
 assert.equal(view.find(n=>n.props.children.includes('Limits not reported by this provider')),undefined);
});
test('a compact card renders nothing when no connected account reports limits, while the settings inventory still says so',async t=>{
 const {client,module,streams}=setup();
 const silent=JSON.stringify({type:'state',revision:1,live:[],accounts:[{key:'grok',provider:'xai',methods:[],configured:true,usage:{observedAt:now}}]});
 const view=await client.mount({compact:true},module.AccountUsage).flush();t.after(()=>view.unmount());
 streams[0].onmessage({data:silent});await view.flush();
 assert.equal(view.tree,null,'an empty compact card must not leave a container behind');
 const inventory=await client.mount({},module.AccountUsage).flush();t.after(()=>inventory.unmount());
 streams[1].onmessage({data:silent});await inventory.flush();
 assert.ok(inventory.find(n=>n.props.children.includes('Limits not reported by this provider')));
});
