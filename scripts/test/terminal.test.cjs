const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Readable}=require('node:stream');
const {spawn}=require('node:child_process');
const {loadClient}=require('./helpers/client-harness.cjs');

const lib=name=>import('../../plugins/terminal/lib/'+name);

/* A faithful stand-in for the subprocess seam: detached so the child owns its
   own process group, which is what makes terminate() tree-scoped the way the
   real implementation documents. */
function subprocessSeam(){
  return {async resolveExecutable(name){
    for(const dir of ['/usr/bin','/bin','/usr/sbin']){const full=path.join(dir,name);if(fs.existsSync(full))return full;}
    throw new Error('not found: '+name);
  },spawn({argv,cwd,stdio,env}){
    const child=spawn(argv[0],argv.slice(1),{cwd,detached:true,env:{...process.env,...env},
      stdio:['stdin','stdout','stderr'].map(key=>stdio[key]==='pipe'?'pipe':'ignore')});
    const done=new Promise(resolve=>child.on('close',(exitCode,signal)=>resolve({exitCode,signal})));
    return {pid:child.pid,stdin:child.stdin,stdout:child.stdout,stderr:child.stderr,done,
      terminate(){try{process.kill(-child.pid,'SIGTERM')}catch{try{child.kill('SIGTERM')}catch{}}},
      async waitForExit(){await done;return true}};
  }};
}

function fixtureContext(roots){
  return {workspaceRegistry:{list:()=>roots.map((entry,index)=>({id:index+1,path:entry,title:path.basename(entry)}))},
    subprocess:subprocessSeam(),logger:{warn(){}},tools:{register(){}},on(){},
    webServer:{register(){return()=>{}}}};
}

function response(){
  const chunks=[];
  return {statusCode:null,headers:null,destroyed:false,ended:false,
    writeHead(status,headers){this.statusCode=status;this.headers=headers;return this},
    write(chunk){chunks.push(chunk);return true},
    end(chunk){if(chunk)chunks.push(chunk);this.ended=true},
    once(){},off(){},
    get json(){return JSON.parse(chunks.join(''))}};
}

function request(method,url,headers,body){
  const stream=body===undefined?Readable.from([]):Readable.from([JSON.stringify(body)]);
  return Object.assign(stream,{method,url,headers});
}

const deadline=(promise,ms,what)=>Promise.race([promise,
  new Promise((_,reject)=>setTimeout(()=>reject(new Error('timed out waiting for '+what)),ms).unref())]);

async function until(check,ms,what){
  const stop=Date.now()+ms;
  for(;;){if(check())return;if(Date.now()>stop)throw new Error('timed out waiting for '+what);
    await new Promise(resolve=>setTimeout(resolve,25));}
}

const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
const status=call=>{try{call()}catch(error){return error.status}return null};
/* The pane is evaluated in a vm context, so the values it returns carry that
   realm's prototypes and fail a strict deep comparison against host literals.
   Round-tripping through JSON compares the shape, which is what these mean. */
const plainly=value=>JSON.parse(JSON.stringify(value));

/* ── The loopback fence ────────────────────────────────────────────────── */

test('the loopback fence refuses a cross-origin request before any route runs',async()=>{
  const {apply}=await lib('index.js');
  let handler=null,spawns=0;
  const ctx=fixtureContext([process.cwd()]);
  ctx.webServer.register=({path:prefix,handler:fn})=>{assert.equal(prefix,'/dsh-terminal');handler=fn;return()=>{}};
  ctx.subprocess.spawn=()=>{spawns+=1;throw new Error('a refused request must never reach a spawn')};
  apply(ctx);
  assert.equal(typeof handler,'function');

  const refused=[
    // A rebound DNS name arrives with its own hostname in Host, which is why
    // Host is the load-bearing check rather than Origin.
    {host:'evil.example',origin:'http://localhost'},
    {host:'127.0.0.1:1234',origin:'http://evil.example'},
    // Two loopback ports are same-site to a browser, so same-site is refused:
    // that is what stops a previewed workspace page calling this API.
    {host:'localhost:1234','sec-fetch-site':'same-site'},
    {host:'localhost:1234','sec-fetch-site':'cross-site'},
  ];
  for(const headers of refused){
    const res=response();
    await handler(request('POST','/dsh-terminal/open',{...headers,'content-type':'application/json'},{}),res);
    assert.equal(res.statusCode,403,JSON.stringify(headers));
    assert.deepEqual(res.json,{error:'cross-origin request refused'});
  }
  assert.equal(spawns,0,'no refused request may reach the shell');

  // The same request from the app itself is admitted and reaches the routes.
  const ok=response();
  await handler(request('GET','/dsh-terminal/sessions',{host:'127.0.0.1:1234','sec-fetch-site':'same-origin'}),ok);
  assert.equal(ok.statusCode,200);
  assert.deepEqual(ok.json.sessions,[]);
  assert.ok(ok.json.roots.some(root=>root.path===process.cwd()));
});

