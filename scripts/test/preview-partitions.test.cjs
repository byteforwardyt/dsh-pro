const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('every per-chat browser partition retains permission, download and CSP guards', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../shell/src/main.cjs'), 'utf8');
  const start = source.indexOf('const guardedPreviewPartitions =');
  const end = source.indexOf('\nfunction openExternalIfAllowed', start);
  assert.ok(start > 0 && end > start);
  const sessions = new Map();
  const context = { PREVIEW_PARTITION: 'persist:dshd-preview',
    isLoopbackUrl: url => new URL(url).hostname === 'localhost',
    session: { fromPartition(name) {
      assert.ok(!sessions.has(name), 'guards are installed once');
      const handlers = {};
      sessions.set(name, handlers);
      return { setPermissionRequestHandler: fn => { handlers.request = fn; },
        setPermissionCheckHandler: fn => { handlers.check = fn; },
        on: (_, fn) => { handlers.download = fn; },
        webRequest: { onHeadersReceived: fn => { handlers.headers = fn; } } };
    } },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  for (const id of ['one', 'two', 'one']) vm.runInContext(`guardPreviewPartition('persist:dshd-preview:${id}')`, context);
  assert.equal(sessions.size, 2);
  for (const handlers of sessions.values()) {
    assert.equal(handlers.check(), false);
    handlers.request(null, 'camera', allowed => assert.equal(allowed, false));
    let blocked = false; handlers.download({ preventDefault() { blocked = true; } });
    assert.ok(blocked);
    handlers.headers({ url: 'http://localhost:4173', responseHeaders: {} }, result => {
      assert.match(result.responseHeaders['Content-Security-Policy'], /object-src 'none'/);
    });
  }
});
