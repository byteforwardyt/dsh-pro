"""Opt-in isolated Electron preview test. Requires three seeded QA chats and fixture servers."""
import os
from playwright.sync_api import sync_playwright, expect

QA_ROOT = os.environ['DSH_PREVIEW_QA_ROOT']
assert QA_ROOT.startswith('/tmp/dsh-preview-qa.')

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9339')
    page = browser.contexts[0].pages[0]
    roots = page.evaluate("async()=>(await(await fetch('/dsh-files/roots')).json()).roots")
    assert roots and all('/tmp/dsh-preview-qa.' in row['path'] for row in roots), roots
    page.evaluate('''async()=>{for(const name of ['one','two','three']) await fetch('/dsh-files/preview/server',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'stop',sessionId:'preview-qa2-'+name})});}''')
    page.evaluate('''async()=>{
      for(const name of ['one','two','three']) {
        const method='session.history';
        await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{sessionId:'preview-qa2-'+name}})});
      }
    }''')
    page.reload()
    urls = {}
    for name in ['one', 'two', 'three']:
        page.get_by_text('Preview QA ' + name, exact=True).first.click()
        page.get_by_role('tab', name='Preview', exact=True).click()
        page.get_by_role('button', name='Preview server', exact=True).click()
        summary = page.locator('.dshd-pv-server-heading')
        summary.wait_for()
        folder = page.get_by_role('textbox', name='Project folder', exact=True)
        expect(folder).to_be_visible()
        folder.fill(QA_ROOT + '/' + name)
        page.get_by_role('textbox', name='Launch command', exact=True).fill('node server.cjs')
        page.get_by_role('button', name='Start', exact=True).click()
        page.wait_for_function("document.querySelector('webview')?.src?.startsWith('http://127.0.0.1:')", polling=100)
        page.wait_for_function("document.querySelector('webview')?.executeJavaScript('document.body.innerText').then(t=>t.includes('Game '+" + repr(name.title()) + "))", polling=100)
        urls[name] = page.locator('webview').get_attribute('src')
        page.locator('webview').evaluate("e=>e.executeJavaScript(\"document.querySelector('button').click();document.body.innerText\")")
        page.wait_for_function("document.querySelector('webview').executeJavaScript('document.body.innerText').then(t=>t.includes('Played '+" + repr(name.title()) + "))", polling=100)
        print(name, urls[name], 'rendered and interacted')
    assert len(set(urls.values())) == 3
    for name in ['one', 'three', 'two', 'one']:
        page.get_by_text('Preview QA ' + name, exact=True).first.click()
        page.get_by_role('tab', name='Preview', exact=True).click()
        page.wait_for_function("url=>document.querySelector('webview')?.src===url", arg=urls[name], polling=100)
        page.wait_for_function("document.querySelector('webview').executeJavaScript('document.body.innerText').then(t=>t.includes('Game '+" + repr(name.title()) + "))", polling=100)
    expect(page.get_by_text('Preview errors (1)', exact=True)).to_be_visible()
    page.screenshot(path='/tmp/dsh-preview-three-chats.png')
    server = page.get_by_role('button', name='Preview server', exact=True)
    if server.get_attribute('aria-expanded') != 'true': server.click()
    page.get_by_role('button', name='Stop', exact=True).click()
    expect(page.locator('.dshd-pv-server-heading')).to_contain_text('stopped')
    for name in ['two','three']:
        result = page.evaluate("async name=>(await(await fetch('/dsh-files/preview/server?sessionId=preview-qa2-'+name)).json()).status", name)
        assert result == 'ready'
    page.get_by_role('button', name='Start', exact=True).click()
    expect(page.locator('.dshd-pv-server-heading')).to_contain_text('ready', timeout=15000)
    print('PASS: independent browsers, arbitrary ports, interaction, errors, stop and restart')
