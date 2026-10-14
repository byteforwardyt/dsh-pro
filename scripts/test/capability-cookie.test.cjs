const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The API capability travels through three files that cannot import each other:
// the fence is ESM inside the harness process, the shell is CommonJS in the
// Electron main process, and the phone proxy is a third module that has to
// restate the cookie because a LAN client never carries one. Each holds its own
// copy of the name, and a mismatch would not throw — it would fail closed, and
// present as every panel in the app answering 403 with nothing in the log to
// say why. Comments in two of those files promise this test exists.

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const FENCE = 'plugins/host-files-api/lib/trust.js';
const SHELL = 'shell/src/main.cjs';
const PROXY = 'shell/src/phone-access.cjs';
const HOST = 'shell/src/host-process.cjs';

/** The single-quoted literal assigned to `name` in `source`. */
function literal (source, name, file) {
  const found = source.match(new RegExp(`(?:export )?const ${name} = '([^']+)'`));
  assert.ok(found, `${file} no longer declares ${name}`);
  return found[1];
}

test('every copy of the capability cookie name agrees', () => {
  const fence = literal(read(FENCE), 'CAPABILITY_COOKIE', FENCE);
  const shell = literal(read(SHELL), 'CAPABILITY_COOKIE', SHELL);
  const proxy = literal(read(PROXY), 'HOST_CAPABILITY_COOKIE', PROXY);
  assert.equal(shell, fence, `${SHELL} seeds a cookie the fence does not read`);
  assert.equal(proxy, fence, `${PROXY} forwards a cookie the fence does not read`);
});

test('the proxy does not collide the pairing cookie with the capability', () => {
  const proxy = read(PROXY);
  // The proxy owns two cookies with opposite trust: one proves the phone paired
  // with this Mac, the other proves the caller is the app. Sharing a name would
  // let a paired phone's own cookie satisfy the host fence.
  assert.notEqual(literal(proxy, 'COOKIE', PROXY), literal(proxy, 'HOST_CAPABILITY_COOKIE', PROXY),
    'the pairing cookie and the capability cookie share a name');
});

test('the shell mints the capability and hands it to the harness by env', () => {
  const host = read(HOST);
  const envName = literal(read(FENCE), 'CAPABILITY_ENV', FENCE);
  assert.match(host, new RegExp(`${envName}: capability`),
    `${HOST} no longer passes the capability through ${envName}`);
  // 32 random bytes. A short or predictable value would pass every other test
  // here while leaving the fence guessable.
  assert.match(host, /const capability = crypto\.randomBytes\(32\)\.toString\('hex'\)/,
    `${HOST} no longer mints a 32-byte capability`);
});

test('the proxy replaces the client cookie rather than appending to it', () => {
  const proxy = read(PROXY);
  const deleteAt = proxy.indexOf('delete headers.cookie');
  const setAt = proxy.indexOf('headers.cookie = ');
  assert.notEqual(deleteAt, -1, 'the proxy stopped stripping the client cookie');
  assert.notEqual(setAt, -1, 'the proxy stopped restating the capability');
  // Order is load-bearing: setting first and deleting after would send the
  // harness nothing, and appending would forward the phone's pairing cookie.
  assert.ok(deleteAt < setAt, 'the proxy sets the capability before stripping the client cookie, so it sends none');
});

test('the capability is seeded before every window load', () => {
  const shell = read(SHELL);
  // Seeding after loadURL is a race the window usually wins, which is the worst
  // kind of bug: it works on a warm boot and 403s on a cold one.
  // `win.loadURL` rather than `loadURL`: the new-window handler also loads a
  // URL, but into an external browser view that must never carry the cookie.
  const loads = [...shell.matchAll(/win\.loadURL\(/g)].map((m) => m.index);
  // Initial boot and Retry now share the sound-aware reveal gate; its actual
  // navigation must still seed the cookie, as must reopen and crash recovery.
  assert.match(shell, /await revealBootedHost\(win, started\.url, started\.launchUrl\)/);
  assert.match(shell, /await revealBootedHost\(win, hostUrl\)/);
  assert.equal(loads.length, 3,
    `the app window is loaded in ${loads.length} places; each one needs the capability seeded first`);
  let previous = -1;
  for (const at of loads) {
    const seeded = shell.lastIndexOf('seedCapabilityCookie()', at);
    assert.ok(seeded > previous,
      `a window load at offset ${at} is not preceded by its own seedCapabilityCookie()`);
    previous = at;
  }
});
