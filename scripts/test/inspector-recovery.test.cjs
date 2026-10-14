const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');

async function fixture(t,fetcher,create) {
 const root={clientWidth:1200,style:{setProperty(){},removeProperty(){}},appendChild(n){n.parentElement=this},querySelector(){return null},setAttribute(){},removeAttribute(){}};
 const document={head:{appendChild(){}},createElement(){return {style:{},remove(){}}}};
 const client=loadClient('client-ui-inspector',fetcher,{slot:'conversation.session.header.actions',
  globals:{document,setInterval,clearInterval},element:()=>({closest:()=>root}),
  modules:{'react-dom':{createPortal:node=>node},'@dsh-desktop/client-ui-theme-holo':{SessionMetrics:()=>null},
   '@dsh-desktop/client-ui-files':{FilesView:()=>null},'@dsh-desktop/client-ui-media':{references:()=>[]},'@dsh-desktop/development-setup':{SetupPanel:()=>null},'@dsh-desktop/computer-use':{ComputerUsePanel:()=>null,ComputerUseStatus:()=>null}},
  context:{sessions:{refreshProjections(){}},uiWorkspace:{openSession(){}},uiSession:{sessionStatus:{}},jobs:{state:{},watchRows:()=>()=>{}},workspaces:{create}},
 });
 const slot=client.registrations[0];
 const inspector=await client.mount({sessionId:'one',useJobs:s=>s({rows:{}}),useSessionStatus:s=>s(new Map()),useChat:s=>s({legacy:{nodes:[]}}),useSessions:s=>s({byId:{one:{cwd:'/project'}}}),...slot.meta.inject()},slot.view).flush();
 const node=inspector.find(n=>n.type?.name==='Git');
 const view=await client.mount(node.props,node.type).flush();
 t.after(()=>{view.unmount();inspector.unmount()});return view;
}
const button=(view,name)=>view.find(n=>n.type==='button'&&n.props.children.includes(name));
const closed={ok:false,status:403,json:async()=>({error:'Reopen this workspace folder to use Git.',code:'WORKSPACE_NOT_OPEN'})};
const state={ok:true,json:async()=>({branch:'main',branches:['main'],files:[],changed:0,unborn:true})};

test('Git recovery is wired to the workspace service and refreshes after an explicit reopen',async t=>{
 let opened=false;const creates=[];
 const view=await fixture(t,async()=>opened?state:closed,async input=>{creates.push(input);opened=true});
 assert.equal(creates.length,0);assert.ok(button(view,'Reopen workspace'));
 assert.ok(view.find(n=>n.props.children.includes('/project')),'show the path being reopened');
 await button(view,'Reopen workspace').props.onClick();await view.flush();
 assert.equal(creates.length,1);assert.equal(creates[0].path,'/project');
 assert.equal(button(view,'Reopen workspace'),undefined);
 assert.equal(view.find(n=>n.props['aria-label']==='Git branch').props.value,'main');
});

test('reopen failure remains visible and does not pretend Git is available',async t=>{
 const view=await fixture(t,async()=>closed,async()=>{throw Error('Folder is unavailable')});
 await button(view,'Reopen workspace').props.onClick();await view.flush();
 assert.ok(view.find(n=>n.props.role==='alert'&&n.props.children.includes('Folder is unavailable')));
 assert.ok(button(view,'Reopen workspace'));assert.equal(view.find(n=>n.props['aria-label']==='Git branch'),undefined);
});

test('ordinary Git failures never offer an access-expanding recovery action',async t=>{
 const view=await fixture(t,async()=>({ok:false,status:422,json:async()=>({error:'This workspace is not a Git repository.'})}),async()=>{throw Error('must not reopen')});
 assert.equal(button(view,'Reopen workspace'),undefined);
});

test('a folder that is not a Git repository can be initialized without reopening',async t=>{
 const inits=[];
 let ready=false;
 const view=await fixture(t,async(url,options)=>{
  if (options?.method==='POST') {
   inits.push(JSON.parse(options.body));
   ready=true;
   return state;
  }
  return ready?state:{ok:false,status:422,json:async()=>({error:'This workspace is not a Git repository.',code:'NOT_A_GIT_REPOSITORY'})};
 },async()=>{throw Error('must not reopen')});
 assert.equal(button(view,'Reopen workspace'),undefined);
 assert.ok(button(view,'Create Git repository'));
 await button(view,'Create Git repository').props.onClick();
 await view.flush();
 assert.equal(inits.length,1);
 assert.equal(inits[0].action,'init');
 assert.equal(inits[0].root,'/project');
 assert.equal(view.find(n=>n.props['aria-label']==='Git branch').props.value,'main');
});
