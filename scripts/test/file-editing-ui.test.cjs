const {test}=require('node:test');
const assert=require('node:assert/strict');
const {loadClient}=require('./helpers/client-harness.cjs');
const response=payload=>({ok:true,json:async()=>payload});
const nodes=tree=>{if(!tree||typeof tree!=='object')return[];return[tree,...(tree.props?.children||[]).flatMap(nodes)];};
const button=(instance,label)=>instance.find(n=>n.type==='button'&&(n.props.children.includes(label)||n.props['aria-label']===label));

// Stand-in for the private highlighter primitive, which is absent under test.
// It is never invoked — what matters is which text reaches it, and whether a
// keystroke hands the overlay the same element twice.
const Highlighter=props=>({type:'pre',props:{children:[props.code]}});
const primitives={CodeBlock:Highlighter};

// One file on a fixture disk that keeps a version, so a save advances the
// baseline exactly as the host's guarded write does — the difference between a
// second save working and a false "changed on disk".
async function fixture(seed='const a = 1;\nconst b = 2;\n',modules){
  const disk={text:seed,version:'v1'};
  const writes=[];
  // The only thing in this view that schedules work is the overlay's settle
  // pass, so counting timers is enough to see whether one was deferred.
  const timers={set:0};
  const client=loadClient('client-ui-files',async(url,init)=>{
    if(url.endsWith('/roots'))return response({roots:[{path:'/workspace',title:'Fixture'}]});
    if(url.includes('/list?'))return response({entries:[{name:'app.js',path:'/workspace/app.js',isDirectory:false,size:disk.text.length}]});
    if(url.includes('/draft?'))return response({draft:null});
    if(url.endsWith('/draft'))return response({revision:'r1'});
    if(url.includes('/read?'))return response({kind:'text',path:'/workspace/app.js',text:disk.text,version:disk.version,size:disk.text.length});
    if(url.endsWith('/write')){
      const body=JSON.parse(init.body);writes.push(body);
      if(body.version!==undefined&&body.version!==disk.version)
        return {ok:false,status:409,json:async()=>({error:'changed on disk',code:'FS_STALE_VERSION'})};
      disk.text=body.text;disk.version='v'+(Number(disk.version.slice(1))+1);
      return response({version:disk.version,operation:'replace'});
    }
    throw Error(url);
  },{modules:modules&&{'@deepseek-ai/dsh-client-ui-primitives':modules},
    globals:{setTimeout:(fn,ms)=>{timers.set++;return setTimeout(fn,ms);},clearTimeout}});
  const parent=await client.mount().flush();
  await parent.find(n=>n.type?.name==='TreeLevel').props.onOpen({name:'app.js',path:'/workspace/app.js'});
  await parent.flush();
  const viewerEl=()=>parent.find(n=>n.type?.name==='Viewer');
  const viewer=await client.mount(viewerEl().props,viewerEl().type).flush();
  const editorEl=()=>viewer.find(n=>n.type?.name==='EditorPane');
  const editor=await client.mount(editorEl().props,editorEl().type).flush();
  const sync=async()=>{
    await parent.flush();
    await viewer.setProps(viewerEl().props).flush();
    const pane=editorEl();
    if(pane)await editor.setProps(pane.props).flush();
  };
  return {client,parent,viewer,editor,disk,writes,timers,sync,viewerEl,
    field(){return editor.find(n=>n.type==='textarea');},
    async type(value){this.field().props.onChange({target:{value}});await sync();},
    footer(){return nodes(editor.tree).find(n=>n.props?.className?.startsWith('dshd-fl-state'))?.props.children;},
    overlay(){return nodes(editor.tree).find(n=>n.props?.className?.startsWith('dshd-fl-syntax'));},
    lagging(){return Boolean(this.overlay()?.props.className.includes('is-lagging'));},
    coloured(){return nodes(editor.tree).some(n=>n.props?.className?.includes('is-highlighted'));},
    handed(){return nodes(editor.tree).find(n=>n.type===Highlighter);},
    status(){return nodes(editor.tree).filter(n=>n.type==='span').flatMap(n=>n.props.children).filter(c=>typeof c==='string');},
    async settle(){await new Promise(r=>setTimeout(r,220));await sync();},
    note(){return nodes(parent.tree).find(n=>n.props?.className?.includes('dshd-fl-note'));},
    async press(event){const key={metaKey:true,key:'s',preventDefault(){key.prevented=true;},stopPropagation(){},...event};
      editor.tree.props.onKeyDown(key);await sync();return key;},
    async pressOutside(event){const key={metaKey:true,key:'s',preventDefault(){key.prevented=true;},...event};
      client.document.dispatch('keydown',key);await sync();return key;},
    close(){editor.unmount();viewer.unmount();parent.unmount();}};
}

test('a text file opens ready to type and writes what was typed',async t=>{
  const f=await fixture();t.after(()=>f.close());
  assert.equal(f.viewerEl().props.mode,'edit');
  assert.ok(f.field(),'the field is there without a second click');
  assert.equal(f.footer(),undefined,'a clean file reports nothing');

  await f.type('const a = 99;\nconst b = 2;\n');
  assert.equal(button(f.parent,'Save changes').props.disabled,false);
  assert.match(String(f.footer()),/Unsaved/);

  button(f.parent,'Save changes').props.onClick();await f.sync();
  assert.deepEqual(f.writes,[{path:'/workspace/app.js',text:'const a = 99;\nconst b = 2;\n',version:'v1'}]);
  assert.equal(f.disk.text,'const a = 99;\nconst b = 2;\n');
  assert.equal(f.footer(),undefined,'a saved file goes quiet again');
});

