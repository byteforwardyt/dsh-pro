const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const response=data=>({ok:true,json:async()=>data});
const button=(instance,label)=>instance.find(n=>n.type==='button'&&n.props.children.includes(label));
function summary(input=10) {
  const buckets={input,output:2,cacheRead:30,cacheWrite:4,turns:1};
  const now=new Date(),day=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return {totals:{...buckets,sessions:1,firstAt:now.getTime(),lastAt:now.getTime()},
    models:[{...buckets,provider:'openai-codex',model:'Fixture model'}],days:[{...buckets,day}],hours:Array.from({length:24},(_,i)=>i===now.getHours()?input+36:0)};
}
const tile=(instance,label)=>instance.find(n=>n.props.className==='dshd-us-tile'
  && n.props.children.some(child=>child?.props?.children.includes(label)))?.props.children[0].props.children[0];

test('usage tiles, model proportions, and heatmap include cache traffic',async t=>{
  const client=loadClient('client-ui-usage',async()=>response(summary()));
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.equal(tile(instance,'Tokens total'),'46');assert.equal(tile(instance,'Cache writes'),'4');
  assert.equal(tile(instance,'Reported call'),'1');assert.equal(tile(instance,'Uncached input'),'10');
  const split=instance.find(n=>n.props.className==='dshd-us-split');
  assert.equal(split.props.children.length,4);
  assert.ok(Math.abs(split.props.children.reduce((n,child)=>n+parseFloat(child.props.style.width),0)-100)<1e-10);
  const heat=instance.find(n=>n.type?.name==='HeatMap');
  const calendar=await client.mount(heat.props,heat.type).flush();t.after(()=>calendar.unmount());
  assert.ok(calendar.find(n=>n.props.title?.endsWith('46 tokens')));
});

test('usage retries an initial failure and preserves the last successful read during later failures',async t=>{
  let mode='fail';
  const client=loadClient('client-ui-usage',async()=>mode==='fail'?{ok:false,status:503}:response(summary(mode==='updated'?20:10)));
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.ok(instance.find(n=>n.props.role==='alert'));assert.equal(tile(instance,'Tokens total'),undefined);
  mode='success';button(instance,'Retry').props.onClick();await instance.flush();assert.equal(tile(instance,'Tokens total'),'46');
  mode='fail';button(instance,'Refresh').props.onClick();await instance.flush();
  assert.equal(tile(instance,'Tokens total'),'46');assert.ok(instance.find(n=>n.props.role==='alert'));
  mode='updated';button(instance,'Retry').props.onClick();await instance.flush();
  assert.equal(tile(instance,'Tokens total'),'56');assert.equal(instance.find(n=>n.props.role==='alert'),undefined);
});

test('malformed usage is reported as a read failure rather than zero usage or a render error',async t=>{
  for(const data of [{totals:null},{...summary(),models:{}},{...summary(),hours:[NaN]}]) {
    const client=loadClient('client-ui-usage',async()=>response(data));
    const instance=await client.mount().flush();t.after(()=>instance.unmount());
    assert.ok(button(instance,'Retry'));assert.ok(instance.find(n=>n.props.role==='alert'));
    assert.equal(tile(instance,'Tokens total'),undefined);
  }
});

test('unmount aborts usage reads and an obsolete refresh cannot replace a newer response',async t=>{
  const requests=[];
  const client=loadClient('client-ui-usage',(_,init)=>new Promise(resolve=>requests.push({resolve,signal:init.signal})));
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  const reload=button(instance,'Refreshing…').props.onClick;
  reload();await instance.flush();assert.equal(requests[0].signal.aborted,true);
  requests[1].resolve(response(summary(20)));await instance.flush();assert.equal(tile(instance,'Tokens total'),'56');
  requests[0].resolve(response(summary(10)));await instance.flush();assert.equal(tile(instance,'Tokens total'),'56');
  button(instance,'Refresh').props.onClick();await instance.flush();instance.unmount();
  assert.equal(requests[2].signal.aborted,true);
});

