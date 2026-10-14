const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const shellRequire=createRequire(require('node:path').resolve(__dirname,'../../shell/package.json'));
const harness=createRequire(shellRequire.resolve('@deepseek-ai/dsh/package.json'));

async function fixture(t, storageRoot){
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=storageRoot||fs.mkdtempSync(path.join(os.tmpdir(),'dsh-schedules-test-'));
  if(!storageRoot)t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const toolsPath=harness.resolve('@deepseek-ai/dsh-tools');
  const {Context}=await import(createRequire(toolsPath).resolve('@deepseek-ai/cordis'));
  const {ToolRuntime}=await import(toolsPath);
  const {registerScheduleTools,ScheduleService}=await import(harness.resolve('@deepseek-ai/dsh-schedule'));
  const {Storage}=await import(harness.resolve('@deepseek-ai/dsh-storage'));
  const {JsonStorageBackend}=await import(harness.resolve('@deepseek-ai/dsh-storage-json'));
  const {DomainFacility}=await import(harness.resolve('@deepseek-ai/dsh-storage-domain'));
  const {createSchedules}=await import('../../plugins/client-ui-workspace-tools/lib/schedules.js');
  const ctx=new Context();ctx.systemPrompt={tools:()=>()=>{},section:()=>()=>{}};
  const tools=new ToolRuntime(ctx,{mode:'native'});
  const events=[];
  const agent={id:'fixture-session',ctx,session:{id:'fixture-session',header:{id:'fixture-session',seedLength:0},events,
    append(type,data){events.push({seq:events.length,type,data,time:Date.now()});}}};
  let live=true, flushes=0;
  const context={tools,agents:{get:()=>live?agent:undefined},sessions:{flush:async()=>{flushes++;return true}},logger:{warn(){}},
    sessionQuery:{listSessions:async()=>[{header:{id:agent.id,cwd:'/workspace/fixture'}}],
      readTitleSnapshots:async()=>[{status:'fulfilled',value:{title:{title:'Schedule fixture'}}}]},
    sessionPersistence:{inspect:async()=>({meta:agent.session.header,events})}};
  new Storage(ctx);const backend=new JsonStorageBackend(root);ctx.storage.backend.register('json',backend);
  ctx.storageDomain=new DomainFacility(ctx,{backend:'json'});ctx.agents={roots:()=>[]};ctx.sessions={};ctx.sessionController={};ctx.sessionPersistence={};
  context.schedule=new ScheduleService(ctx,{});
  const unregister=registerScheduleTools(context,{tools},agent);
  const close=async()=>{unregister();await ctx.fiber.dispose();await backend.close();};
  t.after(close);
  return {ctx,tools,agent,events,context,root,close,api:createSchedules(context),flushes:()=>flushes,setLive:value=>{live=value}};
}
const signal=()=>new AbortController().signal;
const create={operation:'create',session:'fixture-session',kind:'every',minutes:60,prompt:'Check tests'};

test('Scheduled creates and removes real durable harness reminders through the tool pipeline',async t=>{
  const f=await fixture(t);
  assert.equal((await f.api.sessions(signal())).sessions[0].title,'Schedule fixture');
  const first=await f.api.change(create,signal());
  assert.equal(first.kind,'every');assert.equal(first.everySeconds,3600);
  assert.equal(first.deliveryMode,'host');assert.equal(f.flushes(),0,'new reminders persist in the host storage domain, not session events');
  assert.equal((await f.api.list(f.agent.id,signal())).items[0].id,first.id);
  await f.api.change({operation:'delete',session:f.agent.id,id:first.id},signal());
  assert.equal((await f.api.list(f.agent.id,signal())).items.length,0);
  const second=await f.api.change({...create,kind:'after',minutes:2},signal());
  assert.notEqual(second.id,first.id);assert.equal(second.afterSeconds,120);
  await f.close();const reopened=await fixture(t,f.root);
  assert.equal((await reopened.api.list(reopened.agent.id,signal())).items[0].id,second.id);
});
test('schedule policy denials and cancellation never bypass guards or append work',async t=>{
  const f=await fixture(t);
  const deny=f.ctx.on('tools/pre-execute',()=>({kind:'deny',reason:'Fixture policy refusal'}));
  await assert.rejects(f.api.change(create,signal()),/Fixture policy refusal/);
  assert.equal(f.events.length,0);deny();
  const cancel=new AbortController();cancel.abort();
  await assert.rejects(f.api.change(create,cancel.signal));assert.equal(f.events.length,0);
});
test('schedule validation rejects unknown sessions, fast repetition and empty tasks',async t=>{
  const f=await fixture(t);
  for(const body of [{...create,session:'unknown'},{...create,minutes:1},{...create,minutes:1.5},{...create,prompt:' '},{...create,prompt:'x'.repeat(8001)}]){
    await assert.rejects(f.api.change(body,signal()));
  }
  assert.equal(f.events.length,0);
  f.setLive(false);
  await assert.rejects(f.api.change(create,signal()),/Open this conversation/);
});
test('saved schedules can be inspected while inactive without resuming a conversation',async t=>{
  const f=await fixture(t);await f.api.change(create,signal());f.setLive(false);
  const result=await f.api.list(f.agent.id,signal());
  assert.equal(result.items.length,1);assert.equal(result.live,false);assert.equal(result.manageable,false);
  f.agent.session.header.seedLength=f.events.length;
  assert.equal((await f.context.schedule.list({sessionId:'fork-fixture'})).length,0,'forked reminders belong to their source conversation');
});
test('a storage failure is reported rather than retried into duplicate schedules',async t=>{
  const f=await fixture(t);let attempts=0;
  const domain=await f.context.schedule.ready;const tasks=domain.table('tasks');
  tasks.put=async()=>{attempts++;throw new Error('fixture storage write failed');};
  await assert.rejects(f.api.change(create,signal()),/fixture storage write failed|failed|error/i);
  assert.equal(attempts,1);assert.equal(f.events.length,0);
  assert.equal((await f.api.list(f.agent.id,signal())).items.length,0);
});

test('the registered schedule HTTP route enforces trust and persists Unicode tasks',async t=>{
  const f=await fixture(t);
  const {apply}=await import('../../plugins/client-ui-workspace-tools/lib/index.js');
  const {createServer}=require('node:http');const {once}=require('node:events');
  let handler, cleanup, mounted=false;
  apply({...f.context,plugin(plugin){mounted=plugin.name==='schedule'},webServer:{register(config){handler=config.handler;return()=>{}}},on(_event,fn){cleanup=fn}});
  assert.equal(mounted,false,'the managed profile owns the one upstream schedule service');
  const server=createServer((req,res)=>handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{cleanup();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/dsh-workspace/schedules`;
  assert.equal((await fetch(url+'?session=fixture-session',{headers:{origin:'https://untrusted.example','sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'oops'})).status,400);
  const saved=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...create,prompt:'Résumé — 检查测试'})});
  assert.equal(saved.status,200);assert.equal((await saved.json()).prompt,'Résumé — 检查测试');
  assert.equal((await (await fetch(url+'?session=fixture-session')).json()).items.length,1);
});
