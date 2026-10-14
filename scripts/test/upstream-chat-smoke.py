import os
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, permissions=['clipboard-read','clipboard-write'])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(os.environ['DSH_QA_URL'])
    expect(page.get_by_text('What would you like to build?', exact=True)).to_be_visible(timeout=20000)
    for label in ['Continue', 'Skip for now']:
        button = page.get_by_role('button', name=label, exact=True)
        try:
            button.wait_for(state='visible', timeout=5000)
            button.click()
        except Exception:
            pass
    textarea = page.locator('[data-input-scroll] textarea') if os.environ.get('DSH_QA_SOURCE') else page.locator('[data-composer-input]')
    if os.environ.get('DSH_QA_SOURCE'):
        result = page.evaluate('''async path => (await (await fetch('/api/workspace.create', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method:'workspace.create',payload:{path,title:'Migration QA'}})})).json()).result''', os.environ['DSH_QA_HOME'])
        assert result['ok'], result
        page.reload()
        page.locator('button.hHd-Xa_newSession').click()
        expect(textarea).to_be_editable()
    if textarea.get_attribute('contenteditable') == 'false':
        textarea.click()
        print('WORKSPACE PICKER:', page.locator('body').inner_text()[-6000:], flush=True)
        page.screenshot(path='/tmp/dsh-workspace-picker.png')
    textarea.fill('Run the local migration fixture.')
    textarea.press('Enter')
    try:
        expect(page.get_by_text('Migration fixture completed.', exact=True)).to_be_visible(timeout=25000)
        block = page.locator('div').filter(has=page.locator('pre')).filter(has=page.get_by_role('button', name='Copy', exact=True))
        print('COPY BUTTONS:', page.get_by_role('button', name='Copy', exact=True).count(), flush=True)
        page.get_by_role('button', name='Copy', exact=True).nth(1).click()
        copied = page.evaluate('navigator.clipboard.readText()')
        assert copied.strip() == 'copy-fixture-ok', repr(copied)
        expect(page.get_by_role('tab', name='Preview', exact=True)).to_be_visible()
        page.get_by_role('tab', name='Preview', exact=True).click()
        expect(page.locator('.dshd-pv')).to_be_visible()
        page.get_by_role('tab', name='Files', exact=True).click()
        expect(page.locator('.dshd-fl')).to_be_visible()
        page.get_by_role('tab', name='Code', exact=True).click()
        expect(textarea).to_be_visible()
        assert not errors, errors
        print('PASS: migrated settings, local model turn, copy, Preview/Files/Code switching', flush=True)
    finally:
        print('PAGE:', page.locator('body').inner_text()[-8000:], flush=True)
        print('ERRORS:', errors, flush=True)
        page.screenshot(path='/tmp/dsh-migration-chat.png')
        browser.close()
