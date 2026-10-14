"""Headless geometry regression using shipped styles and the upstream DOM contract."""
from pathlib import Path
import json
import re
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
upstream = next((root / 'node_modules/.pnpm').glob('@deepseek-ai+dsh-client-ui-conversation@*/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')).read_text()
base = next(json.loads(s) for s in re.findall(r'"(?:\\.|[^"\\])*"', upstream) if s.startswith('".wSkVaW_root{'))
theme = re.search(r'const CSS = `(.*?)`;', (root / 'plugins/client-ui-theme-holo/lib/client.js').read_text(), re.S).group(1)
inspector = re.search(r'const CSS = `(.*?)`;', (root / 'plugins/client-ui-inspector/lib/client.js').read_text(), re.S).group(1)
terminal = (root / 'plugins/terminal/lib/client.js').read_text()
command_minimum = int(re.search(r'const minimum = commands \? (\d+)', terminal).group(1))
terminal = re.search(r'const CSS = \[(.*?)\]\.join', terminal, re.S).group(1)
terminal = ''.join(json.loads(s) for s in re.findall(r'"(?:\\.|[^"\\])*"', terminal))
html = '''<body data-dshd-desktop><div class="pI_x6G_centerCol" style="height:800px">
<div data-slot="conversation" style="display:contents"><div class="wSkVaW_root" data-phase="active" data-dsh-inspector-open>
<div style="display:contents"><header style="height:64px"><button class="dshd-inspector-toggle">Sidebar</button></header></div>
<div class="wSkVaW_scrollBody" data-conversation-scroll><div data-slot="conversation.session" style="display:contents"><div class="wSkVaW_viewArea"><p>Short chat fixture</p></div></div><div class="wSkVaW_composerSeat" style="height:100px">Composer</div></div>
<div class="dshd-inspector-mount">Details</div></div></div></div></body>'''
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1400, 'height': 850})
    page.set_content('<style>body{margin:0}' + base + theme + inspector + terminal + '</style>' + html)
    seat = page.locator('.wSkVaW_composerSeat')
    def bottom():
        box = seat.bounding_box()
        return round(box['y'] + box['height'])
    assert bottom() == 800, bottom()
    page.evaluate("document.querySelector('.pI_x6G_centerCol').insertAdjacentHTML('beforeend','<div class=dshd-tm-dock>Terminal</div>')")
    dock = page.locator('.dshd-tm-dock').bounding_box()
    assert abs(bottom() - dock['y']) <= 1, (bottom(), dock)
    page.locator('.dshd-tm-dock').evaluate('e=>e.remove()')
    assert bottom() == 800, bottom()
    for mode in ['trajectory', 'preview', 'files']:
        page.evaluate('(mode)=>document.body.dataset.dshdView=mode', mode)
        assert not page.locator('.dshd-inspector-toggle').is_visible()
        assert not page.locator('.dshd-inspector-mount').is_visible()
        assert not seat.is_visible()
    page.evaluate('delete document.body.dataset.dshdView')
    assert page.locator('.dshd-inspector-toggle').is_visible()
    assert page.locator('.dshd-inspector-mount').is_visible()
    assert bottom() == 800
    page.locator('.wSkVaW_root').evaluate("e=>e.dataset.dshInspectorLayout='overlay'")
    assert page.locator('.wSkVaW_root').evaluate("e=>getComputedStyle(e).gridTemplateColumns") == '1400px'
    assert bottom() == 800
    # Long chats must remain wheel-scrollable with the inspector open. A plain
    # scrollTop assignment also works under overflow:hidden, so exercise wheel.
    page.locator('.wSkVaW_root').evaluate("e=>e.dataset.dshInspectorLayout='docked'")
    page.locator('.wSkVaW_viewArea').evaluate("e=>e.innerHTML='<div style=height:2600px>Long chat</div>'")
    chat = page.locator('[data-conversation-scroll]')
    assert chat.evaluate("e=>getComputedStyle(e).overflowY") == 'auto'
    chat.hover()
    page.mouse.wheel(0, 600)
    page.wait_for_function("document.querySelector('[data-conversation-scroll]').scrollTop > 100")
    chat_scroll = chat.evaluate('e=>e.scrollTop')
    sidebar = page.locator('.dshd-inspector-mount')
    sidebar.evaluate("e=>e.innerHTML='<aside class=dshd-inspector><div style=height:2000px>Details</div></aside>'")
    sidebar.hover()
    page.mouse.wheel(0, 600)
    page.wait_for_function("document.querySelector('.dshd-inspector-mount').scrollTop > 100")
    assert abs(chat.evaluate('e=>e.scrollTop') - chat_scroll) < 2
    page.screenshot(path='/tmp/dsh-sidebar-scroll.png')
    # Use the shipped dock minimum and CSS. The shell's former 170px minimum
    # clipped the form once the command view's header/status rows were present.
    command_html = '''<div class="dshd-tm-dock" style="height:HEIGHTpx">
    <div class="dshd-tm-resize"></div><div class="dshd-tm-modes"><button>Shell</button><button>Agent commands</button><span class="dshd-tm-spacer"></span><button>Maximize</button><button>Close</button></div>
    <div class="dshd-tm"><div class="dshd-tm-bar"><div class="dshd-tm-where"><strong>Workspace</strong><span>/workspace · zsh</span></div><i class="dshd-tm-spacer"></i><button class="dshd-tm-btn">Clear</button><button class="dshd-tm-btn">Restart</button></div>
    <div class="dshd-tm-out">OUTPUT</div>STATUS
    <form class="dshd-tm-form"><b>$</b><input class="dshd-tm-in" aria-label="Terminal command"><button type="button" class="dshd-tm-btn">Run</button></form></div></div>'''
    for width in [600, 1200]:
        page.set_viewport_size({'width': width, 'height': 800})
        for status in ['', '<div class="dshd-tm-status">Running<button class="dshd-tm-btn">Interrupt</button></div>', '<div class="dshd-tm-status" data-tone="error">The terminal service is unavailable. Try reconnecting.<button class="dshd-tm-btn">Reconnect</button></div>']:
            page.set_content('<style>*{box-sizing:border-box}body{margin:0;font:14px/1.5 sans-serif}' + terminal + '</style>' + command_html.replace('HEIGHT', str(command_minimum)).replace('OUTPUT', 'Output\n' * 50).replace('STATUS', status))
            dock = page.locator('.dshd-tm-dock').bounding_box()
            for selector in ['.dshd-tm-in', '.dshd-tm-form button']:
                box = page.locator(selector).bounding_box()
                assert box['y'] >= dock['y'] and box['y'] + box['height'] <= dock['y'] + dock['height'], (width, status, selector, box, dock)
            page.get_by_role('textbox', name='Terminal command').fill('printf verified')
            page.get_by_role('button', name='Run', exact=True).click(timeout=1000)
            assert page.locator('.dshd-tm-out').evaluate('e=>e.scrollHeight > e.clientHeight')
    page.screenshot(path='/tmp/dsh-terminal-minimum.png')
    browser.close()
print('PASS: composer restores; chat-only sidebar; independent scrolling; command input reachable at minimum height')