test('partial history is identified beside confirmed totals and clears after a successful complete refresh',async t=>{
  const coverage={complete:false,read:1,partial:1,skipped:1,unavailable:0,
    issues:{oversized:1,unreadable:0,corrupt:0,truncated:1,ambiguous:0,invalidUsage:0}};
  let partial=true;
  const complete={complete:true,read:3,partial:0,skipped:0,unavailable:0,
    issues:{oversized:0,unreadable:0,corrupt:0,truncated:0,ambiguous:0,invalidUsage:0}};
  const client=loadClient('client-ui-usage',async()=>response({...summary(),coverage:partial?coverage:complete}));
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.equal(tile(instance,'Tokens total'),'46');
  assert.ok(instance.find(n=>n.type==='b'&&n.props.children.includes('Partial session history')));
  partial=false;button(instance,'Refresh').props.onClick();await instance.flush();
  assert.equal(instance.find(n=>n.type==='b'&&n.props.children.includes('Partial session history')),undefined);
});

test('zero confirmed usage with missing history is not presented as an ordinary empty history',async t=>{
  const data=summary();data.totals={input:0,output:0,cacheRead:0,cacheWrite:0,turns:0,sessions:0};data.models=[];data.days=[];
  data.coverage={complete:false,read:0,partial:0,skipped:1,unavailable:0,
    issues:{oversized:0,unreadable:0,corrupt:1,truncated:0,ambiguous:0,invalidUsage:0}};
  const client=loadClient('client-ui-usage',async()=>response(data));
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.ok(instance.find(n=>n.props.children.includes('No confirmed usage could be read from this incomplete history.')));
  assert.ok(instance.find(n=>n.type==='b'&&n.props.children.includes('Partial session history')));
});

test('a complete history with nothing in it says so rather than drawing empty charts',async t=>{
  const data=summary();data.totals={input:0,output:0,cacheRead:0,cacheWrite:0,turns:0,sessions:0};data.models=[];data.days=[];
  data.coverage={complete:true,read:0,partial:0,skipped:0,unavailable:0,
    issues:{oversized:0,unreadable:0,corrupt:0,truncated:0,ambiguous:0,invalidUsage:0}};
  const client=loadClient('client-ui-usage',async()=>response(data));
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.ok(instance.find(n=>n.props.children.includes('No usage reported yet')));
  assert.equal(tile(instance,'Tokens total'),undefined);
});

test('model filtering preserves full provider and daily totals, including zero-token calls',async t=>{
 const data=summary(0);data.totals={...data.totals,input:0,output:0,cacheRead:0,cacheWrite:0};
 data.models=[{provider:'one',model:'Alpha',input:0,output:0,cacheRead:0,cacheWrite:0,turns:1}];
 const client=loadClient('client-ui-usage',async()=>response(data));const view=await client.mount().flush();t.after(()=>view.unmount());
 assert.equal(view.find(n=>n.props.className==='tot').props.children[0],'0 · 0.0%');
 const nodes=n=>n&&typeof n==='object'?[n,...(n.props?.children||[]).flatMap(nodes)]:[];
 const tables=()=>nodes(view.tree).filter(n=>n.type==='table');
 assert.equal(tables().length,2);
 view.find(n=>n.props['aria-label']==='Filter models').props.onChange({target:{value:'absent'}});await view.flush();
 assert.equal(view.find(n=>n.props.className==='dshd-us-row'),undefined);
 assert.equal(tables().length,2);assert.equal(tile(view,'Reported call'),'1');
});

test('usage is available in Settings without registering a sidebar card',async t=>{
  const client=loadClient('client-ui-usage',async()=>response(summary()));
  assert.deepEqual(client.registrations.map(({meta})=>meta.name),['settings.section']);
  assert.equal(client.registrations[0].meta.id,'usage');
  const instance=await client.mount().flush();t.after(()=>instance.unmount());
  assert.equal(tile(instance,'Tokens total'),'46');
  assert.ok(instance.find(n=>n.type?.name==='AccountUsage'));
});
