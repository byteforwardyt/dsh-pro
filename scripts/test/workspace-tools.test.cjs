const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const FilesView=()=>null, PreviewView=()=>null;
function fixture(slot='shell.overlay',options={}) {
  const client = loadClient('client-ui-workspace-tools',options.fetcher || (()=>{throw Error('Tools shell must not make model requests')}),{...options,slot,element:()=>({closest(){return null}}),modules:{
    'react-dom':{createPortal:content=>content},'@dsh-desktop/client-ui-files':{FilesView},'@dsh-desktop/client-ui-preview':{PreviewView},
  }});
  return {...client,mount:(props,component)=>client.mount(props,component||client.registrations.find(row=>row.meta.name===slot && (slot!=='shell.overlay'||row.meta.id==='workspace-tools')).view)};
}
const tab=(instance,name)=>instance.find(n=>n.props.role==='tab'&&n.props.children.includes(name));
test('workspace tools use root slots, independent of a conversation or account',async()=>{
  const client=fixture();
  assert.deepEqual(client.registrations.map(x=>x.meta.name),['sidebar.footer.action','desktop.home.actions','shell.overlay','shell.overlay']);
  const panel=await client.mount().flush();
  assert.equal(panel.tree.type,'dialog');assert.equal(panel.tree.props.ref.current.open,false);
  assert.equal(panel.find(n=>n.type===FilesView),undefined);
  assert.equal(panel.find(n=>n.type===PreviewView),undefined);panel.unmount();
});
test('workspace tab switching preserves both component identities and does not hide the composer',async()=>{
  const client=fixture();const panel=await client.mount().flush();
  tab(panel,'Files').props.onClick();await panel.flush();
  assert.equal(panel.tree.props.ref.current.open,true);
  assert.equal(panel.find(n=>n.type===FilesView).props.standalone,true);
  assert.equal(panel.find(n=>n.type===FilesView).props.active,true);
  assert.equal(panel.find(n=>n.type===PreviewView),undefined);
  tab(panel,'Preview').props.onClick();await panel.flush();
  assert.ok(panel.find(n=>n.type===FilesView));assert.ok(panel.find(n=>n.type===PreviewView));
  assert.equal(panel.find(n=>n.type===FilesView).props.active,false);
  assert.equal(panel.find(n=>n.type===PreviewView).props.active,true);
  assert.equal(panel.find(n=>n.props.id==='dshd-tools-panel-files').props.hidden,true);
  assert.equal(panel.find(n=>n.props.id==='dshd-tools-panel-preview').props.hidden,false);
  panel.find(n=>n.props['aria-label']==='Close workspace tools').props.onClick();await panel.flush();
  assert.equal(panel.tree.props.ref.current.open,false);
  assert.equal(panel.find(n=>n.type===PreviewView).props.active,false);
  assert.ok(panel.find(n=>n.type===PreviewView),'closing keeps the existing Preview guest and its history');panel.unmount();
});
test('tab keys select the intended tool and Escape closes the native dialog',async()=>{
  const panel=await fixture().mount().flush();tab(panel,'Files').props.onClick();await panel.flush();
  let prevented=false;
  panel.find(n=>n.props.role==='tablist').props.onKeyDown({key:'ArrowRight',preventDefault(){prevented=true}});await panel.flush();
  assert.ok(prevented);assert.equal(tab(panel,'Preview').props['aria-selected'],true);
  panel.find(n=>n.props.role==='tablist').props.onKeyDown({key:'Home',preventDefault(){}});await panel.flush();
  assert.equal(tab(panel,'Files').props['aria-selected'],true);
  panel.tree.props.onCancel({preventDefault(){}});await panel.flush();assert.equal(panel.tree.props.ref.current.open,false);panel.unmount();
});
test('sidebar has labeled navigation and no duplicate Files and Preview launcher',async()=>{
  const nav=await fixture('sidebar.footer.action').mount({wide:false}).flush();
  const labels=['Scheduled','Pull requests'];
  for(const label of labels){
    const button=nav.find(n=>n.type==='button'&&n.props['aria-label']===label);
    assert.ok(button);assert.equal(button.props['aria-haspopup'],'dialog');
  }
  assert.equal(nav.find(n=>n.props['aria-label']==='Open workspace tools'),undefined);
  nav.find(n=>n.props['aria-label']==='Scheduled').props.onClick();await nav.flush();
  assert.equal(nav.find(n=>n.props['aria-label']==='Scheduled').props['aria-expanded'],true);
  nav.unmount();
});

