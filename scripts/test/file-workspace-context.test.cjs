const {test}=require('node:test');const assert=require('node:assert/strict');const {loadClient}=require('./helpers/client-harness.cjs');
test('Files follows the conversation workspace, preserves manual choice on refresh, and responds to late metadata',async()=>{
 const calls=[];let cwd='/project';const client=loadClient('client-ui-files',async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/roots')?{roots:[{path:'/empty',title:'Default'},{path:'/project',title:'Project'}]}:{entries:[]}}},{storage:new Map([['dshd.files.root','/empty']])});
 const props={sessionId:'one',useSessions:select=>select({byId:{one:{cwd},two:{cwd:'/empty'}}})};const view=await client.mount(props).flush();
 const root=()=>view.find(n=>n.type==='select');assert.equal(root().props.value,'/project');assert.ok(calls.includes('/dsh-files/list?path=%2Fproject'));
 root().props.onChange({target:{value:'/empty'}});await view.flush();view.find(n=>n.type==='button'&&n.props.children.includes('Refresh')).props.onClick();await view.flush();assert.equal(root().props.value,'/empty');
 await view.setProps({...props,sessionId:'two'}).flush();assert.equal(root().props.value,'/empty');
 cwd=undefined;await view.setProps(props).flush();assert.equal(root().props.value,'/empty');cwd='/project';await view.setProps({...props}).flush();assert.equal(root().props.value,'/project');view.unmount();
});