test('a second save follows the version the first one produced',async t=>{
  const f=await fixture();t.after(()=>f.close());
  await f.type('one\n');
  assert.equal((await f.press()).prevented,true);
  await f.type('two\n');
  await f.press();
  assert.deepEqual(f.writes.map(w=>[w.text,w.version]),[['one\n','v1'],['two\n','v2']]);
  assert.equal(f.disk.text,'two\n');
  assert.equal(f.note(),undefined,'a save that worked says so in the toolbar, not in a banner');
});

test('the shortcut still saves once when focus has left the view',async t=>{
  const f=await fixture();t.after(()=>f.close());
  await f.type('typed elsewhere\n');
  assert.equal((await f.pressOutside()).prevented,true);
  assert.equal(f.writes.length,1);
  assert.equal(f.disk.text,'typed elsewhere\n');

  // One press that the view's own handler already served must not be served a
  // second time on its way past the document, or the second write meets a
  // version the first one just replaced.
  await f.type('and again\n');
  const key={metaKey:true,key:'s',preventDefault(){},stopPropagation(){}};
  f.editor.tree.props.onKeyDown(key);
  f.client.document.dispatch('keydown',key);
  await f.sync();
  assert.equal(f.writes.length,2);
});

test('a clean file leaves the shortcut to the shell',async t=>{
  const f=await fixture();t.after(()=>f.close());
  // The in-view handler is bound on the whole pane, not on the field, so a
  // clean file has to let the press past it as well as past the document.
  assert.equal((await f.press()).prevented,undefined);
  assert.equal((await f.pressOutside()).prevented,undefined);
  assert.equal(f.writes.length,0);
});

test('a file rewritten underneath keeps the typed text and offers both ways out',async t=>{
  const f=await fixture();t.after(()=>f.close());
  f.disk.text='const a = 1;\n// the agent was here\n';f.disk.version='v9';
  await f.type('mine\n');
  button(f.parent,'Save changes').props.onClick();await f.sync();

  const note=f.note();
  assert.match(String(note.props.children[0].props.children),/changed on disk/);
  assert.ok(button(f.parent,'Discard draft & reload'));
  assert.ok(button(f.parent,'Overwrite disk file'));
  assert.equal(f.field().props.value,'mine\n','the typed text is still in the editor');
  assert.equal(f.disk.text,'const a = 1;\n// the agent was here\n');

  button(f.parent,'Overwrite disk file').props.onClick();await f.sync();
  assert.equal(f.disk.text,'mine\n');
  assert.equal(f.writes.at(-1).version,undefined,'overwriting drops the guard deliberately');
});

test('the toolbar marks keep the names the keyboard and screen reader use',async t=>{
  const f=await fixture();t.after(()=>f.close());
  for(const label of ['Toggle file explorer','Find file','Find in file','Reload','Copy','Recover drafts'])
    assert.ok(button(f.parent,label),label+' is still reachable by name');
});

test('a small file is still coloured on the keystroke',async t=>{
  const f=await fixture('const a = 1;\n',primitives);t.after(()=>f.close());
  await f.type('const a = 2;\n');
  assert.equal(f.lagging(),false,'nothing to defer at this size');
  assert.equal(f.coloured(),true);
  assert.equal(f.handed().props.code,'const a = 2;\n\n');
});

test('a file past the sync size colours after the typing stops, not during it',async t=>{
  const f=await fixture('const x = 1;\n'.repeat(400),primitives);t.after(()=>f.close());
  assert.ok(f.overlay(),'a colourable file gets an overlay');
  assert.equal(f.lagging(),false,'an untouched file is already settled');
  const before=f.handed();

  await f.type('const x = 2;\n'+'const x = 1;\n'.repeat(399));
  // Retokenising 5kB per key is what made the field lag, so the keystroke has
  // to be handed the element it already had — an unchanged child is the skip.
  assert.ok(Object.is(f.handed(),before),'the keystroke never reached the highlighter');
  // And the colours it is still holding describe the previous text, so they are
  // hidden rather than left over transparent text and read as the file.
  assert.equal(f.lagging(),true);
  assert.equal(f.coloured(),false,'the field shows its own uncoloured text meanwhile');

  await f.settle();
  assert.equal(f.lagging(),false);
  assert.equal(f.coloured(),true);
  assert.match(f.handed().props.code,/^const x = 2;/);
});

test('a file past the colouring limit gets no overlay and says why',async t=>{
  const f=await fixture('const x = 1;\n'.repeat(6000),primitives);t.after(()=>f.close());
  assert.equal(f.overlay(),undefined,'nothing to compute and nothing to hide');
  assert.equal(f.handed(),undefined);
  assert.ok(f.status().includes('Large file · syntax colors paused'));
  assert.ok(f.field(),'it is still an editable file');

  await f.type('const x = 2;\n'+'const x = 1;\n'.repeat(5999));
  assert.equal(f.handed(),undefined,'and typing does not quietly start colouring it');
});

test('a file with no highlighter behind it defers nothing',async t=>{
  // The primitive is a private harness table that may be renamed or absent, so
  // the uncoloured fallback is the path that will run one day. It has no
  // overlay to feed, and deferring a copy nothing reads would still cost a
  // timer and a re-render on every keystroke.
  const f=await fixture();t.after(()=>f.close());
  assert.equal(f.overlay(),undefined,'no primitive, no overlay');
  await f.type('const a = 2;\n');
  assert.equal(f.timers.set,0);
});