test('home shortcuts open the requested tool and reuse the resident editor after closing',async()=>{
  const client=fixture();
  const panel=await client.mount().flush();
  const home=await client.mount({},client.registrations.find(x=>x.meta.name==='desktop.home.actions').view).flush();
  const buttons=home.tree.props.children;
  const files=await client.mount(buttons[0].props,buttons[0].type).flush();
  const preview=await client.mount(buttons[1].props,buttons[1].type).flush();
  assert.equal(files.tree.props['aria-label'],'Open files');
  assert.equal(preview.tree.props['aria-label'],'Open preview');
  preview.tree.props.onClick();await panel.flush();await preview.flush();
  assert.equal(tab(panel,'Preview').props['aria-selected'],true);
  assert.equal(panel.find(n=>n.type===FilesView),undefined);
  assert.equal(preview.tree.props['aria-expanded'],true);
  panel.find(n=>n.props['aria-label']==='Close workspace tools').props.onClick();await panel.flush();await preview.flush();
  assert.equal(preview.tree.props['aria-expanded'],false);
  files.tree.props.onClick();await panel.flush();await files.flush();
  assert.equal(tab(panel,'Files').props['aria-selected'],true);
  assert.equal(panel.find(n=>n.type===FilesView).props.active,true);
  assert.equal(panel.find(n=>n.type===PreviewView).props.active,false,'returning to Files preserves the existing Preview instance');
  [panel,home,files,preview].forEach(view=>view.unmount());
});

test('cold module loading brings Files and Preview in before materializing Workspace tools',async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
  const root=path.resolve(__dirname,'../..');
  const pnpm=path.join(root,'node_modules/.pnpm');
  const upstream=fs.readdirSync(pnpm).find(name=>name.startsWith('@deepseek-ai+dsh-client-modules@'));
  let bootstrap;
  vm.runInNewContext(fs.readFileSync(path.join(pnpm,upstream,'node_modules/@deepseek-ai/dsh-client-modules/lib/client.js'),'utf8'),
    {window:{__ModuleLoader__:{load(registration){bootstrap=registration.factory(()=>{throw Error('unexpected bootstrap dependency')})}}}});
  const names=['client-ui-workspace-tools','client-ui-files','client-ui-preview'];
  const manifests=names.map(name=>JSON.parse(fs.readFileSync(path.join(root,'plugins',name,'package.json'))));
  const sources=new Map(manifests.map((manifest,i)=>[manifest.name,fs.readFileSync(path.join(root,'plugins',names[i],'lib/client.js'),'utf8')]));
  const rows=manifests.map(manifest=>({id:manifest.name,url:manifest.name,initialUrl:manifest.name,inject:manifest.dsh.client.inject||[],external:manifest.dsh.client.external||[]}));
  const target={mode:'queue',pendingQueue:[]};
  const arrived=[];
  const loader=new bootstrap.ClientModuleSystem({manifest:{modules:rows},staticModules:{react:{},'react-dom':{}},registrationTarget:target,
    bootstrapModule:{id:'bootstrap',exports:{}},loadBundle:async id=>{
      arrived.push(id);vm.runInNewContext(sources.get(id),{window:{__ModuleLoader__:target}});
    }});
  const entry=await loader.import('@dsh-desktop/client-ui-workspace-tools');
  assert.equal(typeof entry.apply,'function');
  assert.deepEqual(arrived,['@dsh-desktop/client-ui-files','@dsh-desktop/client-ui-preview','@dsh-desktop/client-ui-workspace-tools']);
  assert.equal(typeof (await loader.import('@dsh-desktop/client-ui-files')).FilesView,'function');
  assert.equal(typeof (await loader.import('@dsh-desktop/client-ui-preview')).PreviewView,'function');
});

