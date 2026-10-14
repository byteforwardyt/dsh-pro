const {test}=require('node:test');const assert=require('node:assert/strict');const {loadClient}=require('./helpers/client-harness.cjs');
const button=(view,text)=>view.find(n=>n.type==='button'&&n.props.children.includes(text));
test('phone page uses native status and real enable/disable responses',async()=>{
 const actions=[];const view=await loadClient('client-ui-phone',()=>{}, {desktopBridge:{phoneAccess:async action=>{actions.push(action);return {enabled:action==='enable',url:action==='enable'?'http://192.0.2.1:9000':undefined,code:'123456',qrSvg:'<svg/>'};}}}).mount().flush();
 assert.deepEqual(actions,['status']);button(view,'Turn on phone access').props.onClick();await view.flush();assert.ok(view.find(n=>n.props.className==='code'&&n.props.children.includes('123456')));
 button(view,'Turn off').props.onClick();await view.flush();assert.deepEqual(actions,['status','enable','disable']);assert.equal(view.find(n=>n.props.className==='code'),undefined);view.unmount();
});
test('bridge errors remain visible, retryable and cannot update an unmounted page',async()=>{
 let reject=false,finish;const view=await loadClient('client-ui-phone',()=>{}, {desktopBridge:{phoneAccess:async action=>{if(action==='status')return {enabled:false};if(reject)throw Error('private detail');return new Promise(resolve=>finish=resolve);}}}).mount().flush();
 reject=true;button(view,'Turn on phone access').props.onClick();await view.flush();assert.ok(view.find(n=>n.props.role==='alert'));assert.equal(button(view,'Turn on phone access').props.disabled,false);
 reject=false;button(view,'Turn on phone access').props.onClick();await view.flush();view.unmount();finish({enabled:true});await view.flush();assert.equal(button(view,'Turn off'),undefined);
});
