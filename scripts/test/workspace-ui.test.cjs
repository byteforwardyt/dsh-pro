const {test} = require('node:test');
const assert = require('node:assert/strict');
const {loadClient} = require('./helpers/client-harness.cjs');
const response = payload => ({ok:true,json:async()=>payload});
const view = instance => instance.find(n=>n.type?.name==='Viewer').props;
const tree = instance => instance.find(n=>n.type?.name==='TreeLevel').props;
const button = (instance,text) => instance.find(n=>n.type==='button' && (n.props.children.includes(text) || n.props['aria-label']===text));
function fixture() {
  const calls=[];let write;
  const client=loadClient('client-ui-files',async (url,init)=>{
    calls.push(url);
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Test'}]});
    if(url.includes('/list?'))return response({entries:[]});
    if(url.includes('/read?'))return response({kind:'text',path:decodeURIComponent(url.split('path=')[1]),text:'Original',version:'1'});
    if(url.endsWith('/write'))return new Promise(resolve=>{write={resolve,body:JSON.parse(init.body)}});
    throw Error(url);
  });
  return {client,calls,get write(){return write}};
}
test('unsaved file drafts survive Files unmounting for another app view',async()=>{
  const f=fixture();const first=await f.client.mount().flush();
  await tree(first).onOpen({path:'/workspace/notes.txt'});await first.flush();
  view(first).onDraft('Keep these edits');await first.flush();first.unmount();
  const second=await f.client.mount().flush();
  assert.equal(view(second).draft,'Keep these edits');assert.equal(tree(second).dirtyPaths.size,1);second.unmount();
});
test('a save is serialized and retains keystrokes and its new version across unmount',async()=>{
  const f=fixture();const first=await f.client.mount().flush();
  await tree(first).onOpen({path:'/workspace/notes.txt'});await first.flush();
  view(first).onDraft('First edit');await first.flush();
  button(first,'Save changes').props.onClick();
  first.tree.props.onKeyDown({metaKey:true,key:'s',preventDefault(){},stopPropagation(){}});
  assert.equal(f.calls.filter(x=>x.endsWith('/write')).length,1);
  view(first).onDraft('Typed during save');await first.flush();first.unmount();
  const second=await f.client.mount().flush();f.write.resolve(response({version:'2',operation:'replace'}));await second.flush();
  assert.equal(view(second).draft,'Typed during save');assert.equal(view(second).doc.text,'First edit');assert.equal(view(second).doc.version,'2');
  button(second,'Save changes').props.onClick();assert.equal(f.write.body.version,'2');
  f.write.resolve(response({version:'3',operation:'replace'}));await second.flush();second.unmount();
});
test('tree refresh reloads expanded folders instead of leaving them loading forever',async()=>{
  const f=fixture();const instance=await f.client.mount().flush();
  tree(instance).onToggle('/workspace/nested');await instance.flush();
  const start=f.calls.length;button(instance,'Refresh').props.onClick();await instance.flush();
  assert.ok(f.calls.slice(start).some(x=>x.includes(encodeURIComponent('/workspace/nested'))));
  assert.ok(Array.isArray(tree(instance).dirs['/workspace/nested']));instance.unmount();
});
test('a late save conflict cannot offer overwrite controls for a different file',async()=>{
  const f=fixture();const instance=await f.client.mount().flush();
  await tree(instance).onOpen({path:'/workspace/a.txt'});await instance.flush();view(instance).onDraft('edit');await instance.flush();
  button(instance,'Save changes').props.onClick();await tree(instance).onOpen({path:'/workspace/b.txt'});await instance.flush();
  f.write.resolve({ok:false,status:409,json:async()=>({error:'changed on disk',code:'FS_STALE_VERSION'})});await instance.flush();
  assert.equal(view(instance).doc.path,'/workspace/b.txt');assert.equal(button(instance,'Overwrite disk file'),undefined);instance.unmount();
});
test('Preview keeps the native guest when entering another URL or choosing a device',async()=>{
  const client=loadClient('client-ui-preview',async()=>response({entries:[],ports:[],previewOrigin:null}));
  const instance=await client.mount().flush();
  async function go(url){instance.find(n=>n.type==='input').props.onChange({target:{value:url}});await instance.flush();instance.find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await instance.flush();}
  await go('http://localhost:3000');const key=instance.find(n=>n.type==='webview').props.key;
  await go('http://localhost:5173');assert.equal(instance.find(n=>n.type==='webview').props.key,key,'navigation must not destroy browser history');
  instance.find(n=>n.type==='select').props.onChange({target:{value:'desktop'}});await instance.flush();
  assert.equal(instance.find(n=>n.type==='webview').props.key,key);assert.equal(instance.guest.style.width,'1440px','device width stays real even when visually scaled');instance.unmount();
});

