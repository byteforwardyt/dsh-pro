const {test} = require('node:test');
const assert = require('node:assert/strict');
const {themeCSS, conversationBundle} = require('./helpers/theme-css.cjs');

// The composer's working ring is pure CSS keyed off upstream markup, so the
// thing worth testing is the joint between the two: our selector on one side
// and the shipped conversation bundle on the other. bump-check.cjs already
// guards the class tokens, but it extracts `[class~="..."]` and nothing else,
// so the element shape this selector actually turns on is invisible to it.

test('the composer fill follows the sidebar in both themes', () => {
  const css = themeCSS()
  const block = (opener) => {
    const start = css.indexOf(opener)
    assert.notEqual(start, -1, `theme block ${opener} is missing`)
    return css.slice(start, css.indexOf('}', start))
  }
  for (const [theme, opener] of [['light', 'body[data-dshd-desktop]{'], ['dark', 'body[data-ds-dark-theme][data-dshd-desktop]{']]) {
    assert.match(block(opener), /--dshd-composer-fill:var\(--dsw-specific-sidebar-fill\)/,
      `the ${theme} composer must take the sidebar's fill so the two surfaces stay one colour`)
  }
})

test('the working ring reads the stop glyph upstream still renders, and never resizes the card', () => {
  // Upstream gives the send seat no status class or attribute: the only thing
  // that changes when a turn starts is the accessible name, which is
  // translated, and the icon, which is not. The ring depends on the icon, so
  // an upstream redraw of it is what this asserts against.
  const bundle = conversationBundle().replace(/\s+/g, '')
  const seat = 'className:InputBar_module_css_default.primary'
  const start = bundle.lastIndexOf(seat)
  assert.notEqual(start, -1, 'upstream no longer builds the send seat from the primary class')
  const button = bundle.slice(start, start + 1200)
  assert.match(button, /children:primaryStops\?[^]{0,220}\("rect"/,
    'upstream stopped drawing the running state as a square: the ring has lost its signal')
  assert.match(button, /\("rect"[^]{0,260}\("path"/,
    'the idle send glyph is no longer the shape that distinguishes it from the running one')

  const css = themeCSS()
  const working = css.split('\n').filter((rule) => rule.includes(':has([class~="uV2eYG_primary"]>svg>rect)'))
  assert.ok(working.length >= 2, 'the ring and its reduced-motion variant should both key off the stop glyph')
  for (const rule of working) {
    assert.ok(rule.includes('::before'),
      `the working state must stay on the pseudo-element or the card will resize mid-turn: ${rule}`)
  }
  const reduced = css.slice(css.indexOf('@media(prefers-reduced-motion:reduce)'))
  assert.match(reduced, /uV2eYG_primary"\]>svg>rect\)::before\{animation:none/,
    'reduced motion must hold the ring still rather than drop it')
})

// The ring shipped once in a state that was on but did not read as moving, so
// these guard the two things that decide whether it turns at all and whether a
// 3px band of it is legible while it does.
test('the working ring actually turns, and interpolates rather than snapping', () => {
  const css = themeCSS()
  const working = css.split('\n').find((rule) =>
    rule.includes(':has([class~="uV2eYG_primary"]>svg>rect)::before') && rule.includes('animation:'))
  assert.ok(working, 'the working state declares no animation, so the ring would hold still')

  const spin = /animation:[^;}]*?dshd-composer-glow ([\d.]+)s linear infinite/.exec(working)
  assert.ok(spin, `the rotation is not a linear infinite turn: ${working}`)
  assert.ok(Number(spin[1]) > 0 && Number(spin[1]) <= 4,
    `a ${spin[1]}s turn is too slow to read in a 3px band; keep it at 4s or under`)

  // An unregistered custom property is not an interpolable type, so the
  // keyframe below would flip at the halfway mark instead of sweeping and the
  // ring would sit still and then jump once per cycle. The registration is
  // load-bearing, not decoration.
  assert.match(css, /@property --dshd-glow-angle\{syntax:"<angle>"/,
    'the angle must stay registered as <angle> or the rotation stops interpolating')
  assert.match(css, /@keyframes dshd-composer-glow\{to\{--dshd-glow-angle:360deg\}\}/,
    'the rotation keyframe no longer drives a full turn')
})

test('the ring carries a trackable highlight and never grows the card', () => {
  const css = themeCSS()
  const base = css.split('\n').find((rule) =>
    rule.includes('[class~="uV2eYG_card"]::before{content:""'))
  assert.ok(base, 'the ring pseudo-element is gone')

  const gradient = /background:conic-gradient\(from var\(--dshd-glow-angle[^)]*\),([^;]*)\)/.exec(base)
  assert.ok(gradient, `the ring is no longer an angle-driven conic gradient: ${base}`)
  // Evenly spaced repeats of the same silver read as static at this width:
  // motion is only visible if there is a bright head to follow, so require the
  // stops to be placed by hand and the head to be a minority of the sweep.
  const heads = gradient[1].split(',').filter((stop) => stop.includes('--dshd-glow-b'))
  assert.ok(heads.length >= 1, 'the gradient has no highlight stop to track')
  for (const stop of gradient[1].split(',')) {
    assert.match(stop.trim(), /^var\(--dshd-glow-[abc]\) -?[\d.]+deg$/,
      `every stop needs an explicit angle or the highlight smears into an even sweep: ${stop}`)
  }

  // The band is only visible where it escapes the card's opaque fill, and the
  // radius has to stay in step with that bleed or the corners go square.
  const inset = /inset:-(\d+)px/.exec(base)
  const radius = /border-radius:(\d+)px/.exec(base)
  assert.ok(inset && radius, 'the ring lost its inset or radius')
  const card = css.split('\n').find((rule) =>
    rule.includes('[class~="uV2eYG_card"]{position:relative'))
  const cardRadius = /border-radius:(\d+)px/.exec(card)
  assert.ok(cardRadius, 'the card rule lost its radius')
  assert.equal(Number(radius[1]), Number(cardRadius[1]) + Number(inset[1]),
    'the ring radius must be the card radius plus its bleed or the corners will not be concentric')

  // z-index:-1 is what keeps the ring behind the fill; without it the gradient
  // would wash over the draft.
  assert.match(base, /z-index:-1/, 'the ring must stay behind the card fill')
  assert.match(card, /position:relative;z-index:auto/,
    'the card must not form a stacking context or the ring flips in front of the fill')
})
