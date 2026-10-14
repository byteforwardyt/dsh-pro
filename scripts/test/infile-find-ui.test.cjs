const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const response=payload=>({ok:true,json:async()=>payload});
const button=(instance,label)=>instance.find(n=>n.type==='button'&&(n.props.children.includes(label)||n.props['aria-label']===label));
const field=(instance,label)=>instance.find(n=>n.props['aria-label']===label);
const checkbox=(instance,label)=>instance.find(n=>n.type==='label'&&n.props.children.includes(label)).props.children.find(n=>n.type==='input');
async function fixture(text,conflict=false,options={}) {
  const writes=[],backups=[];
  const client=loadClient('client-ui-files',async(url,init)=>{
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Fixture'}]});
    if(url.includes('/list?'))return response({entries:[]});
    if(url.includes('/draft?'))return response({draft:null});
    if(url.endsWith('/draft')){backups.push(JSON.parse(init.body));return response({revision:'backup'});}
    if(url.includes('/read?'))return response({kind:'text',path:'/workspace/file.txt',text,version:'original'});
    if(url.endsWith('/write')){writes.push(JSON.parse(init.body));return conflict?{ok:false,status:409,json:async()=>({code:'FS_STALE_VERSION',error:'changed'})}:response({version:'saved',operation:'replace'});}
    throw Error(url);
  },options);
  const parent=await client.mount().flush();
  await parent.find(n=>n.type?.name==='TreeLevel').props.onOpen({path:'/workspace/file.txt'});await parent.flush();
  button(parent,'Find in file').props.onClick();await parent.flush();
  const v=parent.find(n=>n.type?.name==='Viewer'),viewer=await client.mount(v.props,v.type).flush();
  const e=viewer.find(n=>n.type?.name==='EditorPane'),editor=await client.mount(e.props,e.type).flush();
  async function sync(){await parent.flush();await viewer.setProps(parent.find(n=>n.type?.name==='Viewer').props).flush();await editor.setProps(viewer.find(n=>n.type?.name==='EditorPane').props).flush();}
  async function query(value){field(editor,'Find text').props.onChange({target:{value}});await editor.flush();}
  async function replacement(value){if(!field(editor,'Replace with')){button(editor,'Replace').props.onClick();await editor.flush();}field(editor,'Replace with').props.onChange({target:{value}});await editor.flush();}
  return {parent,editor,writes,backups,sync,query,replacement,get draft(){return field(editor,'Contents of file.txt').props.value},
    status(value){return !!editor.find(n=>n.props.role==='status'&&n.props.children.includes(value));},close(){editor.unmount();viewer.unmount();parent.unmount();}};
}

test('in-file find handles literal syntax, case, whole words, and wrapped navigation',async t=>{
  const f=await fixture('foo Foo food caféfoo foo [a+b] [a+b]');t.after(f.close);
  await f.query('foo');assert.ok(f.status('1 of 5 matches'));
  checkbox(f.editor,'Whole word').props.onChange({target:{checked:true}});await f.editor.flush();assert.ok(f.status('1 of 3 matches'));
  checkbox(f.editor,'Match case').props.onChange({target:{checked:true}});await f.editor.flush();assert.ok(f.status('1 of 2 matches'));
  button(f.editor,'Previous match').props.onClick();await f.editor.flush();assert.ok(f.status('2 of 2 matches'));
  button(f.editor,'Next match').props.onClick();await f.editor.flush();assert.ok(f.status('1 of 2 matches'));
  await f.query('[a+b]');assert.ok(f.status('1 of 2 matches'));
  assert.equal(f.writes.length,0);assert.equal(f.backups.length,0);
});

test('replacement uses original Unicode offsets and whole-word boundaries include astral letters',async t=>{
  const f=await fixture('İ i 𐐀foo foo𐐀 foo');t.after(f.close);
  await f.query('i');await f.replacement('Z');button(f.editor,'Replace match').props.onClick();await f.sync();
  assert.equal(f.draft,'İ Z 𐐀foo foo𐐀 foo');
  await f.query('foo');checkbox(f.editor,'Whole word').props.onChange({target:{checked:true}});await f.editor.flush();
  assert.ok(f.status('1 of 1 match'));await f.replacement('bar');button(f.editor,'Replace all').props.onClick();await f.sync();
  assert.equal(f.draft,'İ Z 𐐀foo foo𐐀 bar');assert.equal(f.writes.length,0);
});