test('source scanning preserves the selected page origin for restart recovery',async()=>{
  const client=loadClient('client-ui-preview',async url=>url.includes('/open?')
    ? new Promise(()=>{}) // Resolve the source separately from discovery.
    : response({entries:[],ports:[],previewOrigin:'http://127.0.0.1:60002'}));
  client.storage.set('dshd.preview.url','http://127.0.0.1:60001/index.html');
  client.storage.set('dshd.preview.origin','http://127.0.0.1:60001');
  client.storage.set('dshd.preview.page','/workspace/nested/index.html');
  const instance=await client.mount().flush();
  assert.equal(client.storage.get('dshd.preview.origin'),'http://127.0.0.1:60001');instance.unmount();
});

test('a directory read failure exits loading and can be retried',async()=>{
  let fail=true;
  const client=loadClient('client-ui-files',async url=>{
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Test'}]});
    if(fail)throw Error('Temporary read failure');
    return response({entries:[{name:'recovered.txt',path:'/workspace/recovered.txt',type:'file'}]});
  });
  const instance=await client.mount().flush();assert.equal(tree(instance).dirs['/workspace'],null);
  fail=false;button(instance,'Refresh').props.onClick();await instance.flush();
  assert.equal(tree(instance).dirs['/workspace'][0].name,'recovered.txt');instance.unmount();
});

test('retained Files refreshes workspaces and trees without losing an available project draft',async()=>{
  let roots=[{path:'/workspace',title:'Test'}], scans=0;
  const calls=[];
  const client=loadClient('client-ui-files',async url=>{
    calls.push(url);
    if(url.endsWith('/roots')){scans++;return response({roots});}
    if(url.includes('/list?'))return response({entries:[]});
    if(url.includes('/draft?'))return response({draft:null});
    if(url.endsWith('/draft'))return response({revision:'backup'});
    return response({kind:'text',path:'/workspace/notes.txt',text:'Original',version:'1'});
  });
  const instance=await client.mount({standalone:true,active:true}).flush();
  await tree(instance).onOpen({path:'/workspace/notes.txt'});await instance.flush();
  view(instance).onDraft('Keep this draft');await instance.flush();
  tree(instance).onToggle('/workspace/nested');await instance.flush();
  await instance.setProps({standalone:true,active:false}).flush();
  roots=[...roots,{path:'/second',title:'Second'}];
  const start=calls.length;
  await instance.setProps({standalone:true,active:true}).flush();
  assert.equal(scans,2);assert.equal(tree(instance).path,'/workspace');
  assert.equal(view(instance).draft,'Keep this draft');
  assert.ok(calls.slice(start).some(url=>url.includes(encodeURIComponent('/workspace/nested'))));
  assert.equal(instance.find(n=>n.type==='select'&&n.props['aria-label']==='Workspace').props.children.length,2);
  roots=[];button(instance,'Refresh').props.onClick();await instance.flush();
  assert.equal(instance.find(n=>n.type?.name==='TreeLevel'),undefined);
  assert.equal(view(instance).doc,null,'removed workspace must not remain editable');
  roots=[{path:'/workspace',title:'Test'}];button(instance,'Refresh').props.onClick();await instance.flush();
  assert.equal(view(instance).draft,'Keep this draft','removing a workspace does not erase its unsaved work');
  instance.unmount();
});

