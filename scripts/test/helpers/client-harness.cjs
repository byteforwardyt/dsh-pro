const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');

// Exercise the shipped module-table components, including hook lifetime and
// asynchronous callbacks, without coupling the tests to upstream CSS hashes.
exports.loadClient = function (name, fetcher, options = {}) {
  let current, component;
  const registrations = [];
  const storage = options.storage || new Map();
  const storageAPI = {getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k=>storage.delete(k)};
  const depsEqual = (a,b) => a && b && a.length === b.length && a.every((v,i)=>Object.is(v,b[i]));
  function cell() { const i=current.index++; return current.cells[i] ||= {}; }
  const React = {
    Fragment: Symbol('fragment'),
    createElement(type,props,...children) { return {type,props:{...props,children:children.flat(Infinity)}}; },
    useState(initial) { const c=cell(), owner=current; if (!('value' in c)) c.value=typeof initial==='function'?initial():initial;
      return [c.value,next=>{const value=typeof next==='function'?next(c.value):next;if(!Object.is(value,c.value)){c.value=value;owner.dirty=true;}}]; },
    useRef(value) {const c=cell();return c.ref ||= {current:value};},
    useMemo(fn,deps) {const c=cell();if(!depsEqual(c.deps,deps)){c.value=fn();c.deps=deps;}return c.value;},
    useCallback(fn,deps) {return React.useMemo(()=>fn,deps);},
    useEffect(fn,deps) {const c=cell();if(!depsEqual(c.deps,deps)){c.deps=deps;current.effects.push(()=>{c.cleanup?.();c.cleanup=fn();});}},
    useSyncExternalStore(subscribe,snapshot) {const owner=current;React.useEffect(()=>subscribe(()=>{owner.dirty=true}),[subscribe]);return snapshot();},
  };
  // Document-level listeners are real behaviour for a view that owns a keyboard
  // shortcut, so the fake document keeps a registry and exposes a dispatcher.
  const documentListeners = new Map();
  const document = {activeElement:null,head:{appendChild(){}},body:{setAttribute(){},removeAttribute(){}},getElementById:()=>({}),
    createElement:()=>options.webview === false ? {} : ({getWebContentsId(){}}),
    addEventListener(type,fn){(documentListeners.get(type) || documentListeners.set(type,new Set()).get(type)).add(fn);},
    removeEventListener(type,fn){documentListeners.get(type)?.delete(fn);},
    dispatch(type,event){for(const fn of [...(documentListeners.get(type) || [])])fn(event);return event;}};
  const window = {__DSH_DESKTOP__:options.desktopBridge,localStorage:storageAPI,navigator:{clipboard:{writeText:async()=>{}}},open(){},__ModuleLoader__:{load({factory}) {
    const cache = new Map();
    const resolve = id => {
      if (id === 'react') return React;
      if (id === 'react-dom') return {createPortal: content => content};
      if (options.modules?.[id]) return options.modules[id];
      if (id === '@dsh-desktop/client-ui-accounts') {
        if (!cache.has(id)) {
          let dependency;
          vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../../plugins/client-ui-accounts/lib/client.js'),'utf8'),
            {window:{__ModuleLoader__:{load({factory}){dependency=factory(resolve)}}},document,fetch:fetcher,console,URL,...options.globals});
          cache.set(id,dependency);
        }
        return cache.get(id);
      }
      throw new Error('optional module absent');
    };
    resolve.async = async id => { if (options.modules?.[id]) return options.modules[id]; throw new Error('optional async module absent: ' + id); };
    const module=factory(resolve);
    options.onModule?.(module);
    const ctx = {effect(fn){return fn();},...options.context,slots:{entries(){return options.entries?.() || [];},subscribe(){return ()=>{};},inject(_name,fn){fn();},register(meta,view){registrations.push({meta,view});if(!options.slot||meta.name===options.slot)component=view;return ()=>{};}}};
    if (options.apply) options.apply(module, ctx); else module.apply?.(ctx);
  }}};
  // Timers are real behaviour for a view that polls, so the sandbox has them
  // rather than leaving the component to no-op under test. They are unref'd:
  // a pending interval must never be the reason the test runner refuses to
  // exit. A test that wants determinism overrides them through options.globals,
  // which is spread last and therefore wins.
  const unrefd = (fn) => (...args) => { const handle = fn(...args); handle?.unref?.(); return handle; };
  vm.runInNewContext(fs.readFileSync(options.entryFile || path.join(__dirname,'../../../plugins',name,'lib/client.js'),'utf8'),
    {window,document,localStorage:storageAPI,navigator:window.navigator,fetch:fetcher,URL,TextEncoder,TextDecoder,AbortController,ResizeObserver:class {observe(){}disconnect(){}},console,
      setTimeout:unrefd(setTimeout),clearTimeout,setInterval:unrefd(setInterval),clearInterval,
      ...options.globals});
  function nodes(tree) {if(!tree||typeof tree!=='object')return [];return [tree,...(tree.props?.children||[]).flatMap(nodes)];}
  return {storage, registrations, document, mount(props, renderComponent = component) {
    const guest=new EventEmitter();Object.assign(guest,{addEventListener:guest.on.bind(guest),removeEventListener:guest.off.bind(guest),
      style:{},parentElement:{clientWidth:600,clientHeight:700,getBoundingClientRect:()=>({width:600,height:700})},
      canGoBack:()=>true,canGoForward:()=>false,getURL:()=>guest.url||'http://localhost:3000/',getAttribute:()=>guest.url,
      loadURL:async url=>{guest.url=url},reload(){},executeJavaScript:async()=>{}});
    const instance={index:0,cells:[],effects:[],dirty:true,guest,tree:null,
      render(){this.index=0;this.dirty=false;current=this;this.tree=renderComponent(props);for(const n of nodes(this.tree)){
        if(n.props.ref){if(n.type==='dialog'){n.props.ref.current ||= {open:false,showModal(){this.open=true},close(){this.open=false}};}
        else if(n.type==='webview'){n.props.ref.current=guest;guest.url=n.props.src;
          const stages=nodes(this.tree).filter(e=>e.props.className?.split(' ').includes('dshd-pv-stage'));
          guest.parentElement.clientWidth=parseInt(stages[0]?.props.style?.width)||600;
          guest.parentElement.clientHeight=parseInt(stages[0]?.props.style?.height)||700;
        }else n.props.ref.current={clientWidth:600,clientHeight:700,style:{},focus(){},querySelector(){return null},...options.element?.(n.type,n.props)};}}
        for(const effect of this.effects.splice(0))effect();},
      async flush(){for(let i=0;i<12;i++){if(this.dirty)this.render();await new Promise(r=>setImmediate(r));}
        // An I/O callback may land on the final yield. Drain its synchronous
        // renders/effects before diagnosing a render loop.
        for(let i=0;i<50&&this.dirty;i++)this.render();
        if(this.dirty)throw Error('render did not settle');return this;},
      find(predicate){return nodes(this.tree).find(predicate);},
      setProps(next){props=next;this.dirty=true;return this;},
      unmount(){for(const c of this.cells)c.cleanup?.();},
    };return instance;
  }};
};
