'use strict'
/**
 * Home migration adopts an earlier product name's data once, and — the part a
 * factory reset depends on — a reset that removes only the new home is NOT
 * enough: the legacy home must be removed too, or the next launch migrates the
 * old sessions, settings and plaintext credentials straight back.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { migrateLegacyHome, legacyHomePaths, LEGACY_PRODUCT_NAMES } = require('../src/migrate.cjs')

function tmp () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshd-migrate-'))
}

/** Plant a believable legacy harness home under appData/<name>/harness. */
function plantLegacy (appData, name) {
  const home = path.join(appData, name, 'harness')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'token: secret\n', { mode: 0o600 })
  fs.writeFileSync(path.join(home, 'settings.yaml'), 'theme: dark\n')
  return home
}

test('legacyHomePaths covers every adopted product name', () => {
  const appData = '/tmp/appdata'
  const paths = legacyHomePaths(appData)
  assert.equal(paths.length, LEGACY_PRODUCT_NAMES.length)
  for (const name of LEGACY_PRODUCT_NAMES) {
    assert.ok(paths.includes(path.join(appData, name, 'harness')), `covers ${name}`)
  }
})

test('migration adopts legacy data once, then not again', (t) => {
  const appData = tmp()
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  plantLegacy(appData, LEGACY_PRODUCT_NAMES[0])
  const newHome = path.join(appData, 'DSH PRO', 'harness')

  const first = migrateLegacyHome(appData, newHome)
  assert.equal(first.migrated, true)
  assert.ok(fs.existsSync(path.join(newHome, '.credentials.yaml')))

  // Marker written → a second call is a no-op even though legacy still exists.
  const second = migrateLegacyHome(appData, newHome)
  assert.equal(second.migrated, false)
})

test('reset that removes only the new home lets migration resurrect the old data', (t) => {
  const appData = tmp()
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }))
  plantLegacy(appData, LEGACY_PRODUCT_NAMES[0])
  const newHome = path.join(appData, 'DSH PRO', 'harness')

  migrateLegacyHome(appData, newHome)

  // Simulate the OLD (buggy) reset: wipe only the new home.
  fs.rmSync(newHome, { recursive: true, force: true })
  const afterBadReset = migrateLegacyHome(appData, newHome)
  assert.equal(afterBadReset.migrated, true, 'old data comes back — this is the bug')
  assert.ok(fs.existsSync(path.join(newHome, '.credentials.yaml')))

  // Now the FIXED reset: wipe the new home AND every legacy home.
  fs.rmSync(newHome, { recursive: true, force: true })
  for (const legacy of legacyHomePaths(appData)) fs.rmSync(legacy, { recursive: true, force: true })
  const afterGoodReset = migrateLegacyHome(appData, newHome)
  assert.equal(afterGoodReset.migrated, false, 'nothing left to migrate — reset holds')
  assert.ok(!fs.existsSync(newHome) || !fs.existsSync(path.join(newHome, '.credentials.yaml')))
})
