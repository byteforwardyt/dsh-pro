#!/usr/bin/env node
'use strict'
/**
 * Generate THIRD_PARTY_NOTICES.md from what actually ships.
 *
 * The app redistributes several hundred packages inside its bundle, so the
 * notice has to be generated from the staged tree rather than hand-maintained —
 * a hand-written list is wrong the moment a transitive dependency changes, and
 * wrong in the direction that matters (a missing attribution, not a spurious
 * one).
 *
 * Reads the staged closure, groups packages by license, reproduces each
 * distinct license text once, and calls out copyleft licenses separately
 * because those carry obligations the permissive ones do not.
 *
 *   node scripts/generate-notices.cjs [--arch arm64|x64]
 *
 * Run it after staging and before packaging; `npm run pack` does both.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

/**
 * Which staged slices to describe.
 *
 * A release ships several artifacts (both DMGs, the Linux AppImage), and a few
 * packages are platform/arch-suffixed — including the one that matters most, the
 * LGPL libvips build, which differs per platform. Describing only one slice
 * would put the wrong package name in another artifact's own notice. Scan every
 * staged tree — darwin-*, linux-*, win32-* — and union them, so one accurate
 * file ships in all of them. Pass --arch to restrict to a single macOS slice.
 */
const requestedArch = arg('arch', null)
const stagingDir = path.join(ROOT, 'staging')
const IS_SLICE = /^(darwin|linux|win32)-/
const slices = (requestedArch ? [`darwin-${requestedArch}`]
  : (fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir).filter((d) => IS_SLICE.test(d)) : []))
  .filter((slice) => fs.existsSync(path.join(stagingDir, slice, 'node_modules')))

if (!slices.length) {
  console.error('no staged tree found under staging/\nRun: npm run stage:all')
  process.exit(1)
}

const outFile = path.join(ROOT, 'THIRD_PARTY_NOTICES.md')

/**
 * Licenses that impose obligations beyond "keep the notice". These get their
 * own section, because burying an LGPL dependency in an alphabetical list of
 * four hundred MIT packages is technically a disclosure and practically not.
 */
const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|CDDL|CC-BY-SA)/i

/** Walk node_modules, including one level of scope directories. */
function collect (root) {
  const packages = []
  if (!fs.existsSync(root)) return packages

  const readPkg = (dir) => {
    const manifest = path.join(dir, 'package.json')
    if (!fs.existsSync(manifest)) return
    let data
    try { data = JSON.parse(fs.readFileSync(manifest, 'utf8')) } catch { return }
    if (!data.name) return

    let license = data.license
    if (!license && Array.isArray(data.licenses)) {
      license = data.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ')
    }
    if (license && typeof license === 'object') license = license.type
    if (!license) license = 'UNKNOWN'

    // The verbatim text, when the package ships one.
    let text = null
    for (const entry of fs.readdirSync(dir)) {
      if (!/^(LICEN[CS]E|COPYING|NOTICE)/i.test(entry)) continue
      const full = path.join(dir, entry)
      try {
        if (fs.statSync(full).isFile()) { text = fs.readFileSync(full, 'utf8').trim(); break }
      } catch {}
    }

    packages.push({
      name: data.name,
      version: data.version || '',
      license: String(license),
      homepage: data.homepage || (data.repository && (data.repository.url || data.repository)) || '',
      text,
    })
  }

  // Read a package directory and follow its own nested node_modules. Doing the
  // nested descent HERE rather than in the loop below is the whole point: for a
  // scoped entry the loop's `dir` is the SCOPE directory, so the old code looked
  // for node_modules/@aws-sdk/node_modules — which never exists — instead of
  // node_modules/@aws-sdk/credential-provider-sso/node_modules, which does.
  // That silently omitted 7 shipped packages, and because the hoisted copies
  // were listed at DIFFERENT versions, a spot-check by name looked clean.
  const visit = (dir) => {
    readPkg(dir)
    const nested = path.join(dir, 'node_modules')
    if (fs.existsSync(nested)) packages.push(...collect(nested))
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    const dir = path.join(root, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(dir, { withFileTypes: true })) {
        if (scoped.isDirectory()) visit(path.join(dir, scoped.name))
      }
    } else {
      visit(dir)
    }
  }
  return packages
}

const found = slices.flatMap((slice) =>
  collect(path.join(stagingDir, slice, 'node_modules')))
if (!found.length) {
  console.error(`no packages found in ${slices.join(', ')}`)
  process.exit(1)
}

// Deduplicate by name@version; the closure legitimately contains the same
// package reachable by several paths.
const byKey = new Map()
for (const pkg of found) {
  const key = `${pkg.name}@${pkg.version}`
  if (!byKey.has(key) || (!byKey.get(key).text && pkg.text)) byKey.set(key, pkg)
}
const packages = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))

const copyleft = packages.filter((p) => COPYLEFT.test(p.license))
const byLicense = new Map()
for (const pkg of packages) {
  if (!byLicense.has(pkg.license)) byLicense.set(pkg.license, [])
  byLicense.get(pkg.license).push(pkg)
}
const licenses = [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length)

