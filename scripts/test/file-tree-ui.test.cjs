const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const response=payload=>({ok:true,json:async()=>payload});
const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...(tree.props?.children||[]).flatMap(nodes)];
const entries=(count,parent='/workspace')=>Array.from({length:count},(_,i)=>({path:parent+'/entry-'+String(i).padStart(5,'0')+'.txt',name:'entry-'+String(i).padStart(5,'0')+'.txt',type:'file'}));
async function fixture(dirs,selected=null,options={}){
  const client=loadClient('client-ui-files',async url=>{
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Fixture'}]});
    if(url.includes('/list?'))return response({entries:[]});
    throw Error(url);
  },options);
  const parent=await client.mount().flush();
  const component=parent.find(n=>n.type?.name==='TreeLevel');
  const opened=[],toggled=[];
  let props={...component.props,dirs,selected,dirtyPaths:new Set(),onOpen:entry=>opened.push(entry.path),onToggle:path=>toggled.push(path)};
  const tree=await client.mount(props,component.type).flush();
  const f={tree,opened,toggled,
    rows:()=>nodes(tree.tree).filter(n=>n.props.role==='treeitem'),
    active:()=>nodes(tree.tree).find(n=>n.props.id===tree.tree.props['aria-activedescendant']),
    async update(next){props={...props,...next};await tree.setProps(props).flush()},
    async key(key,extra={}){let stopped=false;tree.tree.props.onKeyDown({key,preventDefault(){stopped=true},stopPropagation(){},...extra});await tree.flush();return stopped},
    close(){tree.unmount();parent.unmount()}};
  return f;
}

test('large explorer windows DOM rows while every entry remains keyboard reachable',async t=>{
  const files=entries(10000),f=await fixture({'/workspace':files});t.after(f.close);
  assert.ok(f.rows().length<50);assert.equal(f.active().props.title,'entry-00000.txt');
  assert.equal(f.tree.tree.props.tabIndex,0);assert.ok(f.rows().every(row=>row.props.tabIndex===-1));
  await f.key('End');assert.equal(f.active().props.title,'entry-09999.txt');assert.ok(f.rows().length<50);
  assert.equal(f.active().props['aria-posinset'],10000);assert.equal(f.active().props['aria-setsize'],10000);
  await f.key('Enter');assert.deepEqual(f.opened,['/workspace/entry-09999.txt']);
  await f.key('Home');await f.key('PageDown');assert.equal(f.active().props.title,'entry-00021.txt');
  await f.key('PageUp');assert.equal(f.active().props.title,'entry-00000.txt');
});

test('tree arrows expand, enter and collapse nested folders without opening files on focus',async t=>{
  const folder={name:'src',path:'/workspace/src',type:'directory'};
  const dirs={'/workspace':[folder,...entries(2)],'/workspace/src':entries(3,'/workspace/src')};
  const f=await fixture(dirs);t.after(f.close);
  await f.key('ArrowRight');assert.deepEqual(f.toggled,[folder.path]);assert.equal(f.opened.length,0);
  await f.update({open:new Set([folder.path])});await f.key('ArrowRight');
  assert.equal(f.active().props['aria-level'],2);assert.equal(f.active().props['aria-setsize'],3);
  await f.key('ArrowDown');assert.equal(f.active().props.title,'entry-00001.txt');assert.equal(f.opened.length,0);
  await f.key('ArrowLeft');assert.equal(f.active().props.title,'src');
  await f.key('ArrowLeft');assert.deepEqual(f.toggled,[folder.path,folder.path]);
});

test('external selection reveals an offscreen file and dirty markers survive windowing',async t=>{
  const files=entries(5000),f=await fixture({'/workspace':files});t.after(f.close);
  const selected=files[4200].path;
  await f.update({selected,dirtyPaths:new Set([selected])});
  assert.equal(f.active().props.title,files[4200].name);assert.equal(f.active().props['aria-selected'],'true');
  assert.ok(nodes(f.active()).some(n=>n.props.title==='Unsaved changes'));
  await f.key('Home');await f.update({selected:files[4999].path});
  assert.equal(f.active().props.title,files[4999].name);assert.ok(f.rows().length<50);
});

test('refresh and collapse keep a valid active descendant when a focused file disappears',async t=>{
  const folder={name:'src',path:'/workspace/src',type:'directory'},files=entries(2,folder.path);
  const f=await fixture({'/workspace':[folder],'/workspace/src':files});t.after(f.close);
  await f.update({open:new Set([folder.path]),selected:files[1].path});assert.equal(f.active().props.title,files[1].name);
  await f.update({dirs:{'/workspace':[folder],'/workspace/src':[]}});assert.equal(f.active().props.title,'src');
  await f.update({open:new Set()});assert.equal(f.active().props['aria-expanded'],'false');
  await f.update({dirs:{'/workspace':[]}});assert.equal(f.tree.tree.props['aria-activedescendant'],undefined);
  assert.ok(nodes(f.tree.tree).some(n=>n.props.title==='Empty'));
});