test('a non-JSON content type and an unknown route are refused, not guessed',async()=>{
  const {apply}=await lib('index.js');
  let handler=null;
  const ctx=fixtureContext([process.cwd()]);
  ctx.webServer.register=({handler:fn})=>{handler=fn;return()=>{}};
  apply(ctx);
  const trusted={host:'127.0.0.1:1234'};
  const form=response();
  await handler(request('POST','/dsh-terminal/run',{...trusted,'content-type':'text/plain'},{}),form);
  assert.equal(form.statusCode,415);
  const unknown=response();
  await handler(request('GET','/dsh-terminal/nope',trusted),unknown);
  assert.equal(unknown.statusCode,404);
  const missing=response();
  await handler(request('POST','/dsh-terminal/run',{...trusted,'content-type':'application/json'},{id:'nope',command:'x'}),missing);
  assert.equal(missing.statusCode,404);
});

/* ── The containment fence ─────────────────────────────────────────────── */

test('a session refuses every directory outside the open workspaces',async()=>{
  const {createSessions}=await lib('sessions.js');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-terminal-')));
  const ctx=fixtureContext([root]);
  ctx.subprocess.spawn=()=>{throw new Error('the fence must refuse before any spawn')};
  const sessions=createSessions(ctx,{reapIntervalMs:3600000});
  try{
    for(const outside of ['/etc',path.join(root,'..'),os.homedir(),'/']){
      const refusal=await sessions.open({cwd:outside}).then(()=>null,error=>error);
      assert.equal(refusal&&refusal.status,403,'expected a refusal for '+outside);
      // The message never echoes the path back: a distinguishable "outside the
      // workspace" and "does not exist" pair is a directory oracle.
      assert.equal(refusal.message,'outside the workspace');
    }
    // A symlink inside the workspace pointing out of it is the case a string
    // prefix test would pass and realpath resolution catches.
    const escape=path.join(root,'escape');
    fs.symlinkSync(os.tmpdir(),escape,'dir');
    assert.equal((await sessions.open({cwd:escape}).then(()=>null,error=>error)).status,403);
    // A file is not a directory, and a NUL byte truncates a path at the syscall.
    fs.writeFileSync(path.join(root,'file.txt'),'x');
    assert.equal((await sessions.open({cwd:path.join(root,'file.txt')}).then(()=>null,error=>error)).status,400);
    assert.equal((await sessions.open({cwd:'\u0000/etc'}).then(()=>null,error=>error)).status,403);
  }finally{await sessions.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

/* ── Bounded memory ────────────────────────────────────────────────────── */

test('the scrollback ring stays bounded and reports the gap it created',async()=>{
  const {createRing}=await lib('sessions.js');
  const ring=createRing(1024);
  for(let i=0;i<400;i+=1)ring.push({kind:'chunk',stream:'stdout',text:'x'.repeat(64)});
  assert.ok(ring.bytes<=1024,'retained '+ring.bytes+' bytes above the 1024 cap');
  assert.equal(ring.seq,400);
  // A reader asking for history older than the ring still holds is told so,
  // because appending across that gap would silently invent continuity.
  assert.equal(ring.since(0).truncated,true);
  assert.equal(ring.since(399).truncated,false);
  assert.deepEqual(ring.since(399).events.map(event=>event.seq),[400]);
  // A fresh ring under its cap reports no gap at all.
  const small=createRing(1024);
  small.push({kind:'chunk',stream:'stdout',text:'hello'});
  assert.equal(small.since(0).truncated,false);
  assert.equal(small.since(null).events.length,1);
});

test('a stored event is never large enough to force the ring to trim inside one',async()=>{
  const {splitChunk}=await lib('sessions.js');
  const pieces=splitChunk('a'.repeat(70000),16384);
  assert.equal(pieces.join(''),'a'.repeat(70000));
  assert.ok(pieces.every(piece=>piece.length<=16384));
  // Splitting between the halves of a surrogate pair would send a lone
  // surrogate through JSON and land as a replacement character.
  const paired=splitChunk('\u{1f600}'.repeat(8),4);
  assert.equal(paired.join(''),'\u{1f600}'.repeat(8));
  assert.ok(paired.every(piece=>!/[\ud800-\udbff]$/.test(piece)));
});

test('one command collects a bounded excerpt with its head and its tail intact',async()=>{
  const {createCollector}=await lib('sessions.js');
  const collector=createCollector(20,10);
  collector.add('HEAD'.padEnd(20,'.'));
  collector.add('m'.repeat(500));
  collector.add('THE-TAIL-X');
  assert.ok(collector.truncated);
  assert.ok(collector.text.startsWith('HEAD'));
  assert.ok(collector.text.endsWith('THE-TAIL-X'));
  assert.match(collector.text,/characters of output omitted/);
  const short=createCollector(100,10);
  short.add('all of it');
  assert.equal(short.text,'all of it');
  assert.equal(short.truncated,false);
});

/* ── ANSI ──────────────────────────────────────────────────────────────── */

test('the host strips whole escape sequences, not only colour',async()=>{
  const {stripAnsi,excerpt}=await lib('ansi.js');
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'),'red');
  assert.equal(stripAnsi('\u001b[2J\u001b[Hcleared'),'cleared');
  // Bracketed paste and an OSC title write are what a naive colour-only strip
  // leaves behind as "?2004h" and a window title in the middle of a line.
  assert.equal(stripAnsi('\u001b[?2004hprompt\u001b[?2004l'),'prompt');
  assert.equal(stripAnsi('\u001b]0;a title\u0007text'),'text');
  assert.equal(stripAnsi('\u001b]8;;http://x\u001b\\link'),'link');
  assert.equal(stripAnsi('a\rb'),'a\nb');
  assert.equal(stripAnsi('a\r\nb'),'a\r\nb');
  assert.equal(stripAnsi(undefined),'');
  const long=excerpt('S'.repeat(100)+'M'.repeat(100000)+'E'.repeat(100),{head:50,tail:50});
  assert.ok(long.truncated);
  assert.ok(long.text.startsWith('S'.repeat(50)));
  assert.ok(long.text.endsWith('E'.repeat(50)));
});

function terminalModule(){
  let captured=null;
  loadClient('terminal',()=>{throw new Error('the terminal pane must not fetch at load time')},
    {onModule:module=>{captured=module}});
  return captured;
}

test('the pane translates SGR colour and swallows every other sequence',async()=>{
  const {ansiSpans}=terminalModule();
  assert.deepEqual(plainly(ansiSpans('hello').spans),[{text:'hello',style:null}]);

  const coloured=ansiSpans('\u001b[31mred\u001b[0m plain');
  assert.equal(coloured.spans.length,2);
  assert.equal(coloured.spans[0].text,'red');
  assert.match(coloured.spans[0].style.fg,/^#[0-9a-f]{6}$/);
  // Never pure black or pure white: this palette has to read on both themes.
  assert.notEqual(coloured.spans[0].style.fg,'#000000');
  assert.equal(coloured.spans[1].style,null);

  assert.deepEqual(plainly(ansiSpans('\u001b[1;4mboth').spans[0].style),
    {fg:null,bg:null,bold:true,dim:false,italic:false,underline:true,inverse:false});
  assert.equal(ansiSpans('\u001b[1;4mx\u001b[22;24my').spans[1].style,null);
  assert.equal(ansiSpans('\u001b[38;5;196mx').spans[0].style.fg,'#ff0000');
  assert.equal(ansiSpans('\u001b[38;2;18;52;86mx').spans[0].style.fg,'#123456');
  assert.equal(ansiSpans('\u001b[38:5:196mx').spans[0].style.fg,'#ff0000');
  assert.equal(ansiSpans('\u001b[48;5;21mx').spans[0].style.bg,'#0000ff');

  // Everything that is not colour is removed rather than printed.
  for(const noisy of ['\u001b[2J\u001b[H','\u001b[?2004h','\u001b]0;title\u0007','\u001b]8;;u\u001b\\','\u001bM','\u001b[1;5H']){
    assert.equal(ansiSpans(noisy+'clean').spans.map(span=>span.text).join(''),'clean',JSON.stringify(noisy));
  }
  assert.equal(ansiSpans('a\rb').spans[0].text,'a\nb');
  assert.equal(ansiSpans('ab\b\bc').spans[0].text,'c');
  assert.equal(ansiSpans('bell\u0007').spans[0].text,'bell');
});

test('the pane carries colour and a half-arrived escape across a chunk boundary',async()=>{
  const {ansiSpans}=terminalModule();
  // A stream chunk can end anywhere, including inside an escape sequence.
  // Printing the half that arrived is exactly the garbage this parser prevents.
  const first=ansiSpans('start \u001b[3');
  assert.deepEqual(plainly(first.spans.map(span=>span.text)),['start ']);
  assert.equal(first.state.pending,'\u001b[3');
  const second=ansiSpans('1mred',first.state);
  assert.equal(second.spans[0].text,'red');
  assert.ok(second.spans[0].style.fg);
  // Colour set in one chunk still applies to the next.
  const third=ansiSpans('still red',second.state);
  assert.equal(third.spans[0].style.fg,second.spans[0].style.fg);
  assert.equal(ansiSpans('done',ansiSpans('\u001b[0m',third.state).state).spans[0].style,null);
  // A half-arrived OSC is held too, not printed as a stray title.
  const osc=ansiSpans('a\u001b]0;ti');
  assert.equal(osc.spans.map(span=>span.text).join(''),'a');
  assert.equal(ansiSpans('tle\u0007b',osc.state).spans.map(span=>span.text).join(''),'b');
});

/* ── A real shell ──────────────────────────────────────────────────────── */

/** /bin/sh with -s sources no profile, so these measure the plugin and not a .zprofile. */
function plainShell(){
  const previous=process.env.SHELL;
  process.env.SHELL='/bin/sh';
  return()=>{if(previous===undefined)delete process.env.SHELL;else process.env.SHELL=previous;};
}

test('a real shell runs a command, hides its completion marker, and dies with its session',async()=>{
  const {createSessions}=await lib('sessions.js');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-terminal-')));
  const sessions=createSessions(fixtureContext([root]),{reapIntervalMs:3600000});
  const restore=plainShell();
  try{
    const session=await sessions.open({cwd:root});
    assert.equal(session.cwd,root);
    assert.equal(session.running,true);

    const seen=[];
    const detach=sessions.subscribe(session.id,null,event=>seen.push(event));
    const first=sessions.run(session.id,'echo hello-from-dsh; pwd');
    const result=await deadline(sessions.waitForRun(session.id,first.runId,{timeoutMs:20000}),25000,'the command');
    assert.equal(result.exitCode,0);
    assert.match(result.output,/hello-from-dsh/);
    assert.ok(result.output.includes(root),'the shell runs in the workspace it was fenced to');

    // The marker is the plugin's own protocol and must never be visible.
    const transcript=seen.filter(event=>event.kind==='chunk').map(event=>event.text).join('');
    assert.doesNotMatch(transcript,/\u001e/);
    assert.doesNotMatch(transcript,/printf/);
    assert.ok(seen.some(event=>event.kind==='done'&&event.runId===first.runId&&event.exitCode===0));

    // A failing command reports its status rather than looking like a success.
    const failing=sessions.run(session.id,'sh -c "exit 3"');
    assert.equal((await deadline(sessions.waitForRun(session.id,failing.runId,{timeoutMs:20000}),25000,'the failure')).exitCode,3);
    detach();

    // Closing the session takes the process group with it. A terminal that
    // leaks shells leaks every dev server ever started in one.
    const pid=session.pid;
    assert.ok(alive(pid));
    sessions.close(session.id);
    await until(()=>!alive(pid),10000,'the shell to exit');
    assert.equal(sessions.get(session.id),null,'a closed session is gone from the registry');
  }finally{restore();await sessions.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('an interrupt stops the command and leaves the shell alive',async()=>{
  const {createSessions}=await lib('sessions.js');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-terminal-')));
  const sessions=createSessions(fixtureContext([root]),{reapIntervalMs:3600000});
  const restore=plainShell();
  try{
    const session=await sessions.open({cwd:root});
    const running=sessions.run(session.id,'sleep 30');
    const settled=sessions.waitForRun(session.id,running.runId,{timeoutMs:20000});
    // Let the shell actually reach sleep before signalling its children.
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(await sessions.interrupt(session.id),{interrupted:true});
    const result=await deadline(settled,25000,'the interrupted command');
    assert.notEqual(result.exitCode,0,'an interrupted command must not report success');
    // The shell itself survives, which is the whole difference between Ctrl+C
    // and closing the session.
    assert.equal(sessions.get(session.id).running,true);
    const next=sessions.run(session.id,'echo still-here');
    assert.match((await deadline(sessions.waitForRun(session.id,next.runId,{timeoutMs:20000}),25000,'the next command')).output,/still-here/);
  }finally{restore();await sessions.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('a session refuses a second command while one is running, and refuses junk',async()=>{
  const {createSessions}=await lib('sessions.js');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-terminal-')));
  const sessions=createSessions(fixtureContext([root]),{reapIntervalMs:3600000});
  const restore=plainShell();
  try{
    const session=await sessions.open({cwd:root});
    sessions.run(session.id,'sleep 5');
    // A second write would be read as the running program's stdin, and the
    // marker's exit status would belong to whichever finished last.
    assert.equal(status(()=>sessions.run(session.id,'echo no')),409);
    assert.equal(status(()=>sessions.run(session.id,'')),400);
    assert.equal(status(()=>sessions.run('nope','echo hi')),404);
    assert.equal(status(()=>sessions.write(session.id,'a\u0000b')),400);
    // Shape is checked before state: an oversized command is refused as one,
    // not reported as a busy session.
    assert.equal(status(()=>sessions.run(session.id,'x'.repeat(9000))),413);
  }finally{restore();await sessions.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('the shell is a login shell that reads stdin, and never an interactive one',async()=>{
  const {resolveShell,shellEnv}=await lib('shell.js');
  assert.deepEqual((await resolveShell({SHELL:'/bin/zsh'})).argv,['/bin/zsh','-l','-s']);
  assert.deepEqual((await resolveShell({SHELL:'/bin/bash'})).argv,['/bin/bash','-l','-s']);
  assert.deepEqual((await resolveShell({SHELL:'/bin/sh'})).argv,['/bin/sh','-s']);
  // A missing, relative or non-executable $SHELL falls back rather than failing.
  assert.equal((await resolveShell({SHELL:'/nope/nothing'})).path,'/bin/zsh');
  assert.equal((await resolveShell({SHELL:'zsh'})).path,'/bin/zsh');
  // -i is deliberately absent: without a tty it buys a prompt full of escape
  // sequences and nothing else.
  assert.ok((await resolveShell({})).argv.every(part=>part!=='-i'));
  // A pager on a pipe waits for a keypress that can never arrive.
  assert.equal(shellEnv(80,24).PAGER,'cat');
  assert.equal(shellEnv(80,24).GIT_PAGER,'cat');
  assert.equal(shellEnv(120,40).COLUMNS,'120');
});

/* ── The agent tool ────────────────────────────────────────────────────── */

test('the agent tool shares the user session, obeys the fence, and labels its output untrusted',async()=>{
  const {createSessions}=await lib('sessions.js');
  const {registerTerminalTool}=await lib('tool.js');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsh-terminal-')));
  const ctx=fixtureContext([root]);
  const sessions=createSessions(ctx,{reapIntervalMs:3600000});
  let tool=null;
  ctx.tools={register(definition){tool=definition}};
  registerTerminalTool(ctx,sessions);
  assert.equal(tool.name,'terminal');
  const restore=plainShell();
  try{
    // The user already has a shell open; the agent must land in that one.
    const opened=await sessions.open({cwd:root});
    const result=await deadline(tool.execute({command:'echo tool-ok'},{}),25000,'the tool');
    assert.equal(result.ok,true);
    assert.equal(result.exitCode,0);
    assert.match(result.output,/tool-ok/);
    assert.equal(result.cwd,root);
    assert.equal(sessions.list().length,1,'the agent reused the session rather than opening a second shell');
    assert.equal(sessions.get(opened.id).running,true);

    // Shell state persists between calls, which is what makes it a session.
    await deadline(tool.execute({command:'DSH_TEST_MARK=kept'},{}),25000,'the export');
    assert.match((await deadline(tool.execute({command:'echo $DSH_TEST_MARK'},{}),25000,'the recall')).output,/kept/);

    // Output reaches the model wrapped as data, never as instructions.
    const rendered=tool.output.render({command:'echo tool-ok'},result)[0].text;
    assert.match(rendered,/UNTRUSTED TERMINAL OUTPUT/);
    assert.match(rendered,/END OF TERMINAL OUTPUT/);
    assert.match(rendered,/tool-ok/);

    // The workspace fence applies to the agent exactly as it does to the pane.
    const outside=await tool.execute({command:'echo no',cwd:'/etc'},{});
    assert.equal(outside.ok,false);
    assert.match(outside.error,/outside every open workspace/);
    assert.match(tool.output.render({command:'echo no'},outside)[0].text,/could not run/);

    // A non-zero status is a failure, not a success with odd text in it.
    const failed=await deadline(tool.execute({command:'sh -c "exit 7"'},{}),25000,'the failure');
    assert.equal(failed.ok,false);
    assert.equal(failed.exitCode,7);

    // A command that never finishes is interrupted rather than abandoned.
    const stuck=await deadline(tool.execute({command:'sleep 30',timeoutSeconds:1},{}),25000,'the timeout');
    assert.equal(stuck.timedOut,true);
    assert.equal(stuck.ok,false);
    assert.match(tool.output.render({command:'sleep 30'},stuck)[0].text,/did not finish in time/);
    // The session is usable again straight afterwards.
    assert.match((await deadline(tool.execute({command:'echo after'},{}),25000,'the recovery')).output,/after/);
  }finally{restore();await sessions.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

/* ── The pane ──────────────────────────────────────────────────────────── */

const reply=(payload,code=200)=>({ok:code<400,status:code,async json(){return payload}});

/** A controllable NDJSON body, so a test can deliver events one at a time. */
function eventStream(){
  const queued=[];const encoder=new TextEncoder();
  let waiting=null,closed=false;
  const deliver=value=>{const resume=waiting;waiting=null;resume(value)};
  return {
    push(event){const chunk=encoder.encode(JSON.stringify(event)+'\n');
      if(waiting)deliver({value:chunk,done:false});else queued.push(chunk);},
    close(){closed=true;if(waiting)deliver({value:undefined,done:true});},
    response(){return {ok:true,status:200,body:{getReader:()=>({
      read(){if(queued.length)return Promise.resolve({value:queued.shift(),done:false});
        if(closed)return Promise.resolve({value:undefined,done:true});
        return new Promise(resolve=>{waiting=resolve})},
      cancel(){return Promise.resolve()},releaseLock(){}})}}},
  };
}

function pane(options={}){
  const calls=[];
  const stream=options.stream||eventStream();
  const session={id:'s1',cwd:'/w/project',root:'/w/project',title:'project',shell:'zsh',pid:4242,
    cols:80,rows:24,startedAt:'now',running:true,exitCode:null,signal:null,pendingRunId:null};
  const fetcher=async(url,init)=>{
    const body=init&&init.body?JSON.parse(init.body):null;
    calls.push({url,body});
    if(url.startsWith('/dsh-terminal/sessions'))return reply({sessions:options.sessions||[],
      roots:options.roots||[{id:'1',path:'/w/project',title:'project',registered:true}]});
    if(url.startsWith('/dsh-terminal/open'))return options.openFails
      ?reply({error:'outside the workspace'},403):reply({session},201);
    if(url.startsWith('/dsh-terminal/stream'))return options.streamFails
      ?reply({error:'no such terminal session'},404):stream.response();
    if(url.startsWith('/dsh-terminal/run'))return reply({runId:'1'});
    if(url.startsWith('/dsh-terminal/signal'))return reply({ok:true,interrupted:false});
    if(url.startsWith('/dsh-terminal/close'))return reply({ok:true});
    throw new Error('unexpected request '+url);
  };
  let terminalView;
  const client=loadClient('terminal',fetcher,{slot:'conversation.session.header.utilities',onModule: module=>{terminalView=module.TerminalView}});
  return {client,calls,stream,session,
    async open(props){const view=client.mount(props||{},terminalView);
      // The transcript publishes on a 50ms batch, so a real wait is required
      // before the rendered output can be inspected.
      await view.flush();await new Promise(resolve=>setTimeout(resolve,90));return view.flush();}};
}

const textOf=node=>{
  const parts=[];
  (function walk(current){if(current===null||current===undefined||current===false)return;
    if(typeof current==='string'||typeof current==='number'){parts.push(String(current));return}
    if(Array.isArray(current)){current.forEach(walk);return}
    if(current.props)walk(current.props.children)})(node);
  return parts.join('');
};

test('the terminal registers a session-header dock control',async()=>{
  const {client}=pane();
  assert.deepEqual(client.registrations.map(row=>row.meta.name),['conversation.session.header.utilities']);
  const meta=client.registrations[0].meta;
  assert.equal(meta.id,'terminal-dock');
  assert.equal(meta.label(),'Terminal');
  const dock=await client.mount().flush();
  assert.ok(dock.find(node=>node.type==='button'&&node.props['data-dshd-terminal-toggle']===''));
  assert.ok(dock.find(node=>node.type==='svg'&&node.props['aria-hidden']===true), 'terminal has a decorative icon while the button keeps its accessible name');
  dock.unmount();
});

test('the header control mounts and removes a bottom dock without replacing Code',async()=>{
  const mounts=[];
  const column={clientHeight:800,appendChild(node){mounts.push(node)}};
  let terminalView;
  const client=loadClient('terminal',async()=>{throw Error('the dock toggle must not start the shell itself')},
    {slot:'conversation.session.header.utilities',onModule:module=>{terminalView=module.InteractiveTerminal},
      element:type=>type==='span'?{closest:()=>column}:{}});
  client.document.createElement=()=>({style:{},remove(){mounts.pop()}});
  const dock=await client.mount().flush();
  const button=dock.find(node=>node.type==='button'&&node.props['data-dshd-terminal-toggle']==='');
  button.props.onClick();
  await dock.flush();
  assert.equal(mounts.length,1);
  assert.equal(mounts[0].style.height,'300px');
  const separator=()=>dock.find(node=>node.props.role==='separator');
  separator().props.onKeyDown({key:'ArrowUp',preventDefault(){}});
  await dock.flush();
  assert.equal(mounts[0].style.height,'330px');
  assert.equal(client.storage.get('dshd.terminal.height'),'330');
  dock.find(node=>node.props['aria-label']==='Maximize terminal').props.onClick();
  await dock.flush();
  assert.equal(mounts[0].style.height,'640px');
  dock.find(node=>node.props['aria-label']==='Restore terminal size').props.onClick();
  await dock.flush();
  assert.equal(mounts[0].style.height,'330px');
  separator().props.onPointerDown({button:0,clientY:500,pointerId:1,preventDefault(){},currentTarget:{focus(){},setPointerCapture(){}}});
  separator().props.onPointerMove({clientY:400});
  separator().props.onPointerUp();
  await dock.flush();
  assert.equal(mounts[0].style.height,'430px');
  separator().props.onKeyDown({key:'Home',preventDefault(){}});
  await dock.flush();
  assert.equal(mounts[0].style.height,'170px');
  dock.find(node=>node.type==='button'&&textOf(node)==='Agent commands').props.onClick();
  await dock.flush();
  assert.equal(mounts[0].style.height,'260px', 'command input and status need more room than the shell');
  assert.equal(separator().props['aria-valuemin'],260);
  assert.equal(client.storage.get('dshd.terminal.height'),'170', 'switching modes preserves the preferred shell height');
  dock.find(node=>node.type==='button'&&textOf(node)==='Shell').props.onClick();
  await dock.flush();
  assert.equal(mounts[0].style.height,'170px');
  dock.find(node=>node.type==='button'&&textOf(node)==='Agent commands').props.onClick();
  await dock.flush();
  for (const key of ['Home', 'ArrowDown']) {
    separator().props.onKeyDown({key,preventDefault(){}});
    await dock.flush();
    assert.equal(mounts[0].style.height,'260px');
  }
  dock.find(node=>node.type==='button'&&textOf(node)==='Shell').props.onClick();
  await dock.flush();
  separator().props.onDoubleClick();
  await dock.flush();
  assert.ok(dock.find(node=>node.type===terminalView), 'the existing terminal view is portaled into the dock');
  assert.equal(dock.find(node=>node.type==='button'&&node.props['data-dshd-terminal-toggle']==='').props['aria-expanded'],'true');
  dock.find(node=>node.type==='button'&&node.props['data-dshd-terminal-toggle']==='').props.onClick();
  await dock.flush();
  assert.equal(mounts.length,0);
  dock.find(node=>node.props['data-dshd-terminal-toggle']==='').props.onClick();
  await dock.flush();
  assert.equal(mounts[0].style.height,'300px');
  dock.find(node=>node.props['aria-label']==='Hide terminal panel').props.onClick();
  await dock.flush();
  assert.equal(mounts.length,0);
  dock.unmount();
});

test('the pane opens a session, streams output, and echoes what the user typed',async()=>{
  const harness=pane();
  const view=await harness.open();
  assert.ok(harness.calls.some(call=>call.url.startsWith('/dsh-terminal/open')));
  assert.equal(harness.calls.find(call=>call.url.startsWith('/dsh-terminal/open')).body.cwd,'/w/project');
  // The header says which folder the shell is actually running in.
  assert.match(textOf(view.tree),/\/w\/project/);
  assert.match(textOf(view.tree),/zsh/);

  harness.stream.push({kind:'session',session:harness.session,seq:0,truncated:false});
  harness.stream.push({kind:'chunk',seq:1,stream:'stdout',text:'\u001b[32mready\u001b[0m\n'});
  await view.flush();await new Promise(resolve=>setTimeout(resolve,90));await view.flush();
  const out=view.find(node=>node.props&&node.props.className==='dshd-tm-out');
  assert.match(textOf(out),/ready/);
  // The colour survived as a span, and the escape did not.
  assert.doesNotMatch(textOf(out),/\u001b/);
  assert.ok(view.find(node=>node.props&&node.props.style&&node.props.style.color));

  // A piped shell cannot echo, so the pane draws the command itself.
  const input=view.find(node=>node.type==='input');
  input.props.onChange({target:{value:'ls -la'}});
  await view.flush();
  view.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  await view.flush();await new Promise(resolve=>setTimeout(resolve,90));await view.flush();
  const run=harness.calls.find(call=>call.url.startsWith('/dsh-terminal/run'));
  assert.deepEqual(run.body,{id:'s1',command:'ls -la'});
  assert.match(textOf(view.find(node=>node.props&&node.props.className==='dshd-tm-cmd')),/ls -la/);
  assert.equal(view.find(node=>node.type==='input').props.value,'','the input clears on submit');

  // The pane measures itself once so COLUMNS matches the pane rather than 80.
  const resize=harness.calls.find(call=>call.url.startsWith('/dsh-terminal/resize'));
  assert.equal(resize.body.id,'s1');
  assert.ok(resize.body.cols>20&&resize.body.cols<500,'measured '+resize.body.cols+' columns');

  // Up recalls it, which is the whole point of keeping history.
  view.find(node=>node.type==='input').props.onKeyDown({key:'ArrowUp',preventDefault(){}});
  await view.flush();
  assert.equal(view.find(node=>node.type==='input').props.value,'ls -la');

  // A reconnect to the SAME shell resumes from where it left off rather than
  // replaying, so the stream carries the sequence it last saw.
  assert.match(harness.calls.filter(call=>call.url.startsWith('/dsh-terminal/stream')).at(-1).url,/id=s1/);
  view.unmount();
});

test('typing while a command runs answers its prompt instead of queueing a command',async()=>{
  const harness=pane();
  const view=await harness.open();
  harness.stream.push({kind:'session',session:harness.session,seq:0,truncated:false});
  await view.flush();await new Promise(resolve=>setTimeout(resolve,90));await view.flush();

  view.find(node=>node.type==='input').props.onChange({target:{value:'npm init'}});
  await view.flush();
  view.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  await view.flush();await new Promise(resolve=>setTimeout(resolve,90));await view.flush();
  // A command is now in flight, and the input stays usable so the program's
  // own prompt can be answered.
  const field=view.find(node=>node.type==='input');
  assert.equal(field.props.disabled,false);
  assert.match(field.props.placeholder,/Ctrl\+C/);
  field.props.onChange({target:{value:'my-package'}});
  await view.flush();
  view.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  await view.flush();await new Promise(resolve=>setTimeout(resolve,90));await view.flush();
  const answered=harness.calls.filter(call=>call.url.startsWith('/dsh-terminal/input'));
  assert.equal(answered.length,1);
  assert.deepEqual(answered[0].body,{id:'s1',data:'my-package\n'});
  // It is an answer, not a command, so only the command entered history.
  assert.equal(harness.calls.filter(call=>call.url.startsWith('/dsh-terminal/run')).length,1);
  view.unmount();
});

test('a dropped stream offers a retry instead of a permanent spinner',async()=>{
  const harness=pane({streamFails:true});
  const view=await harness.open();
  const alert=view.find(node=>node.props&&node.props.role==='alert');
  assert.ok(alert,'a failed stream must be reported');
  assert.match(textOf(alert),/no such terminal session/);
  assert.match(textOf(alert),/Reconnect/);
  view.unmount();
});

test('the pane says so honestly when no folder has been opened',async()=>{
  const harness=pane({roots:[{id:'cwd:/tmp/app',path:'/tmp/app',title:'app',registered:false}]});
  const view=await harness.open();
  assert.match(textOf(view.tree),/No workspace is open/);
  assert.match(textOf(view.tree),/\/tmp\/app/);
  // No shell is started behind the user's back in a folder they never chose.
  assert.ok(!harness.calls.some(call=>call.url.startsWith('/dsh-terminal/open')));
  assert.match(textOf(view.tree),/Choose a project folder/);
  // Choosing the fallback explicitly does start one there.
  const start=view.find(node=>node.type==='button'&&String(node.props.children).includes('Start a shell there'));
  assert.ok(start);
  start.props.onClick();
  await view.flush();await new Promise(resolve=>setTimeout(resolve,90));await view.flush();
  assert.equal(harness.calls.find(call=>call.url.startsWith('/dsh-terminal/open')).body.cwd,'/tmp/app');
  view.unmount();
});

test('the empty pane offers the workspace picker rather than inventing a folder',async()=>{
  const picked=[];
  const harness=pane({roots:[{id:'cwd:/tmp/app',path:'/tmp/app',title:'app',registered:false}]});
  const view=await harness.open({openWorkspace:()=>picked.push('ok')});
  view.find(node=>node.type==='button'&&String(node.props.children).includes('Choose a project folder')).props.onClick();
  assert.deepEqual(picked,['ok']);
  assert.ok(!harness.calls.some(call=>call.url.startsWith('/dsh-terminal/open')));
  view.unmount();
});

test('an exited shell reports its code and offers a new session',async()=>{
  const harness=pane();
  const view=await harness.open();
  harness.stream.push({kind:'session',session:harness.session,seq:0,truncated:false});
  harness.stream.push({kind:'exit',seq:1,exitCode:0,signal:null});
  await view.flush();await new Promise(resolve=>setTimeout(resolve,90));await view.flush();
  assert.match(textOf(view.tree),/The shell exited with code 0/);
  assert.match(textOf(view.tree),/Start a new session/);
  assert.equal(view.find(node=>node.type==='input').props.disabled,true);
  view.unmount();
});
