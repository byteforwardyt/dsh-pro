import os, re
from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    try:
        page.goto(os.environ['DSH_QA_URL'])
        for label in ['Continue','Skip for now']:
            try: page.get_by_role('button',name=label,exact=True).click(timeout=4000)
            except Exception: pass
        row=page.locator('[data-row-key^="session:"]').filter(has_text=re.compile('Run the local migration fixture|Migration fixture completed')).first
        expect(row).to_be_visible(timeout=20000)
        row.click()
        expect(page.get_by_text('Migration fixture completed.',exact=True)).to_be_visible(timeout=25000)
        expect(page.get_by_text('Run the local migration fixture.',exact=True).last).to_be_visible()
        expect(page.locator('[data-composer-input]')).to_be_editable()
        page.locator('[data-composer-input]').fill('Continue the migrated fixture.')
        page.locator('[data-composer-input]').press('Enter')
        expect(page.get_by_text('Migration fixture completed.',exact=True)).to_have_count(2,timeout=25000)
        assert not errors,errors
        print('PASS: legacy 0.1 chat reopened with original user/assistant messages; a new 0.2 turn completed in the same chat',flush=True)
    finally:
        print('PAGE:',page.locator('body').inner_text()[-4000:],flush=True)
        print('ERRORS:',errors,flush=True)
        page.screenshot(path='/tmp/dsh-migrated-existing-chat.png')
        browser.close()
