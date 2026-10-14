import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  applyMenuState, resetMenuState, VIEWS, VIEW_ITEM_ID, ITEM_PROBE_FIELD,
} from '../src/menu.cjs'

// Greying out a menu item is a two-file joint with no type between the halves:
// the page produces a probe, the menu reads named fields out of it, and every
// way this can break is silent. A renamed item id, a renamed probe field, or a
// probe that stops being sent all end in the same place - the menu simply never
// changes, which looks exactly like it working.
//
// The asymmetry that shapes every assertion below: a wrongly ENABLED item does
// nothing when clicked, while a wrongly DISABLED one swallows its accelerator
// and the keystroke is lost. So absence, malformation and novelty must all read
// as enabled, and only a measured false may disable.

const MENU_SOURCE = readFileSync(new URL('../src/menu.cjs', import.meta.url), 'utf8')
const BRAND_SOURCE = readFileSync(new URL('../../plugins/client-ui-brand/lib/client.js', import.meta.url), 'utf8')

/**
 * A menu double carrying the ids the real template carries.
 *
 * Items only, no roles or separators: those have no id, getMenuItemById returns
 * null for them, and the pass must leave them alone. The null return is the
 * behaviour being modelled, not a shortcut.
 */
function menuDouble () {
  const items = new Map()
  for (const id of VIEWS) items.set(VIEW_ITEM_ID(id), { enabled: true })
  for (const id of Object.keys(ITEM_PROBE_FIELD)) items.set(id, { enabled: true })
  return {
    items,
    getMenuItemById: (id) => items.get(id) ?? null,
    disabled: () => [...items].filter(([, item]) => !item.enabled).map(([id]) => id).sort(),
  }
}

/**
 * What the page reports on the home screen.
 *
 * Measured against the real render and against docs/BACKLOG.md item 3, which
 * names the state exactly: no view tabs, no sidebar toggle, no Session log. The
 * sidebar and its New Session button are still there, and so is the message
 * field - the home screen is where you type the first prompt. shell/test/
 * brand-actions.test.js drives the same shape out of the shipped module against
 * a home-screen DOM, so these two files cannot disagree for long.
 */
const HOME = {
  views: { chat: false, trajectory: false, preview: false, files: false },
  settings: true, newSession: true, sidebar: false, sessionLog: false, terminal: false, composer: true,
}

/** An open session on Chat: everything present. */
const CHAT = {
  views: { chat: true, trajectory: true, preview: true, files: true },
  settings: true, newSession: true, sidebar: true, sessionLog: true, terminal: true, composer: true,
}

test('the home screen greys out exactly the items that would do nothing', () => {
  const menu = menuDouble()
  // Measured against the real render: the conversation header draws no children
  // on the home screen, so there is no tab strip, no sidebar toggle and no
  // Session log. The sidebar itself is still there, so New Session and Settings
  // stay live - which is the point of doing this per control rather than per
  // screen.
  applyMenuState(HOME, menu)
  assert.deepEqual(menu.disabled(), [
    'dshd.sessionLog', 'dshd.sidebar', 'dshd.terminal',
    ...VIEWS.map(VIEW_ITEM_ID),
  ].sort())
})

test('opening a session brings every item back', () => {
  const menu = menuDouble()
  applyMenuState(HOME, menu)
  assert.equal(applyMenuState(CHAT, menu), 7, 'the same seven items should have flipped back')
  assert.deepEqual(menu.disabled(), [])
})

test('a view with no composer disables only the composer', () => {
  const menu = menuDouble()
  // Files and Terminal render no message field, so Focus Message Field has
  // nothing to focus - but every view tab is still there to switch to.
  applyMenuState({ ...CHAT, composer: false }, menu)
  assert.deepEqual(menu.disabled(), ['dshd.composer'])
})

