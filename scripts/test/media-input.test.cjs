const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
function setup(fetcher){
 let helpers,definition,block;
 const blocks={storeFor:()=>({getSnapshot:()=>block}),set:(_,value)=>{block=value}};
 const harness=loadClient('client-ui-media',fetcher,{slot:'conversation.input.left',context:{uiConversation:{events:{register(value){definition=value}}},conversation:{blocks}},onModule:value=>{helpers=value},element:()=>({closest:()=>null})});
 return {harness,blocks,helpers,definition,block:()=>block};
}
test('media references decode filenames, reject remote paths and preserve unsupported-file fallback',()=>{
 const f=setup();
 assert.deepEqual([...f.helpers.references('[clip](</tmp/a%20%3Cclip%3E.mp4>) ![external](https://example.com/a.jpg) [remote](//server/a.mp3)')],['/tmp/a <clip>.mp4']);
 assert.equal(f.helpers.draftReferences('[Attachment: hello](</tmp/a%20b.mp3>)')[0].path,'/tmp/a b.mp3');
 assert.equal(f.helpers.draftReferences('`/tmp/script.py`').length,0);
 assert.deepEqual([...f.helpers.references('`output/finished.mp4` `script.py` [audio](sounds/demo.mp3)')],['output/finished.mp4','sounds/demo.mp3']);
 assert.equal(f.helpers.family('/tmp/archive.zip'),'file');
 assert.equal(f.helpers.family('/tmp/music.MP3'),'audio');
 const start={event:{type:'turn/start',data:{turn:1}}};
 const state=f.definition.start({},start);
 const next=f.definition.update({state},{event:{type:'assistant/message',seq:8,data:{message:{content:[{type:'text',text:'[video](</tmp/demo.mp4>)'}]}}}});
 const location=f.definition.buildLocationData({state:next},'turn');
 const owner={seq:8,turn:{data:new Map([[location.key,location.value]])}};
 assert.deepEqual([...f.helpers.selectMedia(owner)],['/tmp/demo.mp4']);
 assert.equal(f.helpers.selectMedia({...owner,seq:7}),null);
});
test('multiple uploads preserve draft and previous attachments; composer unblocks on success',async()=>{
 const f=setup(async url=>({ok:true,json:async()=>({path:'/tmp/work/.dsh-attachments/id/'+new URL(url,'http://localhost').searchParams.get('name')})}));
 let draft='Please review';
 const component=f.harness.mount({sessionId:'task',useSessions:fn=>fn({byId:{task:{cwd:'/tmp/work'}}}),useInput:fn=>fn({draft}),inputActions:{setDraft(value){draft=value}},blocks:f.blocks});
 await component.flush();
 component.find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[{name:'one.mp4',size:20},{name:'two.mp3',size:20}],value:'x'}});
 assert.match(f.block().reason,/Uploading/);
 await component.flush();
 assert.match(draft,/Please review/);assert.match(draft,/one.mp4/);assert.match(draft,/two.mp3/);
 assert.equal(f.block(),undefined);component.unmount();
});
test('cancelled upload and workspace switch never append a late attachment',async()=>{
 let release;
 const f=setup(()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>({path:'/tmp/old/file.mp3'})})}));
 let draft='Original';
 const props={sessionId:'task',useSessions:fn=>fn({byId:{task:{cwd:'/tmp/old'}}}),useInput:fn=>fn({draft}),inputActions:{setDraft(value){draft=value}},blocks:f.blocks};
 const c=f.harness.mount(props);await c.flush();
 c.find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[{name:'file.mp3',size:20}],value:'x'}});
 c.setProps({...props,useSessions:fn=>fn({byId:{task:{cwd:'/tmp/new'}}})});await c.flush();release();await c.flush();
 assert.equal(draft,'Original');assert.equal(f.block(),undefined);c.unmount();
});