const lines = []
lines.push('# Third-party notices')
lines.push('')
lines.push('DSH PRO redistributes the packages below inside its application bundle.')
lines.push('This file is generated from the staged closure that actually ships — see')
lines.push('`scripts/generate-notices.cjs`. Do not edit it by hand.')
lines.push('')
lines.push(`Packages: **${packages.length}**  ·  distinct licenses: **${licenses.length}**`)
lines.push('')
lines.push(`Covers every architecture this release ships: ${slices.map((s) => '`' + s + '`').join(', ')}.`)
lines.push('')
lines.push('DSH PRO itself is MIT licensed; see `LICENSE`. It is an enhanced desktop')
lines.push('client built on DeepSeek Harness, and is not affiliated with, endorsed by, or')
lines.push('an official release of DeepSeek or DeepSeek Harness.')
lines.push('')

if (copyleft.length) {
  lines.push('## Copyleft dependencies — read this part')
  lines.push('')
  lines.push('These carry obligations beyond keeping a notice. They are listed separately')
  lines.push('so they are not lost among the permissive ones.')
  lines.push('')
  for (const pkg of copyleft) {
    lines.push(`### ${pkg.name} ${pkg.version} — ${pkg.license}`)
    lines.push('')
    if (pkg.homepage) lines.push(`Source: ${String(pkg.homepage).replace(/^git\+/, '')}`)
    lines.push('')
    if (/^LGPL/i.test(pkg.license)) {
      lines.push('Redistributed as a **prebuilt dynamic library**, not statically linked into')
      lines.push('the application. Because it is a separate loadable library, a recipient can')
      lines.push('replace it with their own build, which is the relinking freedom the LGPL')
      lines.push('requires. Obligations that remain: ship this notice, identify the library and')
      lines.push('its license, and make its source available to anyone who asks — the upstream')
      lines.push('project URL above satisfies that as long as it stays reachable.')
      lines.push('')
    }
  }
  lines.push('')
}

// Electron is a devDependency of the shell and never stages, so it cannot be
// discovered by the scan above — but its Chromium/V8/FFmpeg binaries are the
// single largest body of third-party code in the bundle.
lines.push('## Electron, Chromium, V8 and FFmpeg')
lines.push('')
lines.push('The application runs on Electron, which bundles Chromium, V8 and FFmpeg.')
lines.push('These are not npm packages and do not appear in the list below; their')
lines.push('notices ship alongside this file inside the app bundle as')
lines.push('`LICENSE.electron` (MIT) and `LICENSES.chromium.html` (the full set of')
lines.push('Chromium component licenses, including BSD, LGPL and MPL terms).')
lines.push('')
lines.push('Source: https://github.com/electron/electron')
lines.push('')

// qrcode-generator is vendored as source (shell/src/vendor/qrcode.cjs), not
// installed from npm, so the closure scan cannot see it. It renders the phone
// pairing QR. Its MIT header travels inside the file; this records it here too.
lines.push('## Vendored source')
lines.push('')
lines.push('One file is vendored as source rather than installed from npm, so it does')
lines.push('not appear in the list below. Its full license header travels inside the')
lines.push('file itself.')
lines.push('')
lines.push('- **qrcode-generator** by Kazuhiko Arase — MIT — '
  + 'https://github.com/kazuhikoarase/qrcode-generator — '
  + 'shipped as `shell/src/vendor/qrcode.cjs`, renders the phone-access pairing QR.')
lines.push('')

lines.push('## Packages by license')
const symbols = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/client-ui-theme-holo/material-symbols.json'), 'utf8'))
lines.splice(lines.length - 1, 0,
  '## Google Material Symbols', '',
  `Material Symbols Rounded by Google — Apache-2.0. Source: ${symbols.source}`,
  `Pinned revision: ${symbols.revision}. SVG artwork is bundled locally.`, '',
  '```text', symbols.license.trim(), '```', '')
lines.push('')
for (const [license, pkgs] of licenses) {
  lines.push(`### ${license} (${pkgs.length})`)
  lines.push('')
  lines.push(pkgs.map((p) => `\`${p.name}@${p.version}\``).join(', '))
  lines.push('')
}

lines.push('## License texts')
lines.push('')
lines.push('Each distinct license text below is reproduced once, from the copy shipped by')
lines.push('the first package that carries it.')
lines.push('')
const seenText = new Set()
for (const [license, pkgs] of licenses) {
  const carrier = pkgs.find((p) => p.text)
  if (!carrier) continue
  const fingerprint = carrier.text.replace(/\s+/g, ' ').slice(0, 400)
  if (seenText.has(fingerprint)) continue
  seenText.add(fingerprint)
  lines.push(`### ${license}`)
  lines.push('')
  lines.push(`_As shipped by \`${carrier.name}@${carrier.version}\`._`)
  lines.push('')
  lines.push('```')
  lines.push(carrier.text)
  lines.push('```')
  lines.push('')
}

fs.writeFileSync(outFile, lines.join('\n'))
console.log(`wrote ${path.relative(ROOT, outFile)} from ${slices.join(' + ')}: `
  + `${packages.length} packages, ${licenses.length} distinct licenses, ${copyleft.length} copyleft`)
if (copyleft.length) {
  console.log('copyleft: ' + copyleft.map((p) => `${p.name}@${p.version} (${p.license})`).join(', '))
}
