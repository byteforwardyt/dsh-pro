const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');

const account={provider:'fixture',key:'fixture',label:'Fixture',configured:false,inFlight:false,methods:[{id:'browser',label:'Browser'}]};
const state=(revision,extra={})=>({type:'state',revision,accounts:[account],live:[],...extra});
function setup(t) {
  const streams=[],timers=new Map(),posts=[];let next=0;
  class EventSource {
    constructor(){streams.push(this)}
    close(){this.closed=true}
    send(message){this.onmessage?.({data:JSON.stringify(message)})}
  }
  const client=loadClient('client-ui-accounts',async(url,init)=>{posts.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>({})}},{slot:'settings.section',globals:{
    EventSource,setTimeout(fn){const id=++next;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},
  }});
  const instance=client.mount();t.after(()=>instance.unmount());
  return {instance,streams,client,posts,reconnect(){const [id,fn]=timers.entries().next().value;timers.delete(id);fn()}};
}
const card=instance=>instance.find(n=>n.type?.name==='Card')?.props;

test('older account snapshots cannot overwrite newer account or prompt events',async t=>{
  const {instance,streams}=setup(t);await instance.flush();
  streams[0].send(state(5,{accounts:[{...account,configured:true}]}));await instance.flush();
  streams[0].send(state(4));await instance.flush();
  assert.equal(card(instance).account.configured,true);
  streams[0].send({type:'prompt',revision:7,key:'fixture',prompt:{id:1,message:'Current prompt'}});await instance.flush();
  streams[0].send(state(6));await instance.flush();
  assert.equal(card(instance).live.prompt.id,1);
})

test('a full snapshot clears obsolete prompts and notices instead of resurrecting them',async t=>{
  const {instance,streams}=setup(t);await instance.flush();
  streams[0].send(state(1,{live:[{key:'fixture',notices:[{message:'Old notice'}],prompt:{id:1,message:'Old prompt'}}]}));await instance.flush();
  streams[0].send(state(2,{live:[{key:'fixture',notices:[],prompt:null}]}));await instance.flush();
  assert.equal(card(instance).live.prompt,null);assert.equal(card(instance).live.notices.length,0);
})

test('late messages from a closed stream cannot change a replacement connection',async t=>{
  const app=setup(t);await app.instance.flush();
  app.streams[0].send(state(9));await app.instance.flush();
  app.streams[0].onerror();app.reconnect();
  app.streams[1].send(state(0,{accounts:[{...account,configured:true}]}));await app.instance.flush();
  app.streams[0].send(state(10));await app.instance.flush();
  assert.equal(card(app.instance).account.configured,true);
  app.instance.unmount();app.instance.dirty=false;
  app.streams[1].send(state(11));
  assert.equal(app.instance.dirty,false,'disposed connection must not set component state');
})

test('legacy state without revision remains supported',async t=>{
  const {instance,streams}=setup(t);await instance.flush();
  streams[0].send({type:'state',accounts:[account]});await instance.flush();
  assert.equal(card(instance).account.provider,'fixture');
})

test('malformed snapshot shapes cannot advance the accepted revision or break rendering',async t=>{
  const {instance,streams}=setup(t);await instance.flush();
  streams[0].send(state(1));await instance.flush();
  streams[0].send(state(99,{accounts:[null]}));
  streams[0].send(state(2,{accounts:[{...account,configured:true}]}));await instance.flush();
  assert.equal(card(instance).account.configured,true);
})

test('stream failures exhaust bounded retries while preserving the last successful account state',async t=>{
  const app=setup(t);await app.instance.flush();
  app.streams[0].send(state(1,{accounts:[{...account,configured:true}]}));await app.instance.flush();
  for(let i=0;i<4;i++){app.streams.at(-1).onerror();app.reconnect()}
  app.streams.at(-1).onerror();await app.instance.flush();
  assert.equal(app.streams.length,5)
  assert.equal(card(app.instance).account.configured,true)
  const lost=app.instance.find(n=>n.type?.name==='StreamLost');assert.equal(lost.props.stale,true)
  lost.props.retry();await app.instance.flush();
  app.streams.at(-1).send(state(0));await app.instance.flush();
  assert.equal(card(app.instance).account.configured,false)
  assert.equal(app.instance.find(n=>n.type?.name==='StreamLost'),undefined)
})


test('cancel from a reopened account card carries the current snapshot attempt id',async t=>{
  const app=setup(t);await app.instance.flush();
  app.streams[0].send(state(1,{live:[{key:'fixture',attemptId:'current',notices:[],prompt:null}]}));await app.instance.flush();
  const node=app.instance.find(n=>n.type?.name==='Card');
  const view=app.client.mount(node.props,node.type);t.after(()=>view.unmount());await view.flush();
  const cancel=view.find(n=>n.type==='button'&&n.props.children.includes('Cancel sign-in'));
  assert.ok(cancel);await cancel.props.onClick();
  assert.deepEqual(app.posts[0],{url:'/dsh-auth/cancel',body:{provider:'fixture',attemptId:'current'}});
})

test('replacement attempts ignore old callbacks and terminal events, including after completion',async t=>{
  const {instance,streams}=setup(t);await instance.flush();
  streams[0].send(state(1));
  streams[0].send({type:'attempt-started',revision:2,key:'fixture',attemptId:'old'});
  streams[0].send({type:'attempt-started',revision:3,key:'fixture',attemptId:'current'});
  for(const [offset,type] of ['notice','prompt','outcome','settled'].entries()){
    streams[0].send({type,revision:4+offset,key:'fixture',attemptId:'old',notice:{message:'Old'},prompt:{id:'old'},status:'failed',message:'Old failure'});
  }
  await instance.flush();
  assert.equal(card(instance).live.attemptId,'current');assert.equal(card(instance).live.busy,true);
  assert.equal(card(instance).live.notices.length,0);assert.equal(card(instance).live.prompt,null);assert.equal(card(instance).outcome,null);
  streams[0].send({type:'outcome',revision:8,key:'fixture',attemptId:'current',status:'failed',message:'Could not start'});
  streams[0].send({type:'settled',revision:9,key:'fixture',attemptId:'current'});
  streams[0].send({type:'notice',revision:10,key:'fixture',attemptId:'current',notice:{message:'Late'}});
  await instance.flush();
  assert.equal(card(instance).live,undefined);assert.equal(card(instance).outcome.message,'Could not start');
})
