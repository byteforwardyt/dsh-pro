'use strict'
const fs = require('node:fs')
const path = require('node:path')

/** Read the parser shipped with the harness; the shell has no bundled modules. */
function parser(anchor) {
  const pkg = require.resolve('@deepseek-ai/dsh/package.json', { paths: [anchor] })
  return require(require.resolve('js-yaml', { paths: [path.dirname(pkg)] }))
}

function translateSettings(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new Error('Legacy settings are not a mapping; the original has been left untouched.')
  const ids = { 'ui-onboarding': 'ui-settings-general', 'ui-developer-tools': 'ui-settings',
    shell: process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox', 'llm-deepseek': 'optional-deepseek' }
  return Object.entries(document).map(([id, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Legacy settings contain an invalid section; the original has been left untouched.')
    if (id === 'agent-presets') {
      return { id: 'agent-preset-registry', config: {
        default: 'dsh-agent',
        ...(typeof value.default === 'string' ? { selectedDefault: value.default } : {}),
      } }
    }
    return { id: ids[id] || id, config: value }
  })
}

/** Convert settings before upstream's lossy best-effort importer sees them.
 * Originals remain in a private rollback folder. No credential or session file
 * is read, copied, or rewritten here. A restart never replaces the user patch.
 */
function migrateSettings(home, dir, anchor) {
  const source = path.join(home, 'settings.yaml')
  const marker = path.join(dir, '.settings-v2-migrated')
  if (!fs.existsSync(source)) return false
  if (fs.existsSync(marker)) throw new Error('Legacy settings reappeared after migration. Keep both versions and resolve them before continuing.')
  const yaml = parser(anchor)
  const raw = fs.readFileSync(source, 'utf8')
  const rows = translateSettings(yaml.load(raw))
  const userPatch = path.join(dir, 'cordis.patch.yml')
  const existing = fs.existsSync(userPatch) ? yaml.load(fs.readFileSync(userPatch, 'utf8')) : []
  if (!Array.isArray(existing)) throw new Error('Profile patch is not a list; legacy settings were not changed.')
  const combined = [...rows.filter(row => !existing.some(entry => entry.id === row.id)), ...existing]
  const backup = path.join(home, 'migration-backup-0.2')
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
  const original = path.join(backup, 'settings.yaml')
  if (!fs.existsSync(original)) fs.writeFileSync(original, raw, { mode: 0o600, flag: 'wx' })
  else if (fs.readFileSync(original, 'utf8') !== raw)
    throw new Error('Legacy settings changed since the upgrade backup; refusing to overwrite either copy.')
  const moved = path.join(backup, 'settings.import-source.yaml')
  if (fs.existsSync(moved) && fs.readFileSync(moved, 'utf8') !== raw)
    throw new Error('A different legacy settings original already exists; refusing to overwrite it.')
  const pending = userPatch + '.migration-pending'
  fs.writeFileSync(pending, yaml.dump(combined, { noRefs: true, lineWidth: -1 }), { mode: 0o600 })
  fs.renameSync(pending, userPatch)
  fs.renameSync(source, moved)
  fs.writeFileSync(marker, '0.2.0-rc.2\n', { mode: 0o600 })
  return true
}

/** Stop before touching live data when an old extension needs manual porting.
 * Keeping the old profile is preferable to silently dropping a user plugin.
 */
function preflightLegacy(home) {
  const manifestPath = path.join(home, 'profiles', 'desktop', 'package.json')
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const bundles = manifest.dsh?.profile?.bundles || []
    if (Object.keys(manifest.dependencies || {}).length || bundles.some(id => !['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].includes(id)))
      throw new Error('The legacy desktop profile has custom plugins. Port them before upgrading; its files were left untouched.')
  }
  const presets = path.join(home, '.agent-presets')
  if (fs.existsSync(presets)) for (const entry of fs.readdirSync(presets, {withFileTypes:true})) {
    if (!entry.isDirectory()) continue
    const file = path.join(presets, entry.name, 'agent.cordis.yml')
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const managed = entry.name === 'dsh-agent' && text.startsWith('# Managed by DSH PRO: default coding agent v1\n')
      || entry.name === 'dispatch' && text.includes('# ── Dispatch: hand a task to another installed coding-agent CLI')
    if (!managed) throw new Error('A custom legacy agent preset requires porting before this update. All preset files were left untouched.')
  }
}

module.exports = { translateSettings, migrateSettings, parser, preflightLegacy }
