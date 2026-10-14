#!/usr/bin/env node
'use strict'
/**
 * Upgrade guard for the overlay.
 *
 * This product does not fork the harness; it layers on top of published
 * `@deepseek-ai/*` packages. That keeps the delta tiny, but it means we depend
 * on things upstream never promised us: CSS-module class names, design-token
 * names, slot names, and a provider catalog inside pi-ai.
 *
 * Every one of those dependencies fails SILENTLY. A renamed class does not
 * throw — the rule just stops matching and the traffic lights land back on the
 * brand row. A renamed token does not throw — the theme falls back to its
 * hardcoded default and looks almost right. That is the whole reason this
 * script exists: to turn silent cosmetic breakage into a loud non-zero exit.
 *
 * Run it before and after any `@deepseek-ai/*` bump:
 *
 *   node scripts/bump-check.cjs
 *
 * The selector and token lists are NOT hardcoded here. They are extracted from
 * our own source, so this stays true as our code changes rather than drifting
 * into a stale copy of it.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const MODULES = path.join(ROOT, 'node_modules', '.pnpm')

/** The pi-ai version the auth surface was written against. See docs/MASTER-PLAN.md §D.6. */
const PINNED_PI_AI = '0.87.1'

const results = []
const record = (ok, name, detail) => { results.push({ ok, name, detail }); return ok }

/** Our own source, as one string — the thing we extract dependencies from. */
function ourSource () {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(cjs|js|mjs)$/.test(entry.name)) files.push(full)
    }
  }
  walk(path.join(ROOT, 'shell', 'src'))
  walk(path.join(ROOT, 'plugins'))
  return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
}

/**
 * Concatenate the shipped client bundles we depend on. These are large, so read
 * them once and grep the string rather than shelling out per pattern.
 */
function harnessBundles () {
  if (!fs.existsSync(MODULES)) {
    throw new Error('node_modules/.pnpm not found — run an install first')
  }
  const chunks = []
  for (const dir of fs.readdirSync(MODULES)) {
    if (!dir.startsWith('@deepseek-ai+')) continue
    const pkgDir = path.join(MODULES, dir, 'node_modules', '@deepseek-ai')
    if (!fs.existsSync(pkgDir)) continue
    for (const name of fs.readdirSync(pkgDir)) {
      const lib = path.join(pkgDir, name, 'lib')
      if (!fs.existsSync(lib)) continue
      for (const file of fs.readdirSync(lib)) {
        if (!file.endsWith('.js')) continue
        try { chunks.push(fs.readFileSync(path.join(lib, file), 'utf8')) } catch {}
      }
    }
  }
  return chunks.join('\n')
}

// ── 6. CSS-module class names we match on ────────────────────────────────────
// We match the readable suffix (`[class*="sidebarCol"]`) rather than the full
// hashed name, so a rebuild that keeps the source class name is survivable. A
// RENAME is not, and that is what this catches.
function checkSelectors (source, bundles) {
  // Exact class-token (~=) selectors and substring (*=) selectors, in both
  // JS string spellings. The chrome layer writes CSS in a template literal, so its
  // selectors read [class*="x"]; the theme plugin builds the same CSS by
  // concatenating JS strings, where they read [class*=\"x\"]. Matching only the
  // first spelling made this guard structurally blind to every selector the
  // theme owns — it passed because chrome.cjs happened to name three of them
  // too, which is luck, not coverage.
  const found = [...source.matchAll(/\[class[~*]=\\?"([A-Za-z0-9_-]+)\\?"\]/g)].map((m) => m[1])
  // Our OWN classes are not an upstream dependency and must not be asserted
  // against upstream's bundles — this guard exists to catch upstream renames.
  // A rule may legitimately match on `dshd-` to exclude our own elements from
  // a selector, e.g. [class*="actions"]:not([class*="dshd-"]).
  const unique = [...new Set(found)].filter((cls) => !cls.startsWith('dshd-')).sort()
  const missing = unique.filter((cls) => !bundles.includes(cls))
  return record(missing.length === 0, `class names still present (${unique.length} checked)`,
    missing.length ? `MISSING: ${missing.join(', ')}` : unique.join(', '))
}

// ── 7. Design tokens we override ─────────────────────────────────────────────
// Overriding a token upstream no longer defines is not an error, it is a no-op
// that silently leaves the surface on its fallback colour.
function checkTokens (source, bundles) {
  const found = [...source.matchAll(/--dsw-(?:alias|specific)-[a-z0-9-]+/g)].map((m) => m[0])
  const unique = [...new Set(found)].sort()
  const missing = unique.filter((token) => !bundles.includes(token))
  return record(missing.length === 0, `design tokens still defined (${unique.length} checked)`,
    missing.length ? `MISSING: ${missing.join(', ')}` : `${unique.length} tokens resolve`)
}

