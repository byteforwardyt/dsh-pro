const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('hidden server controls continue reporting state and errors without starting work', async () => {
  const element = tag => ({tag, children:[], value:'', attributes:{},
    appendChild(node){this.children.push(node);}, setAttribute(key,value){this.attributes[key]=value;},
    replaceChildren(){this.children=[];}});
  const host=element('div'); host.hidden=true;
  const storage=new Map(), reports=[], requests=[], opened=[];
  let state={status:'stopped',url:'',error:''}, fail=false, tick, cleared=false;
  const window={};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../plugins/host-files-api/lib/preview-panel.js'),'utf8'), {
    window, document:{createElement:element}, AbortController,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
    setInterval:fn=>{tick=fn;return 1;},clearInterval:()=>{cleared=true;},
    fetch:async(url,options)=>{requests.push({url,options});if(fail)throw Error('Server connection unavailable');
      return {ok:true,json:async()=>state};},
  });
  const dispose=window.DshPreviewPanel(host,'chat-a','/workspace',url=>opened.push(url),value=>reports.push(value));
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  await flush();
  const all=node=>[node,...node.children.flatMap(all)];
  const button=name=>all(host).find(node=>node.tag==='button'&&node.textContent===name);
  const command=all(host).find(node=>node.attributes['aria-label']==='Launch command');
  assert.equal(host.hidden,true);
  assert.equal(button('Start').disabled,true);
  assert.equal(reports.at(-1).status,'stopped');
  assert.ok(requests.every(item=>!item.options.method),'mount and polling never start a server');
  command.value='npm run dev';command.oninput();
  assert.equal(button('Start').disabled,false);
  state={status:'starting',url:'',error:''};button('Start').onclick();await flush();
  assert.equal(JSON.parse(requests.find(item=>item.options.method==='POST').options.body).sessionId,'chat-a');
  assert.equal(button('Start').disabled,true);
  state={status:'ready',url:'http://127.0.0.1:57001/',error:''};await tick();
  assert.equal(reports.at(-1).status,'ready');assert.equal(host.hidden,true);
  assert.deepEqual(opened,[state.url]);
  await tick();assert.equal(opened.length,1,'polling must not repeatedly navigate the game');
  fail=true;await tick();
  assert.equal(reports.at(-1).error,'Server connection unavailable');
  fail=false;await tick();assert.equal(reports.at(-1).error,'');
  dispose();assert.equal(cleared,true);assert.equal(host.children.length,0);
  const count=requests.length;await tick();assert.equal(requests.length,count);
});