test('loading and failed branches expose status and do not trap keyboard navigation',async t=>{
  const folder={name:'src',path:'/workspace/src',type:'directory'},files=entries(2);
  const f=await fixture({'/workspace':[folder,...files]});t.after(f.close);
  await f.update({open:new Set([folder.path])});assert.ok(nodes(f.tree.tree).some(n=>n.props.title==='Loading…'));
  await f.key('ArrowDown');assert.equal(f.active().props.title,files[0].name);
  await f.update({dirs:{'/workspace':[folder,...files],'/workspace/src':null}});
  assert.ok(nodes(f.tree.tree).some(n=>n.props.title==='Unable to load. Use Refresh to retry.'));
  await f.key('Home');await f.key('End');assert.equal(f.active().props.title,files[1].name);
});

test('typeahead finds names and modified shortcuts remain available to Files',async t=>{
  const files=['alpha.txt','apple.txt','zebra.txt'].map(name=>({name,path:'/workspace/'+name,type:'file'}));
  const f=await fixture({'/workspace':files});t.after(f.close);
  await f.key('a');assert.equal(f.active().props.title,'apple.txt');
  await f.key('a');assert.equal(f.active().props.title,'alpha.txt');
  await f.key('Home');await f.key('z');assert.equal(f.active().props.title,'zebra.txt');
  assert.equal(await f.key('p',{metaKey:true}),false);assert.equal(await f.key('Escape'),false);
});

test('scrolling mounts only the viewport plus the active descendant',async t=>{
  const f=await fixture({'/workspace':entries(10000)});t.after(f.close);
  const box=f.tree.tree.props.ref.current;box.scrollTop=32000;f.tree.tree.props.onScroll();await f.tree.flush();
  assert.ok(f.rows().some(row=>row.props.title==='entry-01000.txt'));
  assert.equal(f.active().props.title,'entry-00000.txt');assert.ok(f.rows().length<50);
});

test('late directory responses cannot replace a newer refresh',async t=>{
  const pending=[];
  const client=loadClient('client-ui-files',async url=>{
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Fixture'}]});
    if(url.includes('/list?'))return new Promise(resolve=>pending.push(resolve));
    throw Error(url);
  });
  const parent=await client.mount().flush();t.after(()=>parent.unmount());
  assert.equal(pending.length,1);
  parent.find(n=>n.type==='button'&&n.props.children.includes('Refresh')).props.onClick();await parent.flush();
  assert.equal(pending.length,2);
  pending[1](response({entries:[{name:'new.txt',path:'/workspace/new.txt',type:'file'}]}));await parent.flush();
  pending[0](response({entries:[{name:'old.txt',path:'/workspace/old.txt',type:'file'}]}));await parent.flush();
  assert.equal(parent.find(n=>n.type?.name==='TreeLevel').props.dirs['/workspace'][0].name,'new.txt');
});

test('resizing the explorer keeps its active row visible',async t=>{
  let resize;
  const f=await fixture({'/workspace':entries(10000)},null,{globals:{ResizeObserver:class {constructor(fn){resize=fn}observe(){}disconnect(){}}}});
  t.after(f.close);await f.key('End');
  const box=f.tree.tree.props.ref.current;box.clientHeight=100;box.scrollTop=319306;resize();
  assert.equal(box.scrollTop,319906);
  await f.tree.flush();assert.equal(f.active().props.title,'entry-09999.txt');assert.ok(f.rows().length<20);
});

test('a previous workspace listing failure cannot change the current tree or error banner',async t=>{
  let failOld;
  const client=loadClient('client-ui-files',async url=>{
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'First'},{path:'/second',title:'Second'}]});
    if(url.includes('/list?'))return new URL(url,'http://fixture').searchParams.get('path')==='/workspace'
      ?new Promise(resolve=>{failOld=resolve}):response({entries:[{name:'current.txt',path:'/second/current.txt',type:'file'}]});
    throw Error(url);
  });
  const parent=await client.mount().flush();t.after(()=>parent.unmount());
  parent.find(n=>n.type==='select'&&n.props['aria-label']==='Workspace').props.onChange({target:{value:'/second'}});await parent.flush();
  failOld({ok:false,status:500,json:async()=>({error:'old workspace unavailable'})});await parent.flush();
  const props=parent.find(n=>n.type?.name==='TreeLevel').props;
  assert.equal(props.path,'/second');assert.equal(props.dirs['/workspace'],undefined);
  assert.equal(props.dirs['/second'][0].name,'current.txt');
  assert.equal(nodes(parent.tree).some(n=>n.props.children.some(child=>typeof child==='string'&&child.includes('old workspace unavailable'))),false);
});

test('explicit reveal returns to the selected file even when selection itself is unchanged',async t=>{
  const files=entries(5000),f=await fixture({'/workspace':files},files[4200].path);t.after(f.close);
  await f.key('Home');assert.equal(f.active().props.title,files[0].name);
  await f.update({revealRequest:{path:files[4200].path}});assert.equal(f.active().props.title,files[4200].name);
});
