const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...(tree.props?.children||[]).flatMap(nodes)];
const button=(instance,label)=>instance.find(n=>n.type==='button'&&(n.props.children.includes(label)||n.props['aria-label']===label));
const reviews=instance=>nodes(instance.tree).filter(n=>n.props['aria-label']?.startsWith('Review draft: '));
const records=count=>Array.from({length:count},(_,i)=>({path:'/workspace/draft-'+String(i).padStart(4,'0')+'.txt',root:'/workspace',revision:'r'+i,updatedAt:'2026-09-07T00:00:00Z',bytes:12}));
async function fixture(){
  const streams=[],opened=[];
  const client=loadClient('client-ui-files',async(url,init)=>{
    if(url.endsWith('/roots'))return {ok:true,json:async()=>({roots:[{path:'/workspace'}]})};
    if(url.includes('/list?'))return {ok:true,json:async()=>({entries:[]})};
    if(url.endsWith('/drafts/stream')){
      let source;const body=new ReadableStream({start(controller){source=controller;init.signal.addEventListener('abort',()=>controller.error(new DOMException('Aborted','AbortError')),{once:true});}});
      streams.push({signal:init.signal,send(batch){source.enqueue(new TextEncoder().encode(JSON.stringify(batch)+'\n'))},end(){source.close()}});
      return new Response(body);
    }
    const path=new URL(url,'http://fixture').searchParams.get('path');
    if(url.includes('/draft?'))return {ok:true,json:async()=>({draft:{path,text:'Saved '+path,base:{text:'Original',version:'1'},revision:'r'}})};
    if(url.includes('/read?'))return {ok:true,json:async()=>({kind:'text',text:'Original',version:'1'})};
    throw Error(url);
  });
  const parent=await client.mount().flush();button(parent,'Recover drafts').props.onClick();await parent.flush();
  const node=parent.find(n=>n.type?.name==='RecoveryPanel');
  let props={...node.props,onOpen:record=>opened.push(record)};
  const panel=await client.mount(props,node.type).flush();
  return {panel,streams,opened,async active(active){props={...props,active};await panel.setProps(props).flush()},close(){panel.unmount();parent.unmount()}};
}

test('recovery shows streamed progress and pages a large inventory without hiding matches',async t=>{
  const f=await fixture();t.after(f.close);const all=records(125);
  f.streams[0].send({drafts:all.slice(0,25),scanned:25,unreadable:0,done:false});await f.panel.flush();
  assert.equal(reviews(f.panel).length,25);assert.ok(button(f.panel,'Stop scanning'));
  f.streams[0].send({drafts:all.slice(25),scanned:125,unreadable:0,done:true});f.streams[0].end();await f.panel.flush();
  assert.equal(reviews(f.panel).length,50);assert.equal(button(f.panel,'Stop scanning'),undefined);
  button(f.panel,'Next drafts').props.onClick();await f.panel.flush();assert.equal(reviews(f.panel).length,50);
  button(f.panel,'Next drafts').props.onClick();await f.panel.flush();assert.equal(reviews(f.panel).length,25);
  f.panel.find(n=>n.props['aria-label']==='Find a saved draft').props.onChange({target:{value:'draft-0124'}});await f.panel.flush();
  assert.equal(reviews(f.panel).length,1);
  await reviews(f.panel)[0].props.onClick();await f.panel.flush();
  assert.ok(f.panel.find(n=>n.props['aria-label']==='Saved draft contents').props.value.endsWith('draft-0124.txt'));
  await button(f.panel,'Open draft in editor').props.onClick();await f.panel.flush();
  assert.equal(f.opened[0].path,all[124].path);assert.equal(f.opened[0].base.version,'1');
});

test('stopping preserves partial results and refresh starts a clean scan',async t=>{
  const f=await fixture();t.after(f.close);
  f.streams[0].send({drafts:records(2),scanned:2,unreadable:1,done:false});await f.panel.flush();
  button(f.panel,'Stop scanning').props.onClick();await f.panel.flush();
  assert.equal(f.streams[0].signal.aborted,true);assert.equal(reviews(f.panel).length,2);
  assert.ok(f.panel.find(n=>n.props.role==='alert'&&n.props.children.some(c=>String(c).includes('Scan stopped'))));
  button(f.panel,'Refresh drafts').props.onClick();await f.panel.flush();assert.equal(reviews(f.panel).length,0);
  f.streams[1].send({drafts:[],scanned:0,unreadable:0,done:true});f.streams[1].end();await f.panel.flush();
  assert.ok(f.panel.find(n=>n.props.children.includes('No saved drafts in your available workspaces.')));
});

test('truncated scans keep loaded records and report an incomplete inventory',async t=>{
  const f=await fixture();t.after(f.close);
  f.streams[0].send({drafts:records(3),scanned:3,unreadable:0,done:false});f.streams[0].end();await f.panel.flush();
  assert.equal(reviews(f.panel).length,3);assert.ok(f.panel.find(n=>n.props.role==='alert'));
  assert.equal(f.panel.find(n=>n.props.children.includes('No saved drafts in your available workspaces.')),undefined);
});

test('leaving recovery aborts its scan and reactivation does not retain old inventory',async t=>{
  const f=await fixture();t.after(f.close);
  f.streams[0].send({drafts:records(2),scanned:2,unreadable:0,done:false});await f.panel.flush();
  await f.active(false);assert.equal(f.streams[0].signal.aborted,true);
  await f.active(true);assert.equal(reviews(f.panel).length,0);
  f.streams[1].send({drafts:records(1),scanned:1,unreadable:0,done:true});f.streams[1].end();await f.panel.flush();
  assert.equal(reviews(f.panel).length,1);assert.equal(f.panel.find(n=>n.props.role==='alert'),undefined);
});

test('malformed metadata reports a scan error without crashing the recovery list',async t=>{
  const f=await fixture();t.after(f.close);
  f.streams[0].send({drafts:records(2),scanned:2,unreadable:0,done:false});await f.panel.flush();
  f.streams[0].send({drafts:[{path:null}],scanned:3,unreadable:0,done:true});await f.panel.flush();
  assert.equal(reviews(f.panel).length,2);assert.ok(f.panel.find(n=>n.props.role==='alert'));
});
