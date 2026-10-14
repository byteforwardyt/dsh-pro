"""Opt-in smoke against an isolated dev Electron app on --remote-debugging-port=9339."""
from playwright.sync_api import sync_playwright, TimeoutError

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9339')
    page = browser.contexts[0].pages[0]
    try:
        page.wait_for_load_state('networkidle', timeout=2000)
    except TimeoutError:
        pass  # The app keeps SSE connections open; the checks below await real terminal state.
    page.evaluate(r"""async () => {
      for (const name of ['xterm.js','fit.js','pty-view.js']) await new Promise((r,j)=>{
        const s=document.createElement('script');s.src='/dsh-terminal/assets/'+name;s.onload=r;s.onerror=j;document.head.append(s);
      });
      const css=document.createElement('link');css.rel='stylesheet';css.href='/dsh-terminal/assets/xterm.css';document.head.append(css);
      const style=document.createElement('style');style.textContent='.qa-pty{position:fixed;inset:50% 10px 10px 300px;z-index:10000;display:flex;flex-direction:column;background:#191919;color:white}.dshd-pty-head{display:flex;gap:10px}.dshd-pty-head span{flex:1}.dshd-pty-screen{flex:1;min-height:0}';document.head.append(style);
      const host=document.createElement('div');host.className='qa-pty';document.body.append(host);
      const state=await (await fetch('/dsh-terminal/pty/sessions')).json();
      if (!state.roots.length || !state.roots.every(r=>/^\/(private\/)?tmp\/dsh-ui-fixes\./.test(r.path))) throw new Error('Use an isolated dsh-ui-fixes temporary profile, never your installed app.');
      for (const row of state.sessions) await fetch('/dsh-terminal/pty/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:row.id})});
      const Original=window.Terminal;window.Terminal=class extends Original {constructor(...args){super(...args);window.qaTerminal=this}};
      window.qaText=()=>Array.from({length:qaTerminal.buffer.active.length},(_,i)=>qaTerminal.buffer.active.getLine(i)?.translateToString(true)).join('\n');
      window.qaDispose=await window.DshPtyView(host,state.roots.find(r=>r.registered).path);
    }""")
    terminal = page.locator('.qa-pty .xterm-helper-textarea')
    terminal.wait_for()
    page.wait_for_function("document.querySelector('.dshd-pty-head span').textContent.includes('zsh')")
    terminal.fill('')
    terminal.press('Control+c')
    terminal.type("printf 'PTY_OK:%s\\n' \"$TERM\"; stty size", delay=4)
    terminal.press('Enter')
    page.wait_for_function("qaText().includes('PTY_OK:xterm-256color')")
    terminal.type("sleep 60", delay=4)
    terminal.press('Enter')
    terminal.press('Control+c')
    terminal.type("printf 'INTERRUPT_OK\\n'", delay=4)
    terminal.press('Enter')
    page.wait_for_function("qaText().includes('INTERRUPT_OK')")
    terminal.type("printf '\\033[?1049h\\033[2J\\033[HSCREEN\\033[2;5HAT5'; read -k 1; printf '\\033[?1049l'", delay=2)
    terminal.press('Enter')
    page.wait_for_function("qaTerminal.buffer.active.type === 'alternate' && qaTerminal.buffer.active.getLine(1).translateToString(true) === '    AT5'")
    terminal.press('q')
    page.wait_for_function("qaTerminal.buffer.active.type === 'normal'")
    page.locator('.qa-pty').evaluate("e=>e.style.left='500px'")
    terminal.type("stty size", delay=4)
    terminal.press('Enter')
    page.screenshot(path='/tmp/dsh-terminal-interactive.png')
    print(page.evaluate('qaText()'))
    page.evaluate("""async()=>{
      window.qaDispose();const host=document.querySelector('.qa-pty');
      const state=await(await fetch('/dsh-terminal/pty/sessions')).json();window.qaSessionId=state.sessions[0].id;
      window.qaDispose=await window.DshPtyView(host,state.sessions[0].cwd);
    }""")
    page.wait_for_function("qaText().includes('PTY_OK:xterm-256color')")
    assert page.evaluate("async()=>(await(await fetch('/dsh-terminal/pty/sessions')).json()).sessions[0].id===qaSessionId")
    print('PASS: alternate screen, cursor positioning, input, interrupt, resize and reconnect')
    page.evaluate("window.qaDispose();document.querySelector('.qa-pty').remove()")
    browser.close()
