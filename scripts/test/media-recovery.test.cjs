const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');

async function fixture(t,fetcher,create=async()=>{}) {
 const client=loadClient('client-ui-media',fetcher,{globals:{setTimeout,clearTimeout},context:{
  uiConversation:{events:{register(){}}},conversation:{blocks:{}},workspaces:{create},
 }});
 const slot=client.registrations.find(row=>row.meta.name==='conversation.chat.turnTail');
 const output=await client.mount({turn:{data:new Map([['desktop-media',{paths:[{path:'/project/clip.mp4',seq:1}]}]])},seq:1,sessionId:'one',useSessions:select=>select({byId:{one:{cwd:'/project'}}}),...slot.meta.inject?.()},slot.view).flush();
 const card=output.find(n=>n.props.path==='/project/clip.mp4'&&typeof n.type==='function');
 const view=await client.mount(card.props,card.type).flush();
 t.after(()=>{view.unmount();output.unmount()});
 return {view,props:card.props};
}
const button=(view,label)=>view.find(n=>n.type==='button'&&n.props.children.includes(label));
const status=view=>view.find(n=>n.props.role==='status')?.props.children.join('');

test('denied media reopens only its displayed workspace after a user action and retries',async t=>{
 let opened=false;const calls=[],creates=[];
 const {view}=await fixture(t,async(url,options)=>{calls.push({url,options});return {ok:opened,status:opened?200:403}},async input=>{creates.push(input);opened=true});
 assert.match(status(view),/workspace.*closed|not open/i);
 assert.equal(view.find(n=>n.type==='video'),undefined);
 assert.equal(view.find(n=>n.type==='a'),undefined,'a denied URL must not be offered as a working download');
 assert.equal(creates.length,0,'rendering a reference never grants workspace access');
 await button(view,'Reopen workspace').props.onClick();await view.flush();
 assert.equal(creates.length,1);assert.equal(creates[0].path,'/project');
 assert.ok(view.find(n=>n.type==='video'));
 assert.ok(calls.every(c=>c.options.method==='HEAD'&&c.options.credentials==='same-origin'));
});

test('missing files and server failures have accurate retryable errors',async t=>{
 const missing=await fixture(t,async()=>({ok:false,status:404}));
 assert.match(status(missing.view),/moved|deleted|not found/i);
 assert.equal(missing.view.find(n=>n.type==='a'),undefined);
 assert.ok(button(missing.view,'Retry'));
 const failed=await fixture(t,async()=>{throw Error('Network disconnected')});
 assert.match(status(failed.view),/connect|unavailable|load/i);
 assert.doesNotMatch(status(failed.view),/codec/i);
});

test('decoder failure retains download and retry restores the player',async t=>{
 const {view}=await fixture(t,async()=>({ok:true,status:200}));
 view.find(n=>n.type==='video').props.onError();await view.flush();
 assert.match(status(view),/preview|play/i);assert.ok(view.find(n=>n.type==='a'));
 button(view,'Retry').props.onClick();await view.flush();
 assert.ok(view.find(n=>n.type==='video'));
});

test('path changes abort availability reads and ignore old errors',async t=>{
 let release,oldSignal;
 const {view,props}=await fixture(t,(url,options)=>url.includes('clip.mp4')?new Promise(resolve=>{release=resolve;oldSignal=options.signal}):Promise.resolve({ok:true,status:200}));
 await view.setProps({...props,path:'/project/new.mp4'}).flush();
 assert.equal(oldSignal.aborted,true);
 release({ok:false,status:403});await view.flush();
 assert.match(view.find(n=>n.type==='video').props.src,/new.mp4/);
 assert.equal(button(view,'Reopen workspace'),undefined);
});

test('one image opens a larger view inside chat, with duplicate paths removed',async t=>{
 const client=loadClient('client-ui-media',async()=>({ok:true,status:200}),{globals:{setTimeout,clearTimeout},context:{
  uiConversation:{events:{register(){}}},conversation:{blocks:{}},workspaces:{create:async()=>{}},
 }});
 const slot=client.registrations.find(row=>row.meta.name==='conversation.chat.turnTail');
 const output=await client.mount({turn:{data:new Map([['desktop-media',{paths:['shots/game.png','/project/shots/game.png','/project/'].map(path=>({path,seq:1}))}]])},seq:1,sessionId:'one',
  useSessions:select=>select({byId:{one:{cwd:'/project'}}}),...slot.meta.inject?.()},slot.view).flush();
 t.after(()=>output.unmount());
 const cards=output.tree.props.children[0].props.children;
 assert.equal(cards.length,1);
 const view=await client.mount(cards[0].props,cards[0].type).flush();
 t.after(()=>view.unmount());
 const enlarge=view.find(n=>n.type==='button'&&n.props.className==='dshd-media-image-button');
 assert.ok(enlarge);
 enlarge.props.onClick();await output.flush();
 const dialog=output.find(n=>n.type==='dialog');
 assert.equal(dialog.props.ref.current.open,true);
 assert.equal(dialog.props.children[1].props.path,'/project/shots/game.png');
 dialog.props.children[0].props.onClick();await output.flush();
 assert.equal(dialog.props.ref.current.open,false);
});
