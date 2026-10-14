const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const response=payload=>({ok:true,json:async()=>payload});
const button=(instance,label)=>instance.find(n=>n.type==='button'&&n.props.children.includes(label));
const input=instance=>instance.find(n=>n.props.role==='combobox');
const option=instance=>instance.find(n=>n.props.role==='option');
async function until(instance,predicate){for(let i=0;i<200;i++){await instance.flush();if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('Search did not settle');}
async function mountSearch(fetchSearch) {
  const client=loadClient('client-ui-files',async(url,init)=>{
    if(url.includes('/search?'))return fetchSearch(new URL(url,'http://fixture'),init);
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Fixture'}]});
    if(url.includes('/list?'))return response({entries:[]});
    if(url.includes('/draft?'))return response({draft:null});
    if(url.endsWith('/draft'))return response({revision:'backup'});
    if(url.includes('/read?'))return response({kind:'text',path:new URL(url,'http://fixture').searchParams.get('path'),text:'Original',version:'1'});
    throw Error(url);
  },{globals:{setTimeout,clearTimeout,AbortController}});
  const parent=await client.mount().flush();
  const tree=()=>parent.find(n=>n.type?.name==='TreeLevel').props;
  await tree().onOpen({path:'/workspace/edited.txt'});await parent.flush();
  parent.find(n=>n.type?.name==='Viewer').props.onDraft('Keep my edits');await parent.flush();
  parent.tree.props.onKeyDown({metaKey:true,key:'p',preventDefault(){},stopPropagation(){}});await parent.flush();
  const node=parent.find(n=>n.type?.name==='FileSearch');assert.ok(node,'Cmd+P reaches the real search component');
  const panel=await client.mount(node.props,node.type).flush();
  return {parent,panel,props:node.props,tree,close(){panel.unmount();parent.unmount();}};
}

test('Find file narrows folders and opens a nested file without losing other editor drafts',async t=>{
  const calls=[];
  const f=await mountSearch(url=>{
    const q=url.searchParams.get('q');calls.push(q);
    return response({root:'/workspace',entries:q==='src/'?[{path:'/workspace/src/main.ts',relativePath:'src/main.ts',type:'file'}]:[{path:'/workspace/src',relativePath:'src',type:'directory'}]});
  });t.after(f.close);
  await until(f.panel,()=>option(f.panel));
  const key=key=>f.panel.tree.props.onKeyDown({key,target:input(f.panel).props.ref.current,preventDefault(){},stopPropagation(){}});
  key('Enter');await until(f.panel,()=>option(f.panel)?.props.children.some(n=>n?.type==='span'&&n.props.children.some(c=>c?.props?.children.includes('src/main.ts'))));
  assert.equal(input(f.panel).props.value,'src/');key('Enter');await f.parent.flush();
  assert.equal(f.parent.find(n=>n.type?.name==='Viewer').props.doc.path,'/workspace/src/main.ts');
  assert.ok(f.tree().open.has('/workspace/src'));assert.ok(f.tree().dirtyPaths.has('/workspace/edited.txt'));
  assert.ok(calls.includes('src/'));
  await f.tree().onOpen({path:'/workspace/edited.txt'});await f.parent.flush();
  assert.equal(f.parent.find(n=>n.type?.name==='Viewer').props.draft,'Keep my edits');
});

test('search ignores obsolete results and aborts the previous wait when the query changes',async t=>{
  let releaseOld,oldSignal;
  const f=await mountSearch((url,init)=>{
    const q=url.searchParams.get('q');
    if(q==='alpha'){oldSignal=init.signal;return new Promise(resolve=>{releaseOld=resolve});}
    return response({root:'/workspace',entries:q==='beta'?[{path:'/workspace/beta.txt',relativePath:'beta.txt',type:'file'}]:[]});
  });t.after(f.close);
  input(f.panel).props.onChange({target:{value:'alpha'}});await until(f.panel,()=>releaseOld);
  input(f.panel).props.onChange({target:{value:'beta'}});await until(f.panel,()=>option(f.panel));
  assert.equal(oldSignal.aborted,true);
  releaseOld(response({root:'/workspace',entries:[{path:'/workspace/alpha.txt',relativePath:'alpha.txt',type:'file'}]}));await f.panel.flush();
  assert.ok(option(f.panel).props.children.some(n=>n?.type==='span'&&n.props.children.some(c=>c?.props?.children.includes('beta.txt'))));
  await f.panel.setProps({...f.props,root:null}).flush();
  assert.equal(input(f.panel).props.disabled,true);assert.equal(option(f.panel),undefined);
});

test('search reports failures, retries, and handles keys without hijacking toolbar buttons',async t=>{
  let fail=true;
  const f=await mountSearch(()=>fail?{ok:false,status:503,json:async()=>({error:'Search unavailable'})}:response({root:'/workspace',entries:[
    {path:'/workspace/a.txt',relativePath:'a.txt',type:'file'},{path:'/workspace/b.txt',relativePath:'b.txt',type:'file'},
  ]}));t.after(f.close);
  await until(f.panel,()=>f.panel.find(n=>n.props.role==='alert'));
  fail=false;button(f.panel,'Refresh search').props.onClick();await until(f.panel,()=>option(f.panel));
  const key=key=>f.panel.tree.props.onKeyDown({key,target:input(f.panel).props.ref.current,preventDefault(){},stopPropagation(){}});
  key('ArrowDown');await f.panel.flush();assert.ok(input(f.panel).props['aria-activedescendant'].endsWith('-1'));
  key('ArrowDown');await f.panel.flush();assert.ok(input(f.panel).props['aria-activedescendant'].endsWith('-0'));
  f.panel.tree.props.onKeyDown({key:'Enter',target:{},preventDefault(){throw Error('Toolbar Enter was intercepted')}});
  assert.ok(f.parent.find(n=>n.type?.name==='FileSearch'));
  let stopped=false;f.panel.tree.props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){stopped=true}});await f.parent.flush();
  assert.equal(stopped,true);assert.equal(f.parent.find(n=>n.type?.name==='FileSearch'),undefined);
  assert.equal(f.parent.find(n=>n.type?.name==='Viewer').props.draft,'Keep my edits');
});
