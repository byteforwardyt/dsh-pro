const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {conversationBundle} = require('./helpers/theme-css.cjs');

// The conversation view ring is named in two files that cannot import each
// other: the native menu is CommonJS in the Electron main process, and the
// actions it drives live in a browser module the harness's own loader
// evaluates. A drift between them does not throw. It presents as a menu item
// and a keystroke that silently do nothing, which is the hardest class of bug
// to notice, so the copies are compared here. Both files' comments promise it.

const root = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const MENU = 'shell/src/menu.cjs';
const CLIENT = 'plugins/client-ui-brand/lib/client.js';
const TERMINAL = 'plugins/terminal/lib/client.js';

/** The string array assigned to `name` in `source`, in order. */
function list (source, name, file) {
  const found = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(found, `${file} no longer declares ${name}`);
  return [...found[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

test('the menu and the client name the same views, in the same order', () => {
  const menu = list(read(MENU), 'VIEWS', MENU);
  const client = list(read(CLIENT), 'VIEWS', CLIENT);
  assert.ok(menu.length >= 4, 'the view ring lost entries');
  // Order matters twice over: it is the order the header draws, and the index
  // is what assigns Cmd+1..Cmd+4, so a reorder silently remaps the keystrokes.
  assert.deepEqual(menu, client);
  // selectView refuses a label outside this list, so a view the menu offers and
  // the client does not know is a dead item rather than a fallback.
  assert.deepEqual([...new Set(menu)], menu, 'a view label is repeated');
  // Ids, not labels. A capital letter here means someone put a display string
  // back into the ring, which is how Cmd+1 died in every non-English locale.
  for (const id of menu) assert.equal(id, id.toLowerCase(), `${id} is a label, not a slot id`);
  // The menu still has to print something for each one.
  const labels = read(MENU).slice(read(MENU).indexOf('const VIEW_LABELS'));
  for (const id of menu) assert.match(labels, new RegExp(`^\\s*${id}: '.+',$`, 'm'), `${id} has no menu label`);
});

test('no two menu items claim the same accelerator', () => {
  const source = read(MENU);
  const explicit = [...source.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]);
  // The view ring builds its accelerator from the index rather than a literal.
  const views = list(source, 'VIEWS', MENU).map((_, index) => `CmdOrCtrl+${index + 1}`);
  const all = [...explicit, ...views];
  assert.deepEqual([...new Set(all)].sort(), all.slice().sort(),
    `two menu items share a keystroke: ${all.join(', ')}`);
  // The ones a user reaches for constantly, pinned so a refactor has to mean it.
  assert.ok(all.includes('CmdOrCtrl+,'), 'Settings lost Cmd+,');
  assert.ok(all.includes('CmdOrCtrl+N'), 'New Session lost Cmd+N');
  assert.ok(all.includes('CmdOrCtrl+B'), 'the sidebar toggle lost Cmd+B');
  assert.ok(all.includes('CmdOrCtrl+5'), 'the bottom Terminal toggle lost Cmd+5');
  for (const accelerator of views) assert.ok(all.includes(accelerator), `${accelerator} is unassigned`);
});

test('upstream still renders the tab strip the way selectView indexes it', () => {
  // selectView takes the nth tab in the conversation's own tab strip, where n
  // is the view's position in the live conversation.view registrations. That
  // rests on three things upstream owns: the strip is the element carrying the
  // hashed tabs class and role="tablist", it holds one role="tab" child per
  // registered view, and it renders them in slot order. A bump that regroups or
  // reorders them remaps every accelerator with no error to notice.
  const bundle = conversationBundle();
  assert.match(bundle, /className: ConversationRoot_module_css_default\.tabs,\s*role: "tablist",\s*"data-conversation-tabs": "",\s*children: tabs\.map\(\(viewTab\) =>/,
    'the conversation tab strip changed shape: re-read it before trusting the View menu');
  assert.match(bundle, /jsx\)\("button", \{\s*type: "button",\s*role: "tab",/,
    'view tabs are no longer role="tab" buttons, so the strip lookup finds nothing');
});

test('upstream still produces view labels through a translation call', () => {
  // This is the measurement the whole id-based ring rests on. If labels ever
  // became plain strings, matching on them would be legitimate again - and while
  // they stay functions, anything matching their English output is broken in
  // every other locale.
  assert.match(conversationBundle('dsh-client-ui-chat'), /id: "chat",[\s\S]{0,200}?label: \(\) => t\(/,
    'upstream no longer translates the view label; the ring can be revisited');
});

test('upstream still marks the composer scrollport, which is how the caret finds it', () => {
  // focusComposer scopes to [data-input-scroll] so it cannot land in the Files
  // editor. bump-check verifies hashed class names but not data attributes, so
  // this is the check for that one.
  assert.match(conversationBundle(), /"data-input-scroll": true/,
    'the composer scrollport lost its marker: Focus Message Field has nothing to scope to');
  assert.match(conversationBundle(), /"data-composer-input": true/);
  assert.ok(read(CLIENT).includes("composer: '[data-composer-input]'"));
});

test('no menu accelerator steals a keystroke the terminal view binds', () => {
  // A menu accelerator is handled before the renderer sees the key, and on the
  // Linux target - which is a shipped artifact, not a hypothetical: see the
  // AppImage in scripts/deploy-site.sh:24 - CmdOrCtrl resolves to Ctrl. So any
  // Ctrl+<key> the terminal binds is dead the moment the menu claims
  // CmdOrCtrl+<same key>, with no error and nothing to notice.
  const bound = new Set([...read(TERMINAL).matchAll(/event\.ctrlKey && \(event\.key === "([a-z])"/g)]
    .map((match) => match[1].toUpperCase()));
  assert.ok(bound.size > 0, 'the terminal key handler moved; re-read this before trusting it');
  for (const [, key] of read(MENU).matchAll(/accelerator: 'CmdOrCtrl\+([A-Z])'/g)) {
    assert.ok(!bound.has(key),
      `CmdOrCtrl+${key} is a menu accelerator and the terminal binds Ctrl+${key}, which the menu now swallows on Linux`);
  }
  // Only the literal accelerators are checked here. Electron's built-in roles
  // carry their own, and role:'copy' does collide with the terminal's Ctrl+C
  // interrupt on Linux today - recorded in docs/BACKLOG.md rather than fixed
  // here, because unregistering it changes copy on every platform.
});
