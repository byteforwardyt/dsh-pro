"""Opt-in UI/host smoke against a disposable /tmp/dsh-agent-qa.* Electron profile.
Launch that profile with --remote-debugging-port=9340; dismiss onboarding first.
No inference requests or real user chat modifications are made.
"""
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.connect_over_cdp('http://127.0.0.1:9340')
    page = browser.contexts[0].pages[0]

    def rpc(method, payload):
        result = page.evaluate('''async ([method,payload]) => (await (await fetch('/api/'+method, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload})
        })).json()).result''', [method, payload])
        assert result['ok'], result
        return result['value']

    workspaces = rpc('workspace.list', {})['items']
    assert workspaces and all('/tmp/dsh-agent-qa.' in row['path'] for row in workspaces)
    page.reload()
    expect(page.get_by_role('button', name='Access mode', exact=False)).to_be_visible()
    expect(page.get_by_role('button', name='Select model', exact=False)).to_be_visible()
    expect(page.get_by_text('Standard mode', exact=True)).to_have_count(0)
    page.get_by_role('button', name='Settings', exact=True).click()
    expect(page.get_by_role('button', name='Agent presets', exact=True)).to_have_count(0)
    page.get_by_role('button', name='Advanced', exact=True).click()
    summary = page.get_by_text('Manage agent presets', exact=True)
    assert not summary.evaluate('e => e.parentElement.open')
    summary.click()
    expect(page.get_by_role('button', name='In use: DSH Agent', exact=True)).to_be_visible()
    page.get_by_role('button', name='Set as default: Minimal mode', exact=True).click()
    expect(page.get_by_role('button', name='In use: Minimal mode', exact=True)).to_be_visible()
    page.reload()
    page.get_by_role('button', name='Settings', exact=True).click()
    page.get_by_role('button', name='Advanced', exact=True).click()
    page.get_by_text('Manage agent presets', exact=True).click()
    expect(page.get_by_role('button', name='In use: Minimal mode', exact=True)).to_be_visible()
    page.get_by_role('button', name='Set as default: DSH Agent', exact=True).click()
    expect(page.get_by_role('button', name='In use: DSH Agent', exact=True)).to_be_visible()
    created = rpc('session.create', {'workspaceId': workspaces[0]['workspaceId']})
    assert created['agentPreset'] == 'dsh-agent'
    history = rpc('session.history', {'sessionId': created['sessionId']})
    assert history['projections']['values']['permissions']['currentValue'] == 'workspace-write'
    legacy = [row for row in rpc('session.list', {})['items'] if row['sessionId'] == 'dsh-agent-legacy-qa']
    assert legacy and legacy[0]['agentPreset'] == 'standard'
    page.screenshot(path='/tmp/dsh-agent-advanced.png')
    page.get_by_role('button', name='Back to app', exact=True).click()
    print('PASS: new default, legacy session preserved, no permission widening, chat controls, Advanced, persisted selection')
