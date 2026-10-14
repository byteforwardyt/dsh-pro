'use strict'
/**
 * One-time migration of the harness home from an earlier product name.
 *
 * Electron derives userData from the app name, so renaming the product
 * ("DSH Desktop" -> "DSH PRO") moves $DSH_HOME with it. Without this, a user who
 * updates loses their signed-in accounts, sessions and settings for no reason
 * they can see — the app simply starts blank.
 *
 * Rules that make this safe to run on every launch:
 *  - Only migrates when the NEW home has no harness data yet. An existing new
 *    home always wins; we never overwrite live state.
 *  - Copies rather than moves, so a failed migration cannot destroy the original.
 *  - profiles/node_modules is skipped: it is a farm of absolute symlinks into the
 *    old installation, which the profile healer rebuilds from the anchor anyway.
 *  - Records a marker so it runs at most once even if the user later empties the
 *    new home deliberately.
 */

const fs = require('node:fs')
const path = require('node:path')

/** Product names whose data we are willing to adopt, newest first. */
const LEGACY_PRODUCT_NAMES = ['DSH Desktop']

const MARKER = '.migrated-from'

/** Cheap test for "this home already holds real harness data". */
function hasHarnessData (home) {
  if (!fs.existsSync(home)) return false
  return ['.credentials.yaml', 'settings.yaml', 'sessions', 'storages']
    .some((entry) => fs.existsSync(path.join(home, entry)))
}

function copyTree (from, to) {
  let files = 0
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // The link farm points at the OLD install directory; healing rebuilds it.
    if (entry.name === 'node_modules') continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true })
      files += copyTree(src, dst)
    } else {
      fs.copyFileSync(src, dst)
      // Preserve 0600 on the credentials document.
      try { fs.chmodSync(dst, fs.statSync(src).mode) } catch {}
      files += 1
    }
  }
  return files
}

/**
 * @param appDataDir  the platform application-data root (app.getPath('appData'))
 * @param newHome     the current $DSH_HOME
 * @returns {{migrated:boolean, from?:string, files?:number}}
 */
function migrateLegacyHome (appDataDir, newHome) {
  if (fs.existsSync(path.join(newHome, MARKER))) return { migrated: false }
  if (hasHarnessData(newHome)) return { migrated: false }

  for (const legacyName of LEGACY_PRODUCT_NAMES) {
    const legacyHome = path.join(appDataDir, legacyName, 'harness')
    if (!hasHarnessData(legacyHome)) continue
    fs.mkdirSync(newHome, { recursive: true, mode: 0o700 })
    const files = copyTree(legacyHome, newHome)
    fs.writeFileSync(path.join(newHome, MARKER), `${legacyName}\n`, { mode: 0o600 })
    return { migrated: true, from: legacyHome, files }
  }
  return { migrated: false }
}

/**
 * The legacy harness homes a factory reset must ALSO delete.
 *
 * Reset wipes only the current $DSH_HOME. But the run-once migration marker
 * lives inside that wiped directory, so on the post-reset relaunch
 * migrateLegacyHome sees no marker, finds the untouched legacy home, and copies
 * the old sessions, settings and plaintext credentials straight back — the app
 * relaunches signed in, defeating the reset. Reset removes these too.
 *
 * @param appDataDir  app.getPath('appData')
 * @returns {string[]} absolute legacy home paths (may not exist)
 */
function legacyHomePaths (appDataDir) {
  return LEGACY_PRODUCT_NAMES.map((name) => path.join(appDataDir, name, 'harness'))
}

module.exports = { migrateLegacyHome, legacyHomePaths, LEGACY_PRODUCT_NAMES }
