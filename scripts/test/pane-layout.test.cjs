const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {themeCSS} = require('./helpers/theme-css.cjs');

test('only Code exposes the retained composer and tool panes reclaim its space', () => {
  const css = themeCSS();
  for (const view of ['trajectory','preview','files']) assert.ok(css.includes('[data-dshd-view='+view+']'));
  assert.ok(!css.includes('[data-dshd-view=terminal]'), 'the dock must not hide the chat composer');
  assert.ok(css.includes('wSkVaW_composerSeat"]{display:none!important}'));
  assert.ok(css.includes('--dsh-trajectory-bottom-clearance:16px!important'));
  assert.ok(css.includes('padding-bottom:0!important'));
  for (const name of ['client-ui-preview','client-ui-files','terminal']) {
    const src = fs.readFileSync(path.join(__dirname, '../../plugins',name,'lib/client.js'),'utf8');
    assert.doesNotMatch(src, /data-conversation-composer-overlay|--dsh-composer-height/);
  }
});

function loadPaneLayout(document) {
  const source = fs.readFileSync(path.join(__dirname, '../../plugins/client-ui-theme-holo/lib/client.js'), 'utf8');
  let helpers;
  vm.runInNewContext(source.replace('return { apply, inject:', 'return { apply, installPaneLayout, inject:'), {
    window: {__ModuleLoader__: {load (definition) { helpers = definition.factory(() => ({})) }}},
    document,
    MutationObserver: class { observe () {} disconnect () {} },
  });
  return helpers.installPaneLayout;
}

test('pane layout follows the active Preview tab', () => {
  const tabs = [
    { className: 'wSkVaW_tab', textContent: 'Chat', getAttribute: () => null },
    { className: 'wSkVaW_tab wSkVaW_tabActive', textContent: ' Preview ', getAttribute: name => name === 'aria-selected' ? 'true' : null },
  ];
  const bodyAttrs = new Map();
  const document = {
    querySelectorAll: (sel) => sel.includes('wSkVaW_tab') ? tabs : [],
    querySelector: (sel) => sel.includes('wSkVaW_tabs') ? { id: 'tabs' } : null,
    body: {
      setAttribute: (n, v) => bodyAttrs.set(n, v),
      getAttribute: (n) => (bodyAttrs.has(n) ? bodyAttrs.get(n) : null),
      removeAttribute: (n) => bodyAttrs.delete(n),
    },
  };
  const stop = loadPaneLayout(document)();
  assert.equal(bodyAttrs.get('data-dshd-view'), 'preview');
  stop();
  assert.equal(bodyAttrs.has('data-dshd-view'), false);
});

test('pane layout does not clear a plugin-owned view before tabs exist', () => {
  const bodyAttrs = new Map([['data-dshd-view', 'preview']]);
  const document = {
    querySelectorAll: () => [],
    querySelector: () => null,
    body: {
      setAttribute: (n, v) => bodyAttrs.set(n, v),
      getAttribute: (n) => (bodyAttrs.has(n) ? bodyAttrs.get(n) : null),
      removeAttribute: (n) => bodyAttrs.delete(n),
    },
  };
  loadPaneLayout(document)();
  assert.equal(bodyAttrs.get('data-dshd-view'), 'preview');
});

test('home Files and Preview dialogs do not receive conversation fill styles', () => {
  for (const className of ['dshd-fl', 'dshd-pv']) {
    const painted = new Map(), attrs = new Map();
    const style = { setProperty: (key, value) => painted.set(key, value), removeProperty: key => painted.delete(key) };
    const body = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) };
    const dialog = { className: 'dshd-tools', style, parentElement: body };
    const pane = { className, style, parentElement: dialog, closest: () => null };
    const document = { body, querySelectorAll: () => [],
      querySelector: selector => selector === '.dshd-pv, .dshd-fl' ? pane : null };
    const stop = loadPaneLayout(document)();
    assert.equal(painted.size, 0, 'dialog display must remain owned by its native open/close lifecycle');
    assert.equal(attrs.has('data-dshd-view'), false, 'modal content must not change the underlying chat view');
    stop();
  }
});

test('pane layout fills Preview without opting into the composer overlay', () => {
  const props = new Map();
  const style = (prefix) => ({
    setProperty: (k, v) => props.set(prefix + k, v),
    removeProperty: (k) => props.delete(prefix + k),
  });
  const seat = { style: style('seat:'), querySelector: () => null };
  const area = { style: style('area:') };
  const scroll = {
    style: style('scroll:'),
    querySelector: (sel) => sel.includes('composer') ? seat : null,
    querySelectorAll: (sel) => sel.includes('composer') ? [seat] : [],
  };
  const rootAttrs = new Map();
  const root = {
    setAttribute: (n, v) => rootAttrs.set(n, v),
    removeAttribute: (n) => rootAttrs.delete(n),
  };
  const paneAttrs = new Map();
  const pane = {
    className: 'dshd-pv',
    style: style('pane:'),
    setAttribute: (n, v) => paneAttrs.set(n, v),
    closest: (sel) => {
      if (sel.includes('wSkVaW_root')) return root;
      if (sel.includes('conversation-scroll') || sel.includes('scrollBody')) return scroll;
      if (sel.includes('viewArea')) return area;
      return null;
    },
  };
  const bodyAttrs = new Map();
  const document = {
    querySelectorAll: (sel) => {
      if (sel.includes('wSkVaW_root')) return [root];
      if (sel.includes('composer')) return [seat];
      return [];
    },
    querySelector: (sel) => sel.includes('dshd-pv') ? pane : null,
    body: {
      setAttribute: (n, v) => bodyAttrs.set(n, v),
      getAttribute: (n) => (bodyAttrs.has(n) ? bodyAttrs.get(n) : null),
      removeAttribute: (n) => bodyAttrs.delete(n),
    },
  };
  loadPaneLayout(document)();
  assert.equal(bodyAttrs.get('data-dshd-view'), 'preview');
  assert.equal(rootAttrs.get('data-dshd-pane'), 'preview');
  assert.equal(paneAttrs.has('data-conversation-composer-overlay'), false);
  assert.equal(props.get('seat:position'), undefined);
  assert.equal(props.get('area:flex'), '1 1 0%');
  assert.equal(props.get('area:display'), 'flex');
  assert.equal(props.get('pane:height'), 'auto');
});