test('find scrolls to measured glyph positions and recomputes them when the editor resizes',async t=>{
  let onResize, selected;
  const f=await fixture('\t界needle',false,{
    globals:{ResizeObserver:class {constructor(callback){onResize=callback}observe(){}disconnect(){}}},
    element(type){return type==='pre'?{
      getBoundingClientRect:()=>({left:50,top:30}),
      querySelector:()=>({getBoundingClientRect:()=>({left:2050,top:430})}),
    }:type==='textarea'?{setSelectionRange(start,end){selected=[start,end]}}:{};},
  });t.after(f.close);
  await f.query('needle');
  const editor=field(f.editor,'Contents of file.txt').props.ref.current;
  const mirror=f.editor.find(n=>n.type==='pre'&&n.props.ref).props.ref.current;
  assert.deepEqual(selected,[2,8]);
  assert.equal(editor.scrollLeft,1700);assert.equal(editor.scrollTop,50);
  assert.equal(mirror.style.transform,'translate(-1700px,-50px)');
  editor.clientWidth=200;editor.clientHeight=120;onResize();
  assert.equal(editor.scrollLeft,1900);assert.equal(editor.scrollTop,340);
  assert.equal(mirror.style.transform,'translate(-1900px,-340px)');
});

test('typing with find open keeps the caret until explicit match navigation',async t=>{
  let selections=0;
  const f=await fixture('needle tail',false,{element:type=>type==='textarea'?{setSelectionRange(){selections++}}:{}});
  t.after(f.close);await f.query('needle');assert.ok(selections>0);selections=0;
  field(f.editor,'Contents of file.txt').props.onChange({target:{value:'needle! tail'}});await f.sync();
  assert.equal(selections,0);assert.equal(f.draft,'needle! tail');assert.ok(f.status('1 of 1 match'));
  button(f.editor,'Next match').props.onClick();await f.editor.flush();assert.ok(selections>0);
});

test('replace all treats dollar syntax literally, supports reverting, and cannot erase later typing',async t=>{
  const f=await fixture('a.b A.B a-b');t.after(f.close);
  await f.query('a.b');await f.replacement('$&');button(f.editor,'Replace all').props.onClick();await f.sync();
  assert.equal(f.draft,'$& $& a-b');assert.equal(f.writes.length,0);
  assert.equal(f.backups.at(-1).draft.text,'$& $& a-b');assert.equal(f.backups.at(-1).draft.base.version,'original');
  button(f.editor,'Revert last replacement').props.onClick();await f.sync();assert.equal(f.draft,'a.b A.B a-b');
  button(f.editor,'Replace all').props.onClick();await f.sync();
  field(f.editor,'Contents of file.txt').props.onChange({target:{value:'Typing after replacement'}});await f.sync();
  assert.equal(button(f.editor,'Revert last replacement').props.disabled,true);
  button(f.editor,'Revert last replacement').props.onClick();await f.sync();assert.equal(f.draft,'Typing after replacement');
});

test('oversized replacement is refused before updating the draft or its backup',async t=>{
  const original='a '.repeat(1024*1024),f=await fixture(original);t.after(f.close);
  await f.query('a');await f.replacement('longer');button(f.editor,'Replace all').props.onClick();await f.sync();
  assert.ok(f.editor.find(n=>n.props.role==='alert'));assert.equal(f.draft,original);assert.equal(f.backups.length,0);assert.equal(f.writes.length,0);
});

test('UTF-8 byte limits also reject replacements whose character count would fit',async t=>{
  const f=await fixture('a');t.after(f.close);await f.query('a');await f.replacement('🔥'.repeat(600000));
  button(f.editor,'Replace all').props.onClick();await f.sync();
  assert.ok(f.editor.find(n=>n.props.role==='alert'));assert.equal(f.draft,'a');assert.equal(f.backups.length,0);
});

test('replacement keeps the original save guard and keyboard shortcuts do not close the workspace',async t=>{
  const f=await fixture('old old',true);t.after(f.close);
  f.parent.tree.props.onKeyDown({ctrlKey:true,key:'h',preventDefault(){},stopPropagation(){}});await f.sync();
  assert.ok(field(f.editor,'Replace with'));
  await f.query('old');await f.replacement('new');button(f.editor,'Replace all').props.onClick();await f.sync();
  button(f.parent,'Save changes').props.onClick();await f.sync();
  assert.equal(f.writes[0].version,'original');assert.ok(button(f.parent,'Overwrite disk file'));assert.equal(f.draft,'new new');
  let stopped=false;f.editor.tree.props.onKeyDown({key:'Escape',preventDefault(){},stopPropagation(){stopped=true}});await f.editor.flush();
  assert.equal(stopped,true);assert.equal(field(f.editor,'Find text'),undefined);
});
