/** Paired LAN access. The native process owns the server, code and QR data. */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-phone",
  factory: (require) => {
    const React = require('react');
    const {useState,useEffect,useRef} = React;
    const h = React.createElement;
    const CSS = `
.dshd-ph{display:grid;gap:14px;max-width:960px;min-width:0}.dshd-ph p{margin:0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.dshd-ph-hero{display:grid;grid-template-columns:minmax(0,1fr) 132px;align-items:center;gap:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:22px 24px;background:var(--dsw-alias-bg-layer-1)}.dshd-ph-hero h3{font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-.02em;margin:8px 0 6px;color:var(--dsw-alias-label-primary)}.dshd-ph-eyebrow{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--dsw-alias-label-tertiary)}
.dshd-ph-device{width:116px;height:138px;color:var(--dsw-alias-label-tertiary)}.dshd-ph-device .live{color:var(--dshd-good,#73c99b)}
.dshd-ph-status-card{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 20px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}.dshd-ph-status{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:600;margin-bottom:4px;color:var(--dsw-alias-label-primary)}.dshd-ph-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.dshd-ph-status.is-on{color:var(--dshd-good,#73c99b)}.dshd-ph-status.is-on .dshd-ph-dot{background:currentColor}.dshd-ph-status-card p{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshd-ph-btn{padding:8px 15px;min-height:34px;flex:none;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}.dshd-ph-btn.off{background:transparent;color:var(--dsw-alias-label-primary)}.dshd-ph-btn.off:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dshd-ph-btn:disabled{opacity:.45;cursor:default}.dshd-ph-btn:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:3px}
.dshd-ph-live{display:grid;grid-template-columns:184px minmax(0,1fr);gap:20px;padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);align-items:center}.dshd-ph-qr{background:white;padding:12px;border-radius:12px;aspect-ratio:1;box-sizing:border-box}.dshd-ph-qr img{width:100%;height:100%;display:block}.dshd-ph-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;min-width:0}.dshd-ph-field{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:6px;min-width:0}.dshd-ph-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.dshd-ph-field .lab{display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary)}.dshd-ph-copy{height:24px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}.dshd-ph-copy:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshd-ph-field .url{font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}.dshd-ph-field .code{font:600 24px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:5px;color:var(--dsw-alias-label-primary)}.dshd-ph-fields>.dshd-ph-note{grid-column:1/-1;padding:0;border:0;background:transparent}
.dshd-ph-steps{list-style:none;counter-reset:steps;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.dshd-ph-steps li{counter-increment:steps;display:flex;flex-direction:column;gap:10px;padding:16px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);transition:border-color .12s ease}.dshd-ph-steps li:hover{border-color:var(--dsw-alias-border-l3)}.dshd-ph-steps li::before{content:"Step " counter(steps);width:max-content;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em}.dshd-ph-steps strong{display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:var(--dsw-alias-label-primary)}.dshd-ph-steps p{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}.dshd-ph-note{display:flex;align-items:start;gap:12px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}.dshd-ph-note svg{flex:none;margin-top:2px;color:var(--dsw-alias-label-tertiary)}.dshd-ph-note p{font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}.dshd-ph-err{padding:12px 16px;border:1px solid color-mix(in srgb,var(--dshd-bad,#ed8790) 30%,transparent);border-radius:12px;color:var(--dshd-bad,#ed8790)!important}
@media(max-width:650px){.dshd-ph-hero{padding:18px;gap:12px;grid-template-columns:minmax(0,1fr) 80px}.dshd-ph-device{width:80px;height:110px}.dshd-ph-hero h3{font-size:18px}.dshd-ph-status-card{padding:14px 16px;flex-wrap:wrap}.dshd-ph-live{grid-template-columns:130px minmax(0,1fr);padding:16px;gap:16px}.dshd-ph-field .code{font-size:20px;letter-spacing:3px}}@media(max-width:440px){.dshd-ph-live{grid-template-columns:1fr}.dshd-ph-qr{width:160px}}
`;
    function ensureStyle(){
      if(document.getElementById('dshd-phone-style')) return;
      const style=document.createElement('style');style.id='dshd-phone-style';style.textContent=CSS;document.head.appendChild(style);
    }
    function Device({enabled}) {
      return h('svg',{className:'dshd-ph-device',viewBox:'0 0 128 152',fill:'none',stroke:'currentColor',strokeWidth:1.3,'aria-hidden':true},
        h('rect',{x:34,y:6,width:70,height:138,rx:13}),h('path',{d:'M58 15h23M61 135h16'}),
        h('rect',{x:8,y:57,width:108,height:54,rx:10,fill:'var(--dsw-alias-bg-base)'}),
        h('path',{d:'m22 74 6 5-6 5M36 86h11'}),h('path',{d:'M58 75h44M58 84h29M58 93h35',opacity:.4}),
        h('circle',{cx:96,cy:34,r:4,className:enabled?'live':undefined,fill:'currentColor',stroke:'none'}));
    }
    function PhonePanel(){
      ensureStyle();
      const [state,setState]=useState({enabled:false});
      const [busy,setBusy]=useState(false);
      const [error,setError]=useState('');
      const [loaded,setLoaded]=useState(false);
      const [copiedKey,setCopiedKey]=useState('');
      const alive=useRef(false),operation=useRef(0),copyTimer=useRef(null);
      const bridge=window.__DSH_DESKTOP__;
      const has=typeof bridge?.phoneAccess==='function';
      const copyField=async(key,val)=>{
        if(!val)return;
        try{
          await navigator.clipboard.writeText(String(val));
          setCopiedKey(key);
          clearTimeout(copyTimer.current);
          copyTimer.current=setTimeout(()=>{if(alive.current)setCopiedKey('');},1400);
        }catch{}
      };
      const run=async action=>{
        const id=++operation.current;setBusy(true);setError('');
        try{
          const next=await bridge.phoneAccess(action);
          if(alive.current && operation.current===id){setState(next);setError(next.error||'');setLoaded(true);}
        }catch{
          if(alive.current && operation.current===id)setError('Could not update phone access. Try again.');
        }finally{if(alive.current && operation.current===id)setBusy(false);}
      };
      const enabled=Boolean(state.enabled);
      // The pairing code is single-use and the native side rotates it when
      // someone guesses at it, so a panel that read the code once would sit
      // there showing digits that no longer pair. Re-reading costs nothing:
      // 'status' mints no server, no code and no token. Silent on purpose too
      // - it must not flip the button into its "Please wait" state or clear an
      // error the user is still reading.
      const refresh=useRef(null);
      refresh.current=async()=>{
        if(!has||busy||!enabled)return;
        const id=operation.current;
        try{const next=await bridge.phoneAccess('status');if(alive.current&&operation.current===id)setState(next);}catch{}
      };
      useEffect(()=>{
        alive.current=true;if(has)void run('status');
        const timer=setInterval(()=>{void refresh.current?.();},8000);
        return()=>{clearInterval(timer);clearTimeout(copyTimer.current);alive.current=false;operation.current++;};
      },[]);
      const steps=[['Use the same Wi-Fi','Connect your phone and this computer to the same trusted network.'],['Scan and pair','Turn on phone access, scan the QR code, then enter the six-digit pairing code.'],['Pick up where you left off','Your phone opens the same live workspace. On iPhone, use Share → Add to Home Screen for quick access.']];
      return h('div',{className:'dshd-ph','aria-busy':busy},
        h('div',{className:'dshd-ph-hero'},h('div',null,h('span',{className:'dshd-ph-eyebrow'},'One workspace. Two screens.'),h('h3',null,'Take your work with you.'),h('p',null,'Check progress and continue a conversation from your phone’s browser. Your desktop keeps doing the work.')),h(Device,{enabled})),
        h('div',{className:'dshd-ph-status-card'},h('div',null,h('div',{className:'dshd-ph-status'+(enabled?' is-on':'')},h('i',{className:'dshd-ph-dot'}),!has?'Desktop app required':!loaded?'Checking connection':enabled?'Phone access is on':'Phone access is off'),h('p',null,enabled?'Ready to pair on your local network.':'Enable when you want to connect.')),
          h('button',{type:'button',className:'dshd-ph-btn'+(enabled?' off':''),disabled:!has||busy,onClick:()=>{if(!busy)void run(!loaded?'status':enabled?'disable':'enable');}},busy?'Please wait…':!loaded&&has?'Retry':enabled?'Turn off':'Turn on phone access')),
        error?h('p',{className:'dshd-ph-err',role:'alert'},error):null,
        enabled&&state.url?h('div',{className:'dshd-ph-live'},state.qrSvg?h('div',{className:'dshd-ph-qr'},h('img',{src:'data:image/svg+xml,'+encodeURIComponent(state.qrSvg),alt:'QR code to pair your phone'})):null,
          h('div',{className:'dshd-ph-fields'},
            h('div',{className:'dshd-ph-field'},
              h('div',{className:'dshd-ph-field-head'},h('span',{className:'lab'},'Open on your phone'),h('button',{type:'button',className:'dshd-ph-copy',onClick:()=>void copyField('url',state.url)},copiedKey==='url'?'Copied':'Copy URL')),
              h('div',{className:'url'},state.url)),
            h('div',{className:'dshd-ph-field'},
              h('div',{className:'dshd-ph-field-head'},h('span',{className:'lab'},'Pairing code'),h('button',{type:'button',className:'dshd-ph-copy',onClick:()=>void copyField('code',state.code)},copiedKey==='code'?'Copied':'Copy code')),
              h('div',{className:'code'},state.code)),
            h('p',{className:'dshd-ph-note'},'Each code pairs one device. It changes once it is used, and again after repeated wrong entries.'))):null,
        h('ol',{className:'dshd-ph-steps'},steps.map(([title,copy])=>h('li',{key:title},h('div',null,h('strong',null,title),h('p',null,copy))))),
        h('div',{className:'dshd-ph-note'},h('svg',{width:16,height:18,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z M9 12l2 2 4-4'})),h('p',null,'A paired phone can do everything you can do here, including running commands. Use a trusted network: the local connection is plain HTTP. Turning access off, or quitting DSH, unpairs every device.')));
    }
    function apply(ctx){ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'phone',order:6,label:()=> 'Phone'},PhonePanel));}
    return {apply,inject:['slots']};
  },
});
