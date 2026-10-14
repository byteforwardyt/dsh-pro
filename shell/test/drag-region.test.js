import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(here, '..', 'src', 'chrome.cjs'), 'utf8')

/** The standalone frameless windows, which each drag their whole body. */
const WINDOWS = ['loading.html', 'error.html'].map((name) => ({
  name,
  source: readFileSync(join(here, '..', 'src', 'ui', name), 'utf8'),
}))

/**
 * Guard for a bug with no other symptom.
 *
 * A -webkit-app-region: drag ancestor claims its whole rect, and Chromium only
 * subtracts a descendant that generates a LAYOUT BOX and declares no-drag. An
 * opt-out written with a child combinator therefore fails silently the moment a
 * framework puts a display:contents wrapper in between — the wrapper has no
 * box, subtracts nothing, and every control below it goes dead to a real mouse
 * while elementFromPoint, pointer-events and a dispatched click() all keep
 * reporting health. That is exactly what shipped: the whole sidebar column was
 * draggable and none of it was clickable.
 *
 * So the rule is: anything made draggable must be opened back up with a
 * DESCENDANT selector. These tests fail if a child combinator comes back.
 */

/** Every selector block that sets a drag region, as [selector, value] pairs. */
function regionRules () {
  const rules = []
  const pattern = /([^{}]+)\{[^{}]*?-webkit-app-region:\s*(drag|no-drag)\s*;[^{}]*?\}/g
  let match
  while ((match = pattern.exec(CSS)) !== null) {
    const selector = match[1].split('*/').pop().trim()
    rules.push([selector, match[2]])
  }
  return rules
}

test('every draggable area has at least one rule declaring it', () => {
  const drags = regionRules().filter(([, value]) => value === 'drag')
  assert.ok(drags.length >= 1, 'expected at least one drag region')
})

test('no drag region is opened back up with a child combinator', () => {
  // The precise defect: `X > *` opts out only direct children, and a
  // display:contents wrapper between them contributes no box at all.
  const offenders = regionRules()
    .filter(([selector, value]) => value === 'no-drag' && /\>\s*\*/.test(selector))
    .map(([selector]) => selector)

  assert.deepEqual(offenders, [],
    'a no-drag opt-out uses a child combinator; use a descendant selector so it '
    + 'survives a display:contents wrapper — see the sidebarCol comment')
})

test('the sidebar column opts its descendants out, not just its children', () => {
  const rules = regionRules()
  const claimsDrag = rules.some(([selector, value]) =>
    value === 'drag' && /sidebarCol/.test(selector) && !/logoRow/.test(selector))
  assert.ok(claimsDrag, 'sidebarCol should still provide the traffic-light drag strip')

  const optsOut = rules.some(([selector, value]) =>
    value === 'no-drag' && /sidebarCol/.test(selector) && /\]\s+\*/.test(selector))
  assert.ok(optsOut,
    'sidebarCol must opt every descendant out with `[class*="sidebarCol"] *`, '
    + 'or its controls are unclickable')
})

test('the brand row opts out with a blanket selector, not a list of tag names', () => {
  // An enumeration of button/a/[role=button] is a list about UPSTREAM's markup,
  // which upstream can invalidate on any release — an <input> or a [tabindex]
  // host added to the brand row would go dead with nothing to signal it.
  const enumerated = /\[class\*="logoRow"\]\s+(button|a)\s*[,{]/.test(CSS)
  assert.equal(enumerated, false,
    'opt the brand row out with `[class*="logoRow"] *` rather than naming tags')
})

test('every frameless window that drags its body carves its content back out', () => {
  // Same defect as the sidebar, in miniature: these windows set drag on <body>,
  // so any control inside is unclickable unless something subtracts a box.
  for (const { name, source } of WINDOWS) {
    const dragsBody = /body\s*\{[^}]*-webkit-app-region:\s*drag/s.test(source)
    if (!dragsBody) continue
    const optsOut = /-webkit-app-region:\s*no-drag/.test(source)
    assert.ok(optsOut,
      `${name} makes its whole body draggable with no no-drag opt-out; any `
      + 'control added to it will be dead to the mouse')
  }
})

test('the brand row is re-claimed after the blanket opt-out, and outranks it', () => {
  // Specificity, in source order: (0,1,0) blanket opt-out, then (0,2,0) to
  // re-claim logoRow, then (0,2,1) so its own controls stay clickable. If the
  // re-claim were written unqualified as `[class*="logoRow"]` it would tie the
  // blanket rule at (0,1,0) and lose on source order.
  const blanket = CSS.indexOf('[class*="sidebarCol"] *')
  const reclaim = CSS.indexOf('[class*="sidebarCol"] [class*="logoRow"] {')
  const controls = CSS.indexOf('[class*="sidebarCol"] [class*="logoRow"] *')

  assert.ok(blanket !== -1, 'blanket opt-out missing')
  assert.ok(reclaim !== -1, 'logoRow drag handle must be qualified on sidebarCol to outrank the opt-out')
  assert.ok(controls !== -1, "logoRow's own controls must opt out again")
  assert.ok(reclaim > blanket, 'the re-claim must come after the blanket opt-out')
  assert.ok(controls > reclaim, "the controls' opt-out must come after the re-claim")
})

test('desktop screen headers leave every descendant control clickable', () => {
  const rules = regionRules().flatMap(([selectors, value]) => selectors.split(',').map(selector => [selector.trim(), value]))
  for (const selector of ['.dshd-home-toolbar', '[class~="VOzbGW_nav"]', '[class~="VOzbGW_header"]', '.dshd-tools-head']) {
    assert.ok(rules.some(([match, value]) => match === selector && value === 'drag'), `${selector} provides a drag handle`)
    assert.ok(rules.some(([match, value]) => match === `${selector} *` && value === 'no-drag'), `${selector} must leave all controls clickable`)
  }
})
