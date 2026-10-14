"""Disposable native credential-form probe. Only dummy keys and local endpoints."""
import os
import json
import re
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeoutError

artifacts = Path(os.environ.get('DSH_QA_ARTIFACTS', os.environ['DSH_QA_HOME']))
# Persistence round trips on the translated Intel runtime can exceed the
# assertion library's five-second default during cold startup.
expect.set_options(timeout=30000)
with sync_playwright() as p:
    native = bool(os.environ.get('DSH_QA_ELECTRON'))
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9342') if native else p.chromium.launch(headless=True)
    page = browser.contexts[0].pages[0] if native else browser.new_page(viewport={'width': 1400, 'height': 950})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script("localStorage.setItem('dshd.accounts.onboarding-dismissed', '1')")
    def key_checks():
        with urllib.request.urlopen(os.environ['DSH_QA_GAME_URL'] + '/__qa/key-status') as response:
            return json.load(response)

    def open_connections():
        if not page.get_by_role('dialog', name='Settings', exact=True).is_visible():
            page.get_by_role('button', name='Settings', exact=True).click()
        page.get_by_role('button', name='Model connections (advanced)', exact=True).click()
        expect(page.get_by_role('button', name='Add model provider', exact=True)).to_be_visible(timeout=15000)

    def reload_workspace():
        page.reload(wait_until='domcontentloaded')
        # Restoring the workspace updates the route. Opening Settings before
        # that completes can have the restore navigation close it again.
        expect(page.get_by_role('textbox', name=re.compile('Describe what you want to build'))).to_be_enabled(timeout=30000)
        page.wait_for_load_state('networkidle', timeout=15000)

    def fetch_models(id):
        before = key_checks()[id]
        page.get_by_role('button', name='Fetch available models', exact=True).click()
        deadline = time.monotonic() + 15
        while key_checks()[id] <= before:
            assert time.monotonic() < deadline, 'Saved fixture credential did not authenticate'
            page.wait_for_timeout(100)
        assert key_checks()['rejected'] == 0

    try:
        page.goto(os.environ['DSH_QA_URL'], wait_until='domcontentloaded')
        try:
            page.wait_for_load_state('networkidle', timeout=5000)
        except PlaywrightTimeoutError:
            pass  # Native host retains its event stream.
        # Fresh disposable profiles always show this asynchronous first-run
        # notice. Wait for it before navigating; Rosetta can render it later
        # than the initial Settings button.
        notice = page.get_by_role('dialog', name='Preview Notice', exact=True)
        expect(notice).to_be_visible(timeout=30000)
        notice.get_by_role('button', name='Continue', exact=True).click()
        expect(notice).not_to_be_visible()
        expect(page.get_by_role('button', name='Settings', exact=True)).to_be_visible(timeout=30000)
        open_connections()
        assert not page.locator('[data-slot-error]').count()
        assert not errors, errors
        page.screenshot(path=str(artifacts / 'api-forms.png'))
        print('PASS: native Advanced editor and Add provider render without slot errors', flush=True)
        for id in ['a', 'b']:
            page.get_by_role('button', name='Add model provider', exact=True).click()
            expect(page.get_by_role('tab', name='Third-party model provider', exact=True)).to_be_visible()
            expect(page.get_by_role('combobox', name='Provider', exact=True)).to_be_visible()
            expect(page.get_by_role('textbox', name='API key', exact=True)).to_have_attribute('type', 'password')
            page.get_by_role('tab', name='Custom model API', exact=True).click()
            form = page.get_by_role('tabpanel', name='Custom model API', exact=True)
            form.get_by_role('textbox', name='Provider ID', exact=True).fill('qa-api-' + id)
            form.get_by_role('textbox', name='Display name', exact=True).fill('QA API ' + id.upper())
            form.get_by_role('textbox', name='Base URL', exact=True).fill(os.environ['DSH_QA_GAME_URL'] + '/' + id + '/v1')
            form.get_by_role('combobox', name='API protocol', exact=True).select_option('openai-completions')
            form.get_by_role('textbox', name='API key', exact=True).fill('local-test-key-' + id + '-not-a-secret')
            fetch_models(id)
            picker = page.get_by_role('dialog', name='Choose models to add', exact=True)
            expect(picker).to_be_visible()
            picker.get_by_role('checkbox').first.check()
            picker.get_by_role('button', name='Add selected', exact=True).click()
            form.get_by_role('button', name='Create provider', exact=True).click()
            expect(page.get_by_role('button', name=re.compile('^Edit QA API ' + id.upper()))).to_be_visible(timeout=15000)
            assert not errors, errors
        reload_workspace()
        expect(page.get_by_role('button', name='Settings', exact=True)).to_be_visible(timeout=30000)
        open_connections()
        for id in ['a', 'b']:
            page.get_by_role('button', name=re.compile('^Edit QA API ' + id.upper())).click()
            key = page.get_by_role('textbox', name='API key', exact=True)
            expect(key).to_have_attribute('type', 'password')
            expect(key).to_have_value('')  # Stored secrets are not returned to the browser.
            page.get_by_text('Customized settings', exact=True).click()
            fetch_models(id)  # Uses the saved reference, not a newly supplied key.
            picker = page.get_by_role('dialog', name='Choose models to add', exact=True)
            expect(picker).to_be_visible(timeout=15000)
            picker.get_by_role('button', name='Cancel', exact=True).click()
            expect(picker).not_to_be_visible()
            page.get_by_role('textbox', name='Display name', exact=True).fill('QA API ' + id.upper() + ' saved')
            page.get_by_role('button', name='Apply', exact=True).click()
            expect(page.get_by_role('button', name=re.compile('^Edit QA API ' + id.upper() + ' saved'))).to_be_visible(timeout=15000)
        reload_workspace()
        expect(page.get_by_role('button', name='Settings', exact=True)).to_be_visible(timeout=30000)
        open_connections()
        page.get_by_role('button', name=re.compile('^Edit QA API A saved')).click()
        page.get_by_text('Customized settings', exact=True).click()
        fetch_models('a')  # Editing B and saving blank password fields did not erase A.
        result = {'ok': not errors, 'authenticated': key_checks(), 'pageErrors': errors}
        assert result['ok'] and result['authenticated']['rejected'] == 0, result
        artifacts.joinpath('api-forms-result.json').write_text(json.dumps(result, indent=2))
        print('PASS: two API keys saved, reload authenticated both, blank-key edits retained them, and the original key still works after adding/editing the second', flush=True)
    finally:
        artifacts.joinpath('api-forms-dom.txt').write_text(page.locator('body').inner_text())
        page.screenshot(path=str(artifacts / 'api-forms-final.png'))
        print('API_FORM_ARTIFACTS:', artifacts, flush=True)
        browser.close()