test('late workspace discovery cannot undo a newer activation or saved root selection',async()=>{
  let resolveOld, scans=0;
  const client=loadClient('client-ui-files',async url=>{
    if(url.endsWith('/roots')){
      if(++scans===1)return new Promise(resolve=>{resolveOld=resolve});
      return response({roots:[{path:'/first',title:'First'},{path:'/saved',title:'Saved'}]});
    }
    return response({entries:[]});
  });
  client.storage.set('dshd.files.root','/saved');
  const instance=await client.mount({active:true}).flush();
  await instance.setProps({active:false}).flush();await instance.setProps({active:true}).flush();
  assert.equal(tree(instance).path,'/saved');
  resolveOld(response({roots:[{path:'/old',title:'Old'}]}));await instance.flush();
  assert.equal(tree(instance).path,'/saved');instance.unmount();
});

test('workspace aliases reopen the canonical file and deduplicate the same physical project',async()=>{
  const calls=[];
  const client=loadClient('client-ui-files',async url=>{
    calls.push(url);
    if(url.endsWith('/roots'))return response({roots:[
      {path:'/other',canonicalPath:'/other',title:'Other'},
      {path:'/shortcut/project',canonicalPath:'/actual/project',title:'My project'},
      {path:'/actual/project',canonicalPath:'/actual/project',title:'Duplicate'},
    ]});
    if(url.includes('/list?'))return response({entries:[]});
    if(url.includes('/draft?'))return response({draft:null});
    return response({kind:'text',path:'/actual/project/notes.txt',text:'Original',version:'1'});
  });
  client.storage.set('dshd.files.root','/shortcut/project');
  client.storage.set('dshd.files.last','/actual/project/notes.txt');
  const instance=await client.mount().flush();
  assert.equal(tree(instance).path,'/actual/project');
  assert.equal(view(instance).doc?.path,'/actual/project/notes.txt');
  assert.equal(client.storage.get('dshd.files.root'),'/actual/project');
  assert.equal(instance.find(n=>n.type==='select'&&n.props['aria-label']==='Workspace').props.children.length,2);
  button(instance,'Refresh').props.onClick();await instance.flush();
  assert.equal(tree(instance).path,'/actual/project');assert.equal(view(instance).doc?.text,'Original');
  assert.ok(calls.some(url=>url.includes(encodeURIComponent('/actual/project'))));instance.unmount();
});

test('Preview refreshes on activation and ignores a slower obsolete scan',async()=>{
  let resolveOld, scans=0;
  const client=loadClient('client-ui-preview',async()=>{
    if(++scans===1)return new Promise(resolve=>{resolveOld=resolve});
    return response({entries:[],ports:[60002],previewOrigin:'http://127.0.0.1:60002'});
  });
  const instance=await client.mount({active:true}).flush();
  await instance.setProps({active:false}).flush();assert.equal(scans,1);
  await instance.setProps({active:true}).flush();assert.equal(scans,2);
  assert.ok(button(instance,'127.0.0.1:60002'));
  resolveOld(response({entries:[],ports:[60001],previewOrigin:'http://127.0.0.1:60001'}));
  await instance.flush();assert.ok(button(instance,'127.0.0.1:60002'));assert.equal(button(instance,'127.0.0.1:60001'),undefined);
  instance.unmount();
});

