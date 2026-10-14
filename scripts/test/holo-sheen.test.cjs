const {test} = require('node:test');
const assert = require('node:assert/strict');
const {themeCSS} = require('./helpers/theme-css.cjs');

// The dark sheen was once a set of near-white stops. It looked deliberate in
// the source and wrong on screen: measured against a real render it sat below
// chroma 0.035 across 92% of the label at every phase of the drift, so the
// clipped glyphs read as grey. Nothing in the CSS says "this is too pale", so
// this file measures the stops instead of trusting them.

const DARK_SELECTOR = 'body[data-ds-dark-theme][data-dshd-desktop]{';
const TOKEN = /--dshd-holo-sheen:linear-gradient\(([^;]*)\);/;

/** sRGB channel to linear light. */
const toLinear = (channel) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

/**
 * OKLab lightness, chroma and hue for a #rrggbb stop.
 *
 * Chroma is the number that matters here: it is the one that distinguishes a
 * colour effect from a grey one, and it is perceptually uniform enough that a
 * single threshold means the same thing at every lightness. Hue is only
 * meaningful when chroma is not near zero, which is why nothing below asserts
 * on the hue of the cream stop.
 */
function oklab (hex) {
  const r = toLinear(parseInt(hex.slice(0, 2), 16));
  const g = toLinear(parseInt(hex.slice(2, 4), 16));
  const b = toLinear(parseInt(hex.slice(4, 6), 16));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    C: Math.hypot(A, B),
    h: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360,
  };
}

/** WCAG relative luminance, for the contrast check against the dark page. */
const luminance = (hex) => 0.2126 * toLinear(parseInt(hex.slice(0, 2), 16)) +
  0.7152 * toLinear(parseInt(hex.slice(2, 4), 16)) +
  0.0722 * toLinear(parseInt(hex.slice(4, 6), 16));

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The gradient's stops, first and last deduplicated (they are the loop seam). */
function stops (css, {dark}) {
  const dividerAt = css.indexOf(DARK_SELECTOR);
  assert.notEqual(dividerAt, -1, 'the dark theme block is gone, so this file is measuring the wrong stops');
  const block = dark ? css.slice(dividerAt) : css.slice(0, dividerAt);
  const found = block.match(TOKEN);
  assert.ok(found, `no --dshd-holo-sheen in the ${dark ? 'dark' : 'light'} block`);
  const hexes = [...found[1].matchAll(/#([0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
  assert.equal(hexes.length, 6, 'the sheen should be six stops');
  assert.equal(hexes[0], hexes[5], 'the first and last stop must match or the drift snaps once per cycle');
  return hexes.slice(0, 5).map((hex) => ({hex, ...oklab(hex)}));
}

test('the dark sheen is a colour effect, not a grey one', () => {
  const dark = stops(themeCSS(), {dark: true});
  const mean = dark.reduce((sum, s) => sum + s.C, 0) / dark.length;
  // Light measures 0.155 mean. Dark cannot match it — sRGB caps violet chroma
  // at 0.054 near L=0.89 — but the palette that shipped before this bar
  // measured 0.050, which is the failure being guarded against.
  assert.ok(mean >= 0.10,
    `mean OKLab chroma ${mean.toFixed(4)} is below 0.10: the dark sheen has gone pale again`);
  const coloured = dark.filter((s) => s.C >= 0.05);
  assert.ok(coloured.length >= 4,
    `only ${coloured.length} of 5 stops carry chroma >= 0.05`);
});

test('exactly one stop stays near-white, and it is the one that kills the green transit', () => {
  const dark = stops(themeCSS(), {dark: true});
  const pale = dark.filter((s) => s.C < 0.05);
  // Interpolating the cyan stop into a saturated amber crosses a vivid green in
  // sRGB, which at dark-theme lightness reads neon rather than iridescent. A
  // near-white stop in that slot removes the transit and turns the segment into
  // a specular pass, which is what makes the sweep read as foil. Two pale stops
  // would be the old flat palette creeping back.
  assert.equal(pale.length, 1, `expected one near-white stop, found ${pale.length}`);
  assert.ok(pale[0].L >= 0.90, 'the pale stop must be a highlight, not a muddy one');
  const cyanAt = dark.findIndex((s) => s.h > 150 && s.h < 240 && s.C >= 0.05);
  assert.notEqual(cyanAt, -1, 'the cyan stop is gone');
  assert.equal(dark.indexOf(pale[0]), cyanAt + 1,
    'the near-white stop must sit immediately after the cyan one or the green transit comes back');
});

test('dark and light stay the same material, cut for different surfaces', () => {
  const css = themeCSS();
  const dark = stops(css, {dark: true});
  const light = stops(css, {dark: false});
  assert.equal(dark.length, light.length, 'the two cuts have different stop counts');
  for (let i = 0; i < dark.length; i++) {
    // Hue is undefined at near-zero chroma, so only compare stops that have one.
    if (dark[i].C < 0.05 || light[i].C < 0.05) continue;
    const delta = Math.abs(((dark[i].h - light[i].h + 540) % 360) - 180);
    assert.ok(delta <= 2,
      `stop ${i} drifted ${delta.toFixed(1)} degrees from the light cut, so the two no longer read as one material`);
  }
});

test('every dark stop stays legible on the dark page', () => {
  const dark = stops(themeCSS(), {dark: true});
  // #191919 is --dsw-alias-bg-base in the same block. The label is clipped text,
  // so a stop that goes dim is unreadable rather than merely subtle.
  const worst = Math.min(...dark.map((s) => contrast(s.hex, '191919')));
  assert.ok(worst >= 4.5,
    `the darkest stop contrasts ${worst.toFixed(2)}:1 against the page, below the 4.5:1 floor`);
});
