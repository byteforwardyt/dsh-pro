"""Opt-in live UI check; requires the isolated dsh-ui-fixes profile and QA catalog.

No inference requests are sent. Preferences for the QA provider are restored.
"""
from playwright.sync_api import sync_playwright, expect, TimeoutError

with sync_playwright() as p:
    app = p.chromium.connect_over_cdp('http://127.0.0.1:9339')
    app_page = app.contexts[0].pages[0]
    roots = app_page.evaluate("async()=>(await(await fetch('/dsh-terminal/pty/sessions')).json()).roots")
    assert roots and all('/tmp/dsh-ui-fixes.' in root['path'] for root in roots), 'Use the isolated QA profile'
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1400, 'height': 1000})
    context.add_cookies(app.contexts[0].cookies())
    page = context.new_page()
    page.goto(app_page.url)
    try:
        page.wait_for_load_state('networkidle', timeout=2000)
    except TimeoutError:
        pass  # The app has persistent SSE connections; wait for specific UI below.
    page.get_by_role('button', name='Skip for now', exact=True).click()
    original = page.evaluate("async()=>(await(await fetch('/dsh-model-visibility')).json()).selections['visibility-qa'] ?? null")
    try:
        page.get_by_role('button', name='Settings', exact=True).click()
        page.get_by_role('button', name='Models', exact=True).click()
        group = page.get_by_role('region', name='Model visibility QA', exact=True)
        expect(group.get_by_role('switch')).to_have_count(3)
        catalog_before = page.evaluate("async()=>(await(await fetch('/dsh-model-visibility/catalog')).json()).groups")
        group.get_by_role('button', name='Show all', exact=True).click()
        alpha = group.get_by_role('switch', name='Alpha', exact=False)
        expect(alpha).to_be_checked()
        alpha.click()
        expect(group.get_by_text('2 of 3 shown', exact=True)).to_be_visible()
        expect(alpha).not_to_be_checked()
        alpha.click()
        expect(group.get_by_text('3 of 3 shown', exact=True)).to_be_visible()
        assert page.evaluate("async()=>(await(await fetch('/dsh-model-visibility/catalog')).json()).groups") == catalog_before
        group.get_by_role('button', name='Hide all', exact=True).click()
        expect(group.get_by_text('0 of 3 shown', exact=True)).to_be_visible()
        page.get_by_role('searchbox', name='Search chat models').fill('beta')
        group.get_by_role('button', name='Show matching', exact=True).click()
        expect(group.get_by_text('1 of 3 shown', exact=True)).to_be_visible()
        page.reload()
        page.get_by_role('button', name='Settings', exact=True).click()
        page.get_by_role('button', name='Models', exact=True).click()
        expect(group.get_by_label('Beta', exact=False)).to_be_checked()
        expect(group.get_by_label('Alpha', exact=False)).not_to_be_checked()
        page.screenshot(path='/tmp/dsh-model-visibility.png')
        page.get_by_role('button', name='Back to app', exact=True).click()
        page.get_by_role('button', name='Select model', exact=False).click()
        page.get_by_role('menuitem').click()
        expect(page.get_by_role('menuitemradio', name='Beta', exact=False)).to_be_visible()
        expect(page.get_by_role('menuitemradio')).to_have_count(1)
        page.get_by_role('menuitemradio', name='Beta', exact=False).click()
        page.get_by_role('button', name='Settings', exact=True).click()
        page.get_by_role('button', name='Models', exact=True).click()
        group.get_by_role('button', name='Hide all', exact=True).click()
        expect(group.get_by_text('0 of 3 shown', exact=True)).to_be_visible()
        page.get_by_role('button', name='Back to app', exact=True).click()
        page.get_by_role('button', name='Select model, current Beta', exact=True).click()
        page.get_by_role('menuitem').click()
        expect(page.get_by_role('menuitemradio', name='Beta', exact=False)).to_be_visible()
        expect(page.get_by_role('menuitemradio')).to_have_count(1)
        page.get_by_role('button', name='Settings', exact=True).click()
        page.get_by_role('button', name='Model connections (advanced)', exact=True).click()
        expect(page.get_by_text('Loading model catalog…', exact=True)).not_to_be_visible()
        expect(page.get_by_role('button', name='Models', exact=True)).to_have_count(1)
        print('PASS: on/off switches preserve catalog, search, bulk choice, reload persistence, live picker filtering, hidden active model retained, advanced navigation')
    finally:
        page.evaluate("""async(models)=>{
          const state=await(await fetch('/dsh-model-visibility')).json();
          const response=await fetch('/dsh-model-visibility',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({provider:'visibility-qa',models,revision:state.revision})});
          if(!response.ok)throw Error('Could not restore QA preferences');
        }""", original)
        browser.close()
