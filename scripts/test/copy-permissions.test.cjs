const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Copy is write-only, confined to the app main frame and exact host origin', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../shell/src/main.cjs'), 'utf8');
  const start = source.indexOf('function guardDefaultSession ()');
  const end = source.indexOf('\n}\n', start) + 2;
  let request, check;
  const wc = { getURL: () => 'http://127.0.0.1:42304/' };
  vm.runInNewContext(source.slice(start, end) + '\nguardDefaultSession()', {
    mainWindow: { webContents: wc },
    isHostUrl: url => { try { return new URL(url).origin === 'http://127.0.0.1:42304'; } catch { return false; } },
    session: { defaultSession: {
      setPermissionRequestHandler: fn => { request = fn; },
      setPermissionCheckHandler: fn => { check = fn; },
    } },
  });
  const detail = { isMainFrame: true, requestingUrl: wc.getURL() };
  assert.equal(check(wc, 'clipboard-sanitized-write', '', detail), true);
  request(wc, 'clipboard-sanitized-write', value => assert.equal(value, true), detail);
  for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'notifications'])
    assert.equal(check(wc, permission, '', detail), false);
  assert.equal(check(wc, 'clipboard-sanitized-write', '', { ...detail, isMainFrame: false }), false);
  assert.equal(check(wc, 'clipboard-sanitized-write', '', { ...detail, requestingUrl: 'http://127.0.0.1:5173' }), false);
  assert.equal(check({ getURL: wc.getURL }, 'clipboard-sanitized-write', '', detail), false);
  assert.equal(check(wc, 'clipboard-sanitized-write', '', undefined), false);
});
