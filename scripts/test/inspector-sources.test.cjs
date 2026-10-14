const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');

// References are resolved against the session folder, so the list has to survive a
// directory entry, the same file recorded twice, and a path with no segment to show.
// A row exists to open a file: a reference that names no file earns no row, and with
// no rows left there is no list for the heading to label.
async function fixture(t,found) {
 const root={clientWidth:1200,style:{setProperty(){},removeProperty(){}},appendChild(n){n.parentElement=this},querySelector(){return null},setAttribute(){},removeAttribute(){}};
 const document={head:{appendChild(){}},createElement(){return {style:{},remove(){}}}};
 const client=loadClient('client-ui-inspector',async()=>({ok:true,json:async()=>({branch:'main',branches:['main'],files:[],changed:0,unborn:true})}),{slot:'conversation.session.header.actions',
  globals:{document,setInterval,clearInterval},element:()=>({closest:()=>root}),
  modules:{'react-dom':{createPortal:node=>node},'@dsh-desktop/client-ui-theme-holo':{SessionMetrics:()=>null},
   '@dsh-desktop/client-ui-files':{FilesView:()=>null},'@dsh-desktop/client-ui-media':{references:()=>found},'@dsh-desktop/development-setup':{SetupPanel:()=>null},'@dsh-desktop/computer-use':{ComputerUsePanel:()=>null,ComputerUseStatus:()=>null}},
  context:{sessions:{refreshProjections(){}},uiWorkspace:{openSession(){}},uiSession:{sessionStatus:{}},jobs:{state:{},watchRows:()=>()=>{}},workspaces:{create(){}}},
 });
 const slot=client.registrations[0];
 const view=await client.mount({sessionId:'one',useJobs:s=>s({rows:{}}),useSessionStatus:s=>s(new Map()),useChat:s=>s({legacy:{nodes:[{blocks:[{kind:'text',text:'produced output'}]}]}}),
  useSessions:s=>s({byId:{one:{cwd:'/project'}}}),...slot.meta.inject()},slot.view).flush();
 t.after(()=>view.unmount());return view;
}
const rows=view=>{const out=[];view.find(n=>{if(n.type==='button'&&n.props.className==='row'&&n.props.title)out.push(n);return false});return out};
const label=row=>row.props.children.find(c=>c.type==='span').props.children.join('');
const heading=view=>view.find(n=>n.type==='h3'&&n.props.children.includes('Sources & files'));
const browse=view=>view.find(n=>n.type==='button'&&n.props.children.some(c=>c.props?.children?.includes?.('Browse workspace files')));

test('a directory reference is dropped instead of rendering a row that opens nothing',async t=>{
 const view=await fixture(t,['/tmp/','/project/notes.md']);
 assert.deepEqual(rows(view).map(label),['notes.md']);
 assert.deepEqual(rows(view).map(r=>r.props.title),['/project/notes.md'],'the full path stays in the tooltip');
 assert.ok(heading(view),'a real source still earns the heading');
});

test('the same file recorded twice is one row',async t=>{
 const view=await fixture(t,['notes.md','/project/notes.md','notes.md']);
 assert.deepEqual(rows(view).map(r=>r.props.title),['/project/notes.md']);
 assert.deepEqual(rows(view).map(label),['notes.md']);
});

test('a path with no file segment produces no row at all',async t=>{
 const view=await fixture(t,['/']);
 assert.deepEqual(rows(view).map(label),[]);
});

test('with nothing to list the heading goes and the browse action stays',async t=>{
 const view=await fixture(t,[]);
 assert.deepEqual(rows(view),[]);
 assert.equal(heading(view),undefined,'a heading over a lone action labels something that is not there');
 assert.ok(browse(view),'browsing the workspace is still reachable');
});

test('compact sidebar shows three sources and keeps secondary controls collapsed',async t=>{
 const view=await fixture(t,['one.png','two.png','three.png','four.png']);
 assert.equal(rows(view).length,3);
 assert.ok(view.find(n=>n.type==='button'&&n.props.children.some(c=>c.props?.children?.includes?.('View all files'))));
 for(const title of ['Session usage','Workspace tools']) {
  const details=view.find(n=>n.type==='details'&&n.props.children.some(c=>c.type==='summary'&&c.props.children.includes(title)));
  assert.ok(details,title);assert.ok(!details.props.open);
 }
});
