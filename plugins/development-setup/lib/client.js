window.__ModuleLoader__.load({
  id:'@dsh-desktop/development-setup',
  factory:require => {
    const React = require('react'), {useState,useEffect,useRef} = React, h = React.createElement;
    const CSS = `
.dshd-setup{max-width:800px;display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.6}
.dshd-setup h2,.dshd-setup h3,.dshd-setup p{margin:0}.dshd-setup h2{font-size:22px}.dshd-setup h3{font-size:15px}
.dshd-setup p,.dshd-setup small{color:var(--dsw-alias-label-secondary)}
.dshd-setup section{display:flex;flex-direction:column;gap:8px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.dshd-setup .setup-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0;min-width:0}.dshd-setup .setup-row>div{min-width:0}.dshd-setup small{display:block;overflow-wrap:anywhere}
.dshd-setup button,.dshd-setup select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 12px;min-height:36px}
.dshd-setup button{cursor:pointer;flex-shrink:0}.dshd-setup button:disabled{opacity:.5;cursor:default}.dshd-setup button:focus-visible,.dshd-setup select:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.dshd-setup .setup-actions{display:flex;gap:8px;flex-wrap:wrap}.dshd-setup select{max-width:100%;min-width:0}.dshd-setup pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;margin:0;padding:12px;background:var(--dsw-alias-bg-layer-1);border-radius:8px;font-size:12px}.dshd-setup [role=alert]{color:var(--dshd-bad)}
`;
    const LABELS = {node:'Node.js',npm:'npm',pnpm:'pnpm',yarn:'Yarn',python3:'Python 3',python:'Python command',git:'Git'};
    function SetupPanel({initialRoot=null,embedded=false}) {
      const bridge=window.__DSH_DESKTOP__;
      const [root,setRoot]=useState(initialRoot),[state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[job,setJob]=useState(null),[choice,setChoice]=useState(''),[notice,setNotice]=useState('');
      const alive=useRef(false), sequence=useRef(0);
      async function check(selected=root) {
        if(!bridge?.developmentSetup)return;
        const seq=++sequence.current;setBusy(true);setError('');
        try {const value=await bridge.developmentSetup('check',{root:selected});if(alive.current&&seq===sequence.current){if(value.error)throw Error(value.error);setState(value);}}
        catch(e){if(alive.current&&seq===sequence.current)setError(e.message);}
        finally{if(alive.current&&seq===sequence.current)setBusy(false);}
      }
      useEffect(()=>{alive.current=true;check(root);bridge?.developmentSetup?.('status').then(value=>{if(alive.current&&value.state!=='idle')setJob(value);}).catch(()=>{});return()=>{alive.current=false;sequence.current++;};},[root]);
      useEffect(()=>{
        if(job?.state!=='running')return;
        const timer=setInterval(async()=>{
          try{const next=await bridge.developmentSetup('status');if(!alive.current)return;setJob(next);if(next.state!=='running'){await check();if(next.state==='complete')setNotice('Installation completed. Environment checked again.');}}
          catch(e){if(alive.current)setError(e.message);}
        },1000);
        return()=>clearInterval(timer);
      },[job?.state,root]);
      async function act(op,payload){
        setBusy(true);setError('');setNotice('');
        try{const next=await bridge.developmentSetup(op,{root,...payload});if(!alive.current)return;if(next.error)throw Error(next.error);if(next.state==='guided')setNotice(next.message);else setJob(next);}
        catch(e){if(alive.current)setError(e.message);}
        finally{if(alive.current)setBusy(false);}
      }
      const running=job?.state==='running', disabled=busy||running;
      const pythonReady=state?.tools.some(t=>t.id==='python3'&&t.installed);
      return h('div',{className:'dshd-setup','aria-busy':busy},
        !embedded && h('h2',null,'Development setup'),h('p',null,'Check the tools your agent and terminal can use, then install what this workspace needs.'),
        !bridge?.developmentSetup?h('p',{role:'alert'},'Open Development setup in the DSH PRO desktop app.'):null,
        h('div',{className:'setup-actions'},h('select',{'aria-label':'Setup workspace',value:root||'',disabled:running,onChange:e=>{setRoot(e.target.value||null);setChoice('');}},h('option',{value:''},'Development tools only'),...(state?.roots||[]).filter(r=>r.canonicalPath).map(r=>h('option',{key:r.id,value:r.canonicalPath},r.title||r.path))),h('button',{disabled,onClick:()=>check()},busy?'Checking…':'Check again')),
        error?h('p',{role:'alert'},error):null,notice?h('p',{role:'status'},notice):null,
        state?h('section',null,h('h3',null,'Included with DSH PRO'),h('p',null,state.bundled.join(' · ')),h('small',null,'Project runtimes, packages, and macOS permissions are separate.')):null,
        state?h('section',null,h('h3',null,'Development tools'),...state.tools.filter(t=>!(t.id==='python'&&pythonReady)).map(tool=>h('div',{className:'setup-row',key:tool.id},h('div',null,h('strong',null,LABELS[tool.id]),h('small',null,tool.installed?tool.version:tool.error||'Not found'),tool.installed?h('small',null,tool.command):null),!tool.installed?h('button',{disabled,onClick:()=>act(['pnpm','yarn'].includes(tool.id)?'install':'open-installer',['pnpm','yarn'].includes(tool.id)?{task:tool.id}:{tool:tool.id})},['pnpm','yarn'].includes(tool.id)?'Install':'Get installer'):null))):null,
        state?.project?h('section',null,h('h3',null,'Workspace packages'),h('small',null,state.project.root),
          state.project.js?h(React.Fragment,null,h('div',{className:'setup-row'},h('div',null,h('strong',null,'JavaScript'),h('small',null,!state.project.js.hasPackages?'No dependencies declared':state.project.js.installed?'node_modules exists · use Install / update to resolve this project’s packages':'Project packages need installation'),h('small',null,'Package manager: '+state.project.js.manager+(state.project.js.requestedVersion?' '+state.project.js.requestedVersion:'')+(state.project.js.nodeRequirement?' · Node '+state.project.js.nodeRequirement:''))),h('button',{disabled:disabled||state.project.js.unsupported||(state.project.js.ambiguous&&!choice),onClick:()=>act('install',{task:'javascript',choice})},'Install / update')),
            state.project.js.manager==='yarn' && Number(state.project.js.requestedVersion?.split('.')[0])>1 ? h('button',{disabled,onClick:()=>act('open-installer',{tool:'corepack'})},'Set up this Yarn version with Corepack') : null,
            state.project.js.unsupported?h('p',{role:'alert'},'Unsupported packageManager declaration. Follow this project’s setup instructions.'):null,
            state.project.js.ambiguous?h('label',null,'Conflicting package manager configuration ',h('select',{'aria-label':'Choose package manager',value:choice,onChange:e=>setChoice(e.target.value)},h('option',{value:''},'Choose a package manager'),...state.project.js.choices.map(m=>h('option',{key:m,value:m},m)))):null):null,
          state.project.python?h('div',{className:'setup-row'},h('div',null,h('strong',null,'Python'),h('small',null,state.project.python.environment?'Project .venv found':'A project .venv will be created'),h('small',null,state.project.python.command||'Python 3 is required')),h('button',{disabled,onClick:()=>act('install',{task:'python-project'})},'Install / update')):null,
          !state.project.js&&!state.project.python?h('p',null,'No package.json, requirements.txt, or pyproject.toml found. Plain HTML and CSS need no package installation.'):null):null,
        job?h('section',{'aria-label':'Setup progress'},h('div',{className:'setup-row'},h('strong',null,({running:'Installing…',complete:'Completed',cancelled:'Cancelled',failed:'Installation failed'})[job.state]||job.state),running?h('button',{onClick:()=>act('cancel',{})},'Cancel installation'):null),job.error?h('p',{role:'alert'},job.error):null,job.output?h('pre',null,job.output):null,job.state==='cancelled'?h('p',null,'Stopped. Files already installed are retained; check again before retrying.'):null):null
      );
    }
    function apply(ctx){
      ctx.effect(()=>{const style=document.createElement('style');style.textContent=CSS;document.head.appendChild(style);return()=>style.remove();},'development setup styles');
      ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'development-setup',order:6.6,label:()=> 'Development setup'},SetupPanel));
    }
    return {apply,inject:['slots'],SetupPanel};
  }
});