// ── 5. Slot names we occupy ──────────────────────────────────────────────────
function checkSlots (source, bundles) {
  const found = [...source.matchAll(/["'`](conversation\.[a-z.]+|settings\.[a-z.]+|sidebar\.[a-z.]+|shell\.[a-z.]+)["'`]/g)]
    .map((m) => m[1])
  const unique = [...new Set(found)].sort()
  const missing = unique.filter((slot) => !bundles.includes(slot))
  return record(missing.length === 0, `slot names still exist (${unique.length} checked)`,
    missing.length ? `MISSING: ${missing.join(', ')}` : unique.join(', '))
}

// ── 3. The seam the allowlist subclasses ─────────────────────────────────────
function checkRegisterFlow (bundles) {
  const ok = bundles.includes('registerFlow')
  return record(ok, 'AuthorizationService.registerFlow still exists',
    ok ? 'found in shipped bundles' : 'GONE — the allowlist subclass has nothing to override')
}

// ── 2. authorization is still unmounted upstream ─────────────────────────────
// If upstream starts mounting it themselves, our profile row becomes a duplicate
// mount rather than the only one.
function checkAuthorizationUnmounted () {
  const patches = []
  const walk = (dir, depth) => {
    if (depth > 6 || !fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === 'cordis.patch.yml') patches.push(full)
    }
  }
  for (const dir of fs.readdirSync(MODULES)) {
    if (dir.startsWith('@deepseek-ai+dsh-bundle') || dir.startsWith('@deepseek-ai+dsh-base')
      || dir.startsWith('@deepseek-ai+dsh-web-app')) {
      walk(path.join(MODULES, dir), 0)
    }
  }
  const mounted = patches.filter((f) => /(^|\n)\s*-?\s*name:.*dsh-authorization/.test(fs.readFileSync(f, 'utf8')))
  const profile = fs.readFileSync(path.join(ROOT, 'shell/src/profile.cjs'), 'utf8')
  const sourceRows = mounted.flatMap(file => [...fs.readFileSync(file, 'utf8').matchAll(/- id: ([^\n]+)\n\s+name: ['"]?@deepseek-ai\/dsh-authorization/g)].map(match => match[1]))
  const ok = sourceRows.length === 1 && sourceRows[0] === 'authorization'
    && profile.includes("- id: authorization\n  disabled: true")
    && (profile.match(/name: '@dsh-desktop\/auth-allowlist'/g) || []).length === 1
  return record(ok, 'one upstream authorization row is replaced by the allowlist',
    ok ? 'upstream service disabled; exactly one allowlisted service inserted' : 'authorization composition changed; review replacement')
}

// ── 10. pi-ai pin ────────────────────────────────────────────────────────────
// 0.84.2 already changed the auth surface (required AbortSignal, an options arg
// on all four CredentialStore methods, a new isSubscription flag). A pi-ai bump
// is a scheduled migration, never a side effect of a harness bump.
function checkPiAiPin () {
  const dirs = fs.readdirSync(MODULES).filter((d) => d.startsWith('@earendil-works+pi-ai@'))
  const versions = [...new Set(dirs.map((d) => d.split('@')[2].split('_')[0]))]
  const ok = versions.length === 1 && versions[0] === PINNED_PI_AI
  return record(ok, `pi-ai pinned to ${PINNED_PI_AI}`,
    ok ? 'exact match' : `resolved: ${versions.join(', ') || 'none'} — treat as a migration`)
}

// ── 9. The provider catalog is fully accounted for ───────────────────────────
// Every OAuth-capable provider must be an explicit allow or an explicit deny.
// A new one that is neither would silently inherit whichever default we last
// happened to write.
function checkCatalogAccounted () {
  try {
    const out = execFileSync(process.execPath,
      ['--test', 'plugins/auth-allowlist/test/allowlist.test.js'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const pass = /# fail 0\b/.test(out)
    return record(pass, 'allowlist covers the live OAuth catalog',
      pass ? (out.match(/# pass (\d+)/) || [, '?'])[1] + ' assertions pass' : 'allowlist tests FAILED')
  } catch (error) {
    return record(false, 'allowlist covers the live OAuth catalog',
      `test run failed: ${String(error.message).split('\n')[0]}`)
  }
}

function main () {
  const source = ourSource()
  const bundles = harnessBundles()

  checkSelectors(source, bundles)
  checkTokens(source, bundles)
  checkSlots(source, bundles)
  checkRegisterFlow(bundles)
  checkAuthorizationUnmounted()
  checkPiAiPin()
  checkCatalogAccounted()

  let failed = 0
  for (const r of results) {
    if (!r.ok) failed++
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}\n        ${r.detail}`)
  }

  // Say plainly what this does NOT cover, so a green run is not mistaken for a
  // guarantee. These need a running host, and belong in the smoke run.
  console.log('\nNot covered here (needs a running host — see the capture run in shell/src/devtools.cjs):')
  console.log('  - --expose-internals still required, ready line still parseable')
  console.log('  - settings.mutate still accepts { op, path, value }')
  console.log('  - popovers still lay out inside centerCol (rounded-corner clipping)')

  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