test('Plugins hub lists installed capabilities and opens Settings by label, not nav count',async()=>{
  let ready=false, opened=0, selected=0, timeout, observe;
  const control={getAttribute:()=>opened?'true':'false',click(){opened++}};
  const document={getElementById:()=>({}),body:{},querySelector:()=>control,querySelectorAll:()=>ready?[
    {textContent:'Extra',click(){}},
    {textContent:'  Plugins  ',click(){selected++}},
    {textContent:'General',click(){}},
  ]:[]};
  const client=fixture('sidebar.footer.action',{entries:()=>[{options:{id:'plugins',order:20}},{options:{id:'general',order:0}}],globals:{document,
    setTimeout(fn){timeout=fn;return 1},clearTimeout(){timeout=null},MutationObserver:class{constructor(fn){observe=fn}observe(){}disconnect(){observe=null}}}});
  const nav=await client.mount({}).flush();
  const hub=await client.mount({},client.registrations.find(row=>row.meta.id==='workspace-hub').view).flush();
  nav.find(n=>n.props['aria-label']==='Scheduled').props.onClick();await hub.flush();
  hub.find(n=>n.type==='button'&&[].concat(n.props.children).includes('Plugins')).props.onClick();await hub.flush();
  assert.equal(hub.tree.props.ref.current.open,true);
  assert.equal(opened,0);
  const page=hub.find(n=>n.type?.name==='Plugins');
  assert.ok(page);
  const view=await client.mount(page.props,page.type).flush();
  assert.ok(view.find(n=>n.props['aria-label']==='Installed capabilities'));
  assert.ok(view.find(n=>n.type==='strong'&&[].concat(n.props.children).includes('Computer use')));
  assert.ok(view.find(n=>n.type==='strong'&&[].concat(n.props.children).includes('Terminal')));
  const configure=view.find(n=>n.type==='button'&&[].concat(n.props.children).includes('Open plugin settings'));
  assert.ok(configure);
  configure.props.onClick();await hub.flush();await view.flush();
  assert.equal(opened,1);assert.equal(selected,0);
  timeout();await hub.flush();await view.flush();
  assert.equal(hub.tree.props.ref.current.open,true);
  const retry=await client.mount(hub.find(n=>n.type?.name==='Plugins').props,hub.find(n=>n.type?.name==='Plugins').type).flush();
  assert.ok(retry.find(n=>n.props.role==='alert'));
  ready=true;retry.find(n=>n.type==='button'&&[].concat(n.props.children).includes('Open plugin settings')).props.onClick();await hub.flush();
  assert.equal(selected,1);assert.equal(hub.tree.props.ref.current.open,false);
  assert.equal(timeout,null);assert.equal(observe,null);
  [nav,hub,view,retry].forEach(x=>x.unmount());
});

test('leaving a pending Plugins request cancels the delayed navigation',async()=>{
  let timeout,disconnected=false;
  const client=fixture('sidebar.footer.action',{globals:{document:{getElementById:()=>({}),body:{},querySelector:()=>({getAttribute:()=>false,click(){}}),querySelectorAll:()=>[]},
    setTimeout(fn){timeout=fn;return 1},clearTimeout(){timeout=null},MutationObserver:class{observe(){}disconnect(){disconnected=true}}}});
  const nav=await client.mount({}).flush();
  const hub=await client.mount({},client.registrations.find(row=>row.meta.id==='workspace-hub').view).flush();
  nav.find(n=>n.props['aria-label']==='Scheduled').props.onClick();await hub.flush();
  hub.find(n=>n.type==='button'&&[].concat(n.props.children).includes('Plugins')).props.onClick();await hub.flush();
  const page=await client.mount(hub.find(n=>n.type?.name==='Plugins').props,hub.find(n=>n.type?.name==='Plugins').type).flush();
  page.find(n=>n.type==='button'&&[].concat(n.props.children).includes('Open plugin settings')).props.onClick();
  assert.ok(timeout);
  nav.find(n=>n.props['aria-label']==='Scheduled').props.onClick();await nav.flush();
  assert.equal(timeout,null);assert.equal(disconnected,true);
  assert.equal(nav.find(n=>n.props['aria-label']==='Scheduled').props['aria-expanded'],true);page.unmount();nav.unmount();hub.unmount();
});

test('pull requests refreshes workspace membership and preserves an explicitly selected project',async()=>{
  let roots=[{id:'a',path:'/a'},{id:'b',path:'/b'}];const calls=[];
  const client=fixture('sidebar.footer.action',{fetcher:async url=>{calls.push(url);return{ok:true,json:async()=>url==='/dsh-files/roots'?{roots}:{items:[],git:null,repository:null,issue:'not-repository',unavailable:'Not a repository'}}}});
  const nav=await client.mount({}).flush();nav.find(n=>n.props['aria-label']==='Pull requests').props.onClick();
  const hub=await client.mount({},client.registrations.find(row=>row.meta.id==='workspace-hub').view).flush();
  const page=hub.find(n=>n.type?.name==='PullRequests');
  let view=await client.mount(page.props,page.type).flush();
  view.find(n=>n.type==='select'&&n.props.value==='/a').props.onChange({target:{value:'/b'}});await view.flush();
  assert.ok(calls.some(url=>url.includes('root=%2Fb')));
  view.unmount();view=await client.mount(page.props,page.type).flush();
  assert.ok(view.find(n=>n.type==='select'&&n.props.value==='/b'));
  roots=[{id:'a',path:'/a'}];
  view.find(n=>n.type==='button'&&n.props.children.includes('Refresh')).props.onClick();await view.flush();
  assert.ok(view.find(n=>n.type==='select'&&n.props.value==='/a'));
  assert.equal(calls.filter(url=>url==='/dsh-files/roots').length,3);
  assert.ok(view.find(n=>n.type?.name==='Empty'&&n.props.title==='Git needs attention'));
  [nav,hub,view].forEach(x=>x.unmount());
});