async function recoveryFixture(roots = ['/workspace']) {
  const {createDraftStore}=await import('../../plugins/host-files-api/lib/drafts.js');
  const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-ui-draft-'));
  const store=createDraftStore(home);
  let disk={text:'Original',version:'1'},hold=false,release;
  const writes=[];
  const fetcher=async(url,init)=>{
    if(url.endsWith('/roots'))return response({roots:roots.map(path=>({path,title:path}))});
    if(url.includes('/list?'))return response({entries:[]});
    if(url.endsWith('/drafts/stream')){const inventory=await store.list();return new Response(JSON.stringify({...inventory,scanned:inventory.drafts.length,done:true,drafts:inventory.drafts.map(entry=>({...entry,root:roots.find(root=>entry.path.startsWith(root+'/'))}))})+'\n');}
    if(url.includes('/draft?'))return response({draft:await store.read(decodeURIComponent(url.split('path=')[1]))});
    if(url.endsWith('/draft')){
      const body=JSON.parse(init.body);
      if(hold){hold=false;await new Promise(resolve=>{release=resolve});}
      try {const saved=await store.replace(body.path,body.draft,body.revision);return response({revision:saved?.revision??null});}
      catch(error){return {ok:false,status:409,json:async()=>({error:error.message,code:error.code})};}
    }
    if(url.includes('/read?'))return disk?response({kind:'text',path:'/workspace/notes.txt',...disk}):{ok:false,status:404,json:async()=>({error:'not found'})};
    if(url.endsWith('/write')){
      const body=JSON.parse(init.body);writes.push(body);
      if((body.createOnly&&disk)||(body.version!==undefined&&body.version!==disk?.version))return {ok:false,status:409,json:async()=>({error:'changed on disk',code:'FS_STALE_VERSION',missing:!disk})};
      const operation=disk?'replace':'create';
      disk={text:body.text,version:String(Number(disk?.version||0)+1)};
      return response({version:disk.version,operation});
    }
    throw Error(url);
  };
  return {store,writes,fetcher,get disk(){return disk},changeDisk(value){disk=value},holdNext(){hold=true},release(){release()},
    client(options){return loadClient('client-ui-files',fetcher,options)},clean:()=>fs.rm(home,{recursive:true,force:true})};
}
async function settledBackup(f,instance,expected) {
  for(let i=0;i<100;i++){
    await instance.flush();
    const record=await f.store.read('/workspace/notes.txt');
    if((record?.text??null)===expected && !instance.find(n=>n.type==='span'&&n.props.children.includes('Saving local draft backup…')))return record;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw Error('Backup did not settle');
}

async function recoveryPanel(client,parent,path='/workspace/notes.txt') {
  button(parent,'Recover drafts').props.onClick();await parent.flush();
  const entry=parent.find(n=>n.type?.name==='RecoveryPanel');
  const panel=await client.mount(entry.props,entry.type).flush();
  for(let i=0;i<100;i++){
    if(panel.find(n=>n.props['aria-label']==='Review draft: '+path))return panel;
    await new Promise(resolve=>setTimeout(resolve,5));await panel.flush();
  }
  throw Error('Recovery inventory did not load');
}
async function reviewDraft(panel,path='/workspace/notes.txt') {
  await panel.find(n=>n.props['aria-label']==='Review draft: '+path).props.onClick();await panel.flush();
}
const savedDraft={text:'Saved recovery',base:{text:'Original',version:'1'}};

test('deleted-file recovery offers guarded recreation and preserves a file created before confirmation',async t=>{
  const f=await recoveryFixture();t.after(f.clean);await f.store.replace('/workspace/notes.txt',savedDraft,null);f.changeDisk(null);
  const client=f.client(),parent=await client.mount().flush(),panel=await recoveryPanel(client,parent);await reviewDraft(panel);
  assert.equal(panel.find(n=>n.props['aria-label']==='Current disk contents'),undefined);
  await button(panel,'Open draft in editor').props.onClick();await parent.flush();
  button(parent,'Save changes').props.onClick();await parent.flush();
  assert.ok(button(parent,'Recreate file'));assert.equal(button(parent,'Overwrite disk file'),undefined);
  assert.equal(f.disk,null);assert.equal((await f.store.read('/workspace/notes.txt')).text,savedDraft.text);
  f.changeDisk({text:'Another writer recreated this',version:'2'});
  button(parent,'Recreate file').props.onClick();await parent.flush();
  assert.equal(f.writes[1].createOnly,true);assert.equal(f.writes[1].version,undefined);
  assert.equal(f.disk.text,'Another writer recreated this');assert.ok(button(parent,'Overwrite disk file'));
  assert.equal(view(parent).draft,savedDraft.text);panel.unmount();parent.unmount();
});

test('confirmed recreation restores a still-missing file and clears only its saved backup',async t=>{
  const f=await recoveryFixture();t.after(f.clean);await f.store.replace('/workspace/notes.txt',savedDraft,null);f.changeDisk(null);
  const client=f.client(),parent=await client.mount().flush(),panel=await recoveryPanel(client,parent);await reviewDraft(panel);
  await button(panel,'Open draft in editor').props.onClick();await parent.flush();
  button(parent,'Save changes').props.onClick();await parent.flush();button(parent,'Recreate file').props.onClick();await parent.flush();
  await settledBackup(f,parent,null);assert.equal(f.disk.text,savedDraft.text);assert.equal(tree(parent).dirtyPaths.size,0);
  panel.unmount();parent.unmount();
});

test('recovery finds an unopened file, compares disk changes, and opens with the original save guard',async t=>{
  const f=await recoveryFixture();t.after(f.clean);await f.store.replace('/workspace/notes.txt',savedDraft,null);
  f.changeDisk({text:'Agent changed disk',version:'2'});
  const client=f.client(),parent=await client.mount().flush(),panel=await recoveryPanel(client,parent);
  await reviewDraft(panel);
  assert.equal(panel.find(n=>n.props['aria-label']==='Saved draft contents').props.value,'Saved recovery');
  assert.equal(panel.find(n=>n.props['aria-label']==='Current disk contents').props.value,'Agent changed disk');
  assert.equal(panel.find(n=>n.props['aria-label']==='Original file contents').props.value,'Original');
  parent.tree.props.onKeyDown({ctrlKey:true,key:'s',preventDefault(){},stopPropagation(){}});assert.equal(f.writes.length,0);
  await button(panel,'Open draft in editor').props.onClick();await parent.flush();
  assert.equal(view(parent).draft,'Saved recovery');assert.equal(view(parent).mode,'edit');
  button(parent,'Save changes').props.onClick();await parent.flush();
  assert.equal(f.writes[0].version,'1');assert.equal(f.disk.text,'Agent changed disk');assert.ok(button(parent,'Overwrite disk file'));
  panel.unmount();parent.unmount();
});

test('discard requires explicit confirmation and removes only the matching draft, never the disk file',async t=>{
  const f=await recoveryFixture();t.after(f.clean);await f.store.replace('/workspace/notes.txt',savedDraft,null);
  const client=f.client();client.storage.set('dshd.files.last','/workspace/notes.txt');
  const parent=await client.mount().flush();
  for(let i=0;i<10&&!view(parent).doc;i++)await parent.flush();
  const panel=await recoveryPanel(client,parent);await reviewDraft(panel);
  parent.tree.props.onKeyDown({ctrlKey:true,key:'s',preventDefault(){},stopPropagation(){}});
  await parent.flush();assert.equal(f.writes.length,0,'reviewing a backup must not save the hidden dirty editor');
  assert.equal(button(panel,'Discard saved draft'),undefined);
  button(panel,'Discard…').props.onClick();await panel.flush();
  assert.ok(await f.store.read('/workspace/notes.txt'));
  await button(panel,'Discard saved draft').props.onClick();await panel.flush();await parent.flush();
  assert.equal(await f.store.read('/workspace/notes.txt'),null);assert.equal(f.disk.text,'Original');assert.equal(f.writes.length,0);
  button(panel,'Back to files').props.onClick();await parent.flush();assert.equal(view(parent).doc,null);
  panel.unmount();parent.unmount();
});

test('recovery opens a different workspace even when preference storage is unavailable',async t=>{
  const f=await recoveryFixture(['/workspace','/second']);t.after(f.clean);
  const path='/second/nested/notes.txt';await f.store.replace(path,savedDraft,null);
  const client=f.client({storage:{get(){throw Error('Storage disabled')},set(){throw Error('Storage disabled')}}});
  const parent=await client.mount().flush(),panel=await recoveryPanel(client,parent,path);
  await reviewDraft(panel,path);await button(panel,'Open draft in editor').props.onClick();await parent.flush();
  assert.equal(view(parent).doc?.path,path);assert.equal(view(parent).draft,savedDraft.text);assert.equal(view(parent).mode,'edit');
  assert.ok(tree(parent).open.has('/second/nested'),'the recovered file parent is expanded');
  assert.equal(f.writes.length,0);panel.unmount();parent.unmount();
});

test('a newer backup from another window survives a stale discard action',async t=>{
  const f=await recoveryFixture();t.after(f.clean);const saved=await f.store.replace('/workspace/notes.txt',savedDraft,null);
  const client=f.client(),parent=await client.mount().flush(),panel=await recoveryPanel(client,parent);await reviewDraft(panel);
  await f.store.replace('/workspace/notes.txt',{...savedDraft,text:'Newer backup'},saved.revision);
  button(panel,'Discard…').props.onClick();await panel.flush();await button(panel,'Discard saved draft').props.onClick();await panel.flush();
  assert.equal((await f.store.read('/workspace/notes.txt')).text,'Newer backup');assert.ok(panel.find(n=>n.props.role==='alert'));
  panel.unmount();parent.unmount();
});

test('recovery will not replace different unsaved editor changes',async t=>{
  const f=await recoveryFixture();t.after(f.clean);await f.store.replace('/workspace/notes.txt',savedDraft,null);
  const client=f.client(),parent=await client.mount().flush();await tree(parent).onOpen({path:'/workspace/notes.txt'});await parent.flush();
  const editor=view(parent),panel=await recoveryPanel(client,parent);await reviewDraft(panel);
  editor.onDraft('Different editor work');await settledBackup(f,parent,'Different editor work');
  await button(panel,'Open draft in editor').props.onClick();await panel.flush();
  assert.ok(panel.find(n=>n.props.role==='alert'));assert.ok(parent.find(n=>n.type?.name==='RecoveryPanel'));
  assert.equal((await f.store.read('/workspace/notes.txt')).text,'Different editor work');
  panel.unmount();parent.unmount();
});

test('typing during a confirmed discard is retained and backed up under a new revision',async t=>{
  const f=await recoveryFixture();t.after(f.clean);await f.store.replace('/workspace/notes.txt',savedDraft,null);
  const client=f.client(),parent=await client.mount().flush();await tree(parent).onOpen({path:'/workspace/notes.txt'});await parent.flush();
  const editor=view(parent),panel=await recoveryPanel(client,parent);await reviewDraft(panel);
  button(panel,'Discard…').props.onClick();await panel.flush();f.holdNext();
  const pending=button(panel,'Discard saved draft').props.onClick();await panel.flush();
  editor.onDraft('Typed while discarding');await parent.flush();f.release();await pending;
  await settledBackup(f,parent,'Typed while discarding');
  assert.equal(f.disk.text,'Original');button(panel,'Back to files').props.onClick();await parent.flush();assert.equal(view(parent).draft,'Typed while discarding');
  panel.unmount();parent.unmount();
});

test('real draft store restores a new renderer and keeps the original conflict guard',async t=>{
  const f=await recoveryFixture();t.after(f.clean);
  const first=await f.client().mount().flush();await tree(first).onOpen({path:'/workspace/notes.txt'});await first.flush();
  view(first).onDraft('Recovered editing');await settledBackup(f,first,'Recovered editing');first.unmount();
  f.changeDisk({text:'Agent changed disk',version:'2'});
  const nextClient=f.client();nextClient.storage.set('dshd.files.last','/workspace/notes.txt');
  const next=await nextClient.mount().flush();
  for(let i=0;i<10&&!view(next).doc;i++)await next.flush();
  assert.equal(view(next).draft,'Recovered editing');assert.equal(view(next).doc.version,'1');assert.equal(view(next).mode,'edit');
  button(next,'Save changes').props.onClick();await next.flush();
  assert.equal(f.writes[0].version,'1');assert.equal(f.disk.text,'Agent changed disk');assert.ok(button(next,'Overwrite disk file'));
  next.unmount();
});

test('backup queue coalesces rapid edits and clears recovery after a successful save',async t=>{
  const f=await recoveryFixture();t.after(f.clean);
  const instance=await f.client().mount().flush();await tree(instance).onOpen({path:'/workspace/notes.txt'});await instance.flush();
  f.holdNext();view(instance).onDraft('First');await instance.flush();
  view(instance).onDraft('Second');await instance.flush();view(instance).onDraft('Third');await instance.flush();
  f.release();const record=await settledBackup(f,instance,'Third');assert.equal(record.base.version,'1');
  button(instance,'Save changes').props.onClick();await settledBackup(f,instance,null);
  assert.equal(f.disk.text,'Third');assert.equal(tree(instance).dirtyPaths.size,0);instance.unmount();
});

test('saving the disk file while a backup is in flight cannot resurrect an old draft',async t=>{
  const f=await recoveryFixture();t.after(f.clean);
  const instance=await f.client().mount().flush();await tree(instance).onOpen({path:'/workspace/notes.txt'});await instance.flush();
  f.holdNext();view(instance).onDraft('Saved work');await instance.flush();
  button(instance,'Save changes').props.onClick();await instance.flush();
  view(instance).onDraft('Newer unsaved work');await instance.flush();
  f.release();const record=await settledBackup(f,instance,'Newer unsaved work');
  assert.equal(record.base.text,'Saved work');assert.equal(record.base.version,'2');
  assert.equal(f.disk.text,'Saved work');instance.unmount();
});

test('a failed backup is visible while the editor keeps its unsaved text',async()=>{
  const client=loadClient('client-ui-files',async url=>{
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Test'}]});
    if(url.includes('/list?'))return response({entries:[]});
    if(url.includes('/draft?'))return response({draft:null});
    if(url.endsWith('/draft'))throw Error('Disk is full');
    return response({kind:'text',path:'/workspace/notes.txt',text:'Original',version:'1'});
  });
  const instance=await client.mount().flush();await tree(instance).onOpen({path:'/workspace/notes.txt'});await instance.flush();
  view(instance).onDraft('Do not lose this');await instance.flush();
  assert.equal(view(instance).draft,'Do not lose this');assert.ok(button(instance,'Retry backup'));
  assert.ok(instance.find(n=>n.props.role==='alert'));instance.unmount();
});

test('retry recovers from an initial backup read failure without replacing an unseen draft',async()=>{
  for(const exists of [false,true]) {
    let failed=false,posts=0;
    const client=loadClient('client-ui-files',async(url,init)=>{
      if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Test'}]});
      if(url.includes('/list?'))return response({entries:[]});
      if(url.includes('/draft?')){
        if(!failed){failed=true;throw Error('Temporary disconnect');}
        return response({draft:exists?{text:'Other recovered edits',base:{text:'Original',version:'1'},revision:'other'}:null});
      }
      if(url.endsWith('/draft')){posts++;return response({revision:'new'});}
      return response({kind:'text',path:'/workspace/notes.txt',text:'Original',version:'1'});
    });
    const instance=await client.mount().flush();await tree(instance).onOpen({path:'/workspace/notes.txt'});await instance.flush();
    view(instance).onDraft('Current edits');await instance.flush();
    button(instance,'Retry backup').props.onClick();await instance.flush();
    assert.equal(posts,exists?0:1);assert.equal(view(instance).draft,'Current edits');
    assert.equal(Boolean(button(instance,'Retry backup')),exists);instance.unmount();
  }
});

test('restoring a nested draft in the current workspace expands its parent folders',async t=>{
  const f=await recoveryFixture();t.after(f.clean);
  const path='/workspace/src/nested/recovered.txt';
  await f.store.replace(path,{text:'Recovered nested work',base:{text:'Original',version:'1'}},null);
  const client=f.client(),parent=await client.mount().flush();t.after(()=>parent.unmount());
  const panel=await recoveryPanel(client,parent,path);t.after(()=>panel.unmount());
  await reviewDraft(panel,path);await button(panel,'Open draft in editor').props.onClick();await parent.flush();
  assert.ok(tree(parent).open.has('/workspace/src'));assert.ok(tree(parent).open.has('/workspace/src/nested'));
  assert.equal(parent.find(n=>n.type?.name==='Viewer').props.doc.path,path);
  assert.equal(parent.find(n=>n.type?.name==='Viewer').props.draft,'Recovered nested work');
});