test('a missing bottom-terminal control disables its menu item and no other', () => {
  const menu = menuDouble()
  applyMenuState({ ...CHAT, terminal: false }, menu)
  assert.deepEqual(menu.disabled(), ['dshd.terminal'])
})

test('anything other than a measured false leaves the item alone', () => {
  // Each of these is a real path: no state yet at launch, a page too old to
  // report a field this build has learned about, a renderer that sent garbage.
  // None of them may cost the user a keystroke.
  for (const probe of [null, undefined, 'nonsense', 42, [], {}, { views: null }, { views: 'no' }, { sidebar: 0 }, { sidebar: 'false' }]) {
    const menu = menuDouble()
    assert.equal(applyMenuState(probe, menu), 0, JSON.stringify(probe) ?? String(probe))
    assert.deepEqual(menu.disabled(), [], JSON.stringify(probe) ?? String(probe))
  }
})

test('a field the menu does not know about is ignored rather than guessed at', () => {
  const menu = menuDouble()
  applyMenuState({ ...CHAT, somethingNew: false }, menu)
  assert.deepEqual(menu.disabled(), [])
})

test('only items that actually change are written, and unknown ids are skipped', () => {
  const menu = menuDouble()
  assert.equal(applyMenuState(HOME, menu), 7)
  assert.equal(applyMenuState(HOME, menu), 0, 'a repeated state rewrote items that already held it')
  // A separator or a role has no id. Modelled by the double returning null.
  assert.equal(menu.getMenuItemById('role:copy'), null)
  assert.equal(applyMenuState(CHAT, { getMenuItemById: () => null }), 0)
})

test('a menu that is not there is not an error', () => {
  // getApplicationMenu returns null before the menu is built, and Electron is
  // not loaded at all in this test process.
  for (const menu of [null, undefined, {}, { getMenuItemById: 'no' }]) {
    assert.equal(applyMenuState(CHAT, menu), 0)
  }
})

test('reset re-enables everything, which is what a dead page has to leave behind', () => {
  const menu = menuDouble()
  applyMenuState(HOME, menu)
  assert.equal(menu.disabled().length, 7)
  resetMenuState(menu)
  assert.deepEqual(menu.disabled(), [], 'a closed or crashed page left items greyed out')
})

test('every id the enablement reads is really on an item in the template', () => {
  // The joint inside this one file. An id changed on the template and not here
  // makes applyMenuState a no-op for that item, with nothing to notice it.
  for (const id of [...VIEWS.map(VIEW_ITEM_ID), ...Object.keys(ITEM_PROBE_FIELD)]) {
    assert.ok(
      MENU_SOURCE.includes("id: '" + id + "'") || MENU_SOURCE.includes('id: VIEW_ITEM_ID(id)'),
      'no template item carries the id ' + id,
    )
  }
  // The view items are generated, so assert the generated form is present once
  // rather than looking for five literals that do not exist in the source.
  assert.ok(MENU_SOURCE.includes('id: VIEW_ITEM_ID(id)'), 'the view items stopped carrying generated ids')
})

test('every probe field the menu reads is really produced by the page', () => {
  // The joint ACROSS files, and the one that actually drifts: the probe lives
  // in a browser module the harness loads, so nothing links the two halves.
  for (const field of Object.values(ITEM_PROBE_FIELD)) {
    assert.match(
      BRAND_SOURCE,
      new RegExp(field + ':\\s*Boolean\\(find\\('),
      'probeControls no longer reports ' + field + ', so that menu item can never grey out',
    )
  }
  assert.match(BRAND_SOURCE, /views\[id\] = index >= 0 && Boolean\(tabs\[index\]\)/,
    'probeControls stopped reporting per-view presence')
  // And that it is pushed at all. A probe nobody sends is the failure mode with
  // no symptom: the menu just never changes.
  assert.match(BRAND_SOURCE, /bridge\.publishMenuState\(state\)/,
    'the page no longer publishes its probe, so enablement is dead code')
})
