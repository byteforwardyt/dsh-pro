import os, re, subprocess
from pathlib import Path
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright, expect
with sync_playwright() as p:
    browser=p.chromium.connect_over_cdp('http://127.0.0.1:9342')
    page=browser.contexts[0].pages[0]
    # The native picker captures its bridge when the module mounts. Set the
    # deterministic OS-folder result before mount; adoption/navigation stay real.
    page.add_init_script('window.__DSH_DIRECTORY_PICKER__={pick:async()=>window.__qaDirectoryPath || null}')
    page.reload(wait_until='domcontentloaded')
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    def console(m):
        if m.type=='error': errors.append(m.text)
        if m.type in ['error','warning']: print('CONSOLE:',m.type,m.text[:500],flush=True)
    page.on('console',console)
    try:
        try: page.wait_for_load_state('networkidle',timeout=5000)
        except PlaywrightTimeoutError: pass  # DSH keeps its plugin event stream open.
        # CDP attaches after first paint: include errors emitted before attachment.
        startup_log=Path(os.environ['DSH_QA_HOME']).parent/'diagnostics-24h.log'
        startup_errors=[line for line in startup_log.read_text().splitlines() if '[error]' in line]
        assert not startup_errors,startup_errors
        expect(page.get_by_text('What would you like to build?',exact=True)).to_be_visible(timeout=25000)
        for label in ['Continue','Skip for now']:
            try: page.get_by_role('button',name=label,exact=True).click(timeout=3000)
            except Exception: pass
        for width in [1440, 900]:
            page.set_viewport_size({'width':width,'height':900})
            page.wait_for_timeout(200)
            expect(page.get_by_text('Into the Unknown',exact=True)).not_to_be_visible()
            boxes=page.evaluate('''()=>{
                const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y,width:r.width}};
                return {root:box('.wSkVaW_root'),mark:box('.pXSMma_fishHitbox .dshd-brand-mark'),heading:box('.dshd-home-heading')};
            }''')
            assert abs(boxes['root']['x']-boxes['heading']['x'])<2,boxes
            assert abs(boxes['mark']['x']-boxes['heading']['x'])<2,boxes
            assert boxes['heading']['y']>boxes['mark']['y'],boxes
            header=page.evaluate('''()=>{
                const toolbar=document.querySelector('.dshd-home-toolbar');
                const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,centerY:r.top+r.height/2}};
                return {root:rect(document.querySelector('.wSkVaW_root')),toolbar:rect(toolbar),
                    title:rect(toolbar.firstElementChild),actions:rect(toolbar.querySelector('.dshd-home-toolbar-actions')),
                    parent:toolbar.parentElement.className,offsetParent:toolbar.offsetParent?.className};
            }''')
            assert abs(header['toolbar']['top']-header['root']['top'])<2,header
            assert abs(header['title']['centerY']-header['actions']['centerY'])<2,header
            assert header['toolbar']['height']==64,header
            assert abs(header['title']['left']-header['root']['left']-24)<2,header
            assert abs(header['root']['right']-header['actions']['right']-24)<2,header
            icons=page.evaluate('''()=>{
                const rail=document.querySelector('.hHd-Xa_collapsed');
                const mask=e=>getComputedStyle(e).maskImage;
                const buttons=[...document.querySelectorAll('.dshd-tools-trigger>svg')];
                const centers=rail?[...rail.querySelectorAll('.hHd-Xa_toggle svg,.hHd-Xa_newSession svg,.hHd-Xa_panelRow svg,.bhn1Oq_iconButton svg,.bhn1Oq_searchButton svg')].map(e=>{
                    const r=e.getBoundingClientRect();return r.x+r.width/2;
                }):[];
                return {masks:buttons.map(mask),centers};
            }''')
            assert icons['masks'] and all('data:image/svg+xml' in mask for mask in icons['masks']),icons
            if icons['centers']: assert max(icons['centers'])-min(icons['centers'])<2,icons
        page.screenshot(path='/tmp/dsh-upstream-native-welcome.png')
        # Keep native click coordinates inside the real 1280x860 Electron window.
        # Larger emulated sizes above are for layout measurement only.
        page.set_viewport_size({'width':1200,'height':800})
        # The frame settles its responsive collapse after resizing. Observe the
        # final state before clicking, otherwise the click can reopen the rail.
        page.wait_for_timeout(600)
        rail=page.locator('.hHd-Xa_root')
        if 'hHd-Xa_collapsed' not in rail.get_attribute('class'):
            page.locator('.hHd-Xa_toggle').click()
        expect(rail).to_have_class(re.compile('hHd-Xa_collapsed'))
        page.wait_for_timeout(300)
        collapsed=rail.evaluate('''rail=>{
            const rect=rail.getBoundingClientRect();
            return {center:rect.x+rect.width/2,icons:[...rail.querySelectorAll('.hHd-Xa_toggle svg,.hHd-Xa_newSession svg,.hHd-Xa_panelRow svg,.bhn1Oq_iconButton svg,.bhn1Oq_searchButton svg')].map(e=>{
                const r=e.getBoundingClientRect();return {center:r.x+r.width/2,visible:r.width>0};
            }).filter(e=>e.visible)};
        }''')
        # Toggle, new chat and all four navigation entries must be present;
        # workspace actions are checked too whenever that slot is mounted.
        assert len(collapsed['icons'])>=6,collapsed
        assert all(abs(icon['center']-collapsed['center'])<2 for icon in collapsed['icons']),collapsed
        page.screenshot(path='/tmp/dsh-native-collapsed.png')
        page.locator('.hHd-Xa_toggle').click()
        expect(rail).not_to_have_class(re.compile('hHd-Xa_collapsed'))
        print('PASS: welcome mark and heading centered at wide and narrow widths; no duplicate slogan',flush=True)
        for name in ['Files','Preview']:
            page.get_by_role('button',name='Open '+name.lower(),exact=True).click()
            dialog=page.get_by_role('dialog',name='Workspace tools',exact=True)
            expect(dialog).to_be_visible()
            expect(dialog.get_by_role('tab',name=name,exact=True)).to_have_attribute('aria-selected','true')
            dialog.get_by_role('button',name='Close workspace tools',exact=True).click()
            expect(dialog).not_to_be_visible()
        print('PASS: header at the top edge, title/actions aligned, Files and Preview buttons work',flush=True)
        composer=page.locator('[data-composer-input]')
        composer.fill('Native migration fixture one.')
        composer.press('Enter')
        expect(page.get_by_text('Migration fixture completed.',exact=True)).to_be_visible(timeout=25000)
        expect(page.locator('.dshd-home-toolbar')).not_to_be_visible()
        # The compact upstream opener has a 24px shell. Theme styling must not
        # put 34px buttons inside it and clip their icons below the centre line.
        for width in [1800, 1440, 1100, 900, 800, 650]:
            page.set_viewport_size({'width':width,'height':900})
            page.wait_for_timeout(200)
            opener=page.locator('.wSkVaW_headerUtilities [data-open-target]')
            expect(opener).to_be_visible(timeout=15000)
            geometry=opener.evaluate('''e=>{
                const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,height:r.height,cy:r.top+r.height/2}};
                const buttons=[...e.querySelectorAll('button')];
                return {shell:rect(e),buttons:buttons.map(rect),
                    icons:buttons.map(b=>b.querySelector('img,svg')).filter(Boolean).map(rect),
                    terminal:rect(document.querySelector('[data-dshd-terminal-toggle]')),
                    overflow:document.documentElement.scrollWidth>innerWidth};
            }''')
            assert abs(geometry['shell']['height']-geometry['terminal']['height'])<1,geometry
            assert abs(geometry['shell']['cy']-geometry['terminal']['cy'])<1,geometry
            assert all(b['top']>=geometry['shell']['top'] and b['bottom']<=geometry['shell']['bottom'] for b in geometry['buttons']),geometry
            assert all(abs(i['cy']-geometry['shell']['cy'])<1 for i in geometry['icons']),geometry
            assert not geometry['overflow'],geometry
            page.screenshot(path=f'/tmp/dsh-native-header-{width}.png')
        page.screenshot(path='/tmp/dsh-native-header-alignment.png')
        page.set_viewport_size({'width':1200,'height':800})
        page.get_by_role('button',name='More ways to open',exact=True).click()
        expect(page.get_by_role('menu')).to_be_visible()
        page.keyboard.press('Escape')
        expect(page.get_by_role('menu')).not_to_be_visible()
        print('PASS: Finder split control, icons and terminal align without clipping at six widths',flush=True)
        page.get_by_role('button',name='Copy',exact=True).nth(1).click()
        assert subprocess.check_output(['pbpaste'],text=True).strip()=='copy-fixture-ok'
        print('PASS: native chat and clipboard',flush=True)
        expect(page.get_by_role('button',name='Session sidebar',exact=True)).to_be_visible()
        image=page.get_by_role('button',name='View fixture.png larger in chat',exact=True)
        expect(image).to_be_visible(timeout=15000)
        assert image.locator('img').evaluate('e=>e.complete && e.naturalWidth>0')
        image.click()
        expect(page.get_by_role('dialog',name='Image preview')).to_be_visible()
        page.get_by_role('button',name='Back to message',exact=True).click()
        print('PASS: inline image and lightbox',flush=True)
        first=page.locator('[data-row-key^="session:"]').filter(has_text='Migration fixture completed').first.get_attribute('data-row-key')
        draft='Keep this ordinary-chat draft while viewing SuperCode.'
        composer.fill(draft)
        model=page.locator('button._7KE1Ra_trigger')
        expect(model).to_have_attribute('title','Fixture')
        model_label=model.get_attribute('aria-label')
        page.get_by_role('button',name='New SuperCode',exact=True).click()
        supercode=page.locator('.wSkVaW_root')
        expect(supercode).to_be_visible()
        expect(supercode.get_by_role('combobox',name='Team model',exact=True)).to_be_visible()
        supercode.get_by_role('combobox',name='Team model',exact=True).select_option('["fixture","fixture"]')
        assert page.locator('[data-slot-error]').count()==0
        # Only the folder-selection result is deterministic. Registration,
        # native blank-session navigation and draft transfer remain real.
        second_workspace=Path(os.environ['DSH_QA_HOME']).parent/'second-workspace'
        second_workspace.mkdir(exist_ok=True)
        page.evaluate('path=>{window.__qaDirectoryPath=path}',str(second_workspace))
        team_goal=supercode.locator('[data-composer-card] [contenteditable=true]')
        team_goal.fill('Keep this goal while changing workspace.')
        supercode.get_by_role('button',name='Choose workspace',exact=True).click()
        page.get_by_text('Add workspace…',exact=True).click()
        expect(supercode.get_by_role('button',name='Choose workspace',exact=True)).to_contain_text('second-workspace')
        expect(team_goal).to_have_text('Keep this goal while changing workspace.')
        expect(supercode.get_by_role('combobox',name='Team model',exact=True)).to_have_value('["fixture","fixture"]')
        supercode.get_by_role('button',name='Choose workspace',exact=True).click()
        page.get_by_text(re.compile('^default[ -]workspace$',re.I)).last.click()
        expect(team_goal).to_have_text('Keep this goal while changing workspace.')
        expect(supercode.get_by_role('combobox',name='Team model',exact=True)).to_have_value('["fixture","fixture"]')
        page.evaluate('delete window.__qaDirectoryPath')
        print('PASS: native workspace creation and switching preserve the unsent SuperCode goal',flush=True)
        page.screenshot(path=str(Path(os.environ['DSH_QA_HOME']).parent/'native-supercode-panel.png'))
        page.locator('[data-row-key="'+first+'"]').click()
        expect(supercode.get_by_role('combobox',name='Team model',exact=True)).to_have_count(0)
        expect(page.get_by_text('Migration fixture completed.',exact=True)).to_be_visible()
        expect(composer).to_have_text(draft)
        expect(model).to_have_attribute('title','Fixture')
        expect(model).to_have_attribute('aria-label',model_label)
        composer.fill('')
        print('PASS: real shell SuperCode registration and panel; ordinary chat, draft, and model preserved',flush=True)
        page.evaluate('''()=>{let Wrapped; Object.defineProperty(window,'Terminal',{configurable:true,get:()=>Wrapped,set:C=>{Wrapped=class extends C {constructor(...a){super(...a);window.qaTerminal=this;}}}});
        window.qaText=()=>Array.from({length:qaTerminal.buffer.active.length},(_,i)=>qaTerminal.buffer.active.getLine(i)?.translateToString(true)).join('\\n');}''')
        before=composer.bounding_box()
        page.get_by_role('button',name='Open terminal',exact=True).click()
        term=page.locator('.dshd-tm-dock .xterm-helper-textarea')
        expect(term).to_be_attached(timeout=15000)
        page.wait_for_function("document.querySelector('.dshd-pty-head span')?.textContent.includes('zsh')")
        term.focus()
        term.type("printf 'NATIVE_PTY_OK\\n'",delay=5)
        term.press('Enter')
        page.wait_for_function("window.qaText().includes('NATIVE_PTY_OK')",timeout=15000)
        page.get_by_role('button',name='Hide terminal panel',exact=True).click()
        expect(page.locator('.dshd-tm-dock')).to_have_count(0)
        after=composer.bounding_box()
        assert abs(before['y']-after['y'])<3,(before,after)
        print('PASS: bottom terminal input and composer restoration',flush=True)
        page.screenshot(path='/tmp/dsh-upstream-native-chat.png')
        page.get_by_role('tab',name='Preview',exact=True).click()
        expect(page.get_by_role('button',name='Session sidebar',exact=True)).not_to_be_visible()
        address=page.get_by_role('textbox',name='Address or search',exact=True)
        address.fill(os.environ['DSH_QA_GAME_URL']+'/one')
        address.press('Enter')
        expect(page.locator('webview')).to_be_attached()
        page.wait_for_function("document.querySelector('webview')?.executeJavaScript('document.body.innerText').then(t=>t.includes('Game One'))",timeout=15000)
        page.locator('webview').evaluate("e=>e.executeJavaScript(\"document.querySelector('button').click()\")")
        page.wait_for_function("document.querySelector('webview').executeJavaScript('document.body.innerText').then(t=>t.includes('Played'))")
        print('PREVIEW:',page.locator('webview').get_attribute('src'),flush=True)
        server=page.get_by_role('button',name='Preview server',exact=True)
        settings=page.get_by_role('region',name='Preview server settings',exact=True)
        expect(server).to_have_attribute('aria-expanded','false')
        expect(settings).not_to_be_visible()
        expect(page.locator('.dshd-pv:visible .dshd-pv-status')).not_to_be_visible()
        for width in [1800,1200,900,650]:
            page.set_viewport_size({'width':width,'height':900})
            page.wait_for_timeout(200)
            geometry=page.locator('.dshd-pv:visible').evaluate('''e=>{
                const bar=e.querySelector('.dshd-pv-bar').getBoundingClientRect();
                const body=e.querySelector('.dshd-pv-body').getBoundingClientRect();
                const controls=[...e.querySelectorAll('.dshd-pv-bar button,.dshd-pv-bar input,.dshd-pv-bar select')].map(x=>{const r=x.getBoundingClientRect();return {height:r.height,left:r.left,right:r.right}});
                return {width:e.clientWidth,height:bar.height,gap:body.top-bar.bottom,controls,overflow:document.documentElement.scrollWidth>innerWidth};
            }''')
            assert geometry['height'] <= (48 if geometry['width']>650 else 86),geometry
            assert abs(geometry['gap'])<1,geometry
            assert all(abs(c['height']-32)<1 for c in geometry['controls']),geometry
            assert not geometry['overflow'],geometry
            page.screenshot(path=f'/tmp/dsh-preview-toolbar-{width}.png')
        page.set_viewport_size({'width':1200,'height':800})
        page.locator('webview').evaluate("e=>e.dataset.qaPreserved='true'")
        server.click()
        expect(settings).to_be_visible()
        expect(settings.locator('.dshd-pv-server-heading')).to_contain_text('stopped')
        command=settings.get_by_role('textbox',name='Launch command',exact=True)
        expect(settings.get_by_role('button',name='Start',exact=True)).to_be_disabled()
        command.fill("node -e \"require('http').createServer((q,s)=>s.end('Managed preview')).listen(0,'127.0.0.1',function(){console.log('http://127.0.0.1:'+this.address().port)})\"")
        settings.get_by_role('button',name='Start',exact=True).click()
        expect(settings.locator('.dshd-pv-server-heading')).to_contain_text('ready',timeout=20000)
        server.click()
        expect(settings).not_to_be_visible()
        expect(server).to_have_attribute('title',re.compile('ready'))
        expect(page.locator('webview')).to_have_attribute('data-qa-preserved','true')
        page.wait_for_function("document.querySelector('webview').executeJavaScript('document.body.innerText').then(t=>t.includes('Played'))")
        server.click()
        settings.get_by_role('button',name='Stop',exact=True).click()
        expect(settings.locator('.dshd-pv-server-heading')).to_contain_text('stopped',timeout=15000)
        command.focus();page.keyboard.press('Escape')
        expect(settings).not_to_be_visible();expect(server).to_be_focused()
        server_route='**/dsh-files/preview/server?*'
        page.route(server_route,lambda route:route.fulfill(status=200,content_type='application/json',body='{"status":"exited","error":"Fixture server exited","output":"Fixture process stopped"}'))
        attention=page.get_by_role('button',name='Server needs attention — view details',exact=True)
        expect(attention).to_be_visible(timeout=10000)
        attention.click();expect(settings).to_be_visible()
        expect(settings.get_by_text('Fixture server exited',exact=True)).to_be_visible()
        page.unroute(server_route)
        expect(settings.locator('p')).not_to_have_text('Fixture server exited',timeout=10000)
        server.click();expect(settings).not_to_be_visible()
        # Starting a managed server legitimately changes this chat's selected
        # source. Restore the original fixture before the isolation assertions.
        address.fill(os.environ['DSH_QA_GAME_URL']+'/one');address.press('Enter')
        page.wait_for_function("document.querySelector('webview')?.executeJavaScript('document.body.innerText').then(t=>t.includes('Game One'))")
        print('PASS: compact preview header at four widths; server start/stop, hidden polling, Escape and live game state preserved',flush=True)
        page.locator('button.hHd-Xa_newSession').click()
        expect(composer).to_be_visible()
        composer.fill('Native migration fixture two.')
        composer.press('Enter')
        expect(page.get_by_text('Migration fixture completed.',exact=True)).to_be_visible(timeout=25000)
        # The generated title may settle at any point. Row identity, not title, is the durable assertion.
        keys=page.locator('[data-row-key^="session:"]').evaluate_all('(rows)=>rows.filter(e=>e.textContent.includes("Migration fixture completed")||e.textContent.includes("Native migration fixture two")).map(e=>e.dataset.rowKey)')
        second_key=next(key for key in keys if key!=first)
        page.get_by_role('tab',name='Preview',exact=True).click()
        address.fill(os.environ['DSH_QA_GAME_URL']+'/two');address.press('Enter')
        page.wait_for_function("document.querySelector('webview')?.executeJavaScript('document.body.innerText').then(t=>t.includes('Game Two'))")
        for key,name in [(first,'One'),(second_key,'Two'),(first,'One')]:
            page.locator('[data-row-key="'+key+'"]').click()
            page.get_by_role('tab',name='Preview',exact=True).click()
            page.wait_for_function("name=>document.querySelector('webview')?.executeJavaScript('document.body.innerText').then(t=>t.includes('Game '+name))",arg=name)
        print('PASS: separate previews retain each chat URL',flush=True)
        page.get_by_role('button',name='Settings',exact=True).click()
        page.get_by_text('Models',exact=True).click()
        search=page.get_by_role('searchbox',name='Search chat models')
        expect(search).to_be_visible();search.fill('fixture')
        switch=page.get_by_role('switch').first
        expect(switch).to_be_checked(timeout=15000)
        switch.click();expect(switch).not_to_be_checked();expect(switch).to_be_enabled()
        state=page.evaluate("async()=>(await(await fetch('/dsh-model-visibility')).json()).selections.fixture")
        assert state==[],state
        switch.click();expect(switch).to_be_checked();expect(switch).to_be_enabled()
        page.get_by_text('Advanced',exact=True).first.click()
        page.locator('summary').filter(has_text='Manage agent presets').click()
        expect(page.get_by_text('DSH Agent',exact=True).first).to_be_visible()
        page.get_by_text('Accounts',exact=True).first.click()
        expect(page.get_by_text('ChatGPT',exact=True).first).to_be_visible(timeout=15000)
        assert page.locator('[data-slot-error]').count()==0
        print('PASS: model toggles save, Advanced presets and Accounts render',flush=True)
        settings_icons=page.locator('.VOzbGW_navCell').evaluate_all('''cells=>cells.map(e=>({id:e.dataset.dshdNav,icon:getComputedStyle(e,'::before').maskImage}))''')
        assert all(row['id'] and 'data:image/svg+xml' in row['icon'] for row in settings_icons),settings_icons
        print('PASS: Material settings icons and collapsed navigation alignment',flush=True)
        page.screenshot(path='/tmp/dsh-upstream-native-preview.png')
        assert not errors,errors
    finally:
        print('PAGE:',page.locator('body').inner_text()[-6000:],flush=True)
        print('ERRORS:',errors,flush=True)
        page.screenshot(path='/tmp/dsh-upstream-native.png')
        browser.close()
