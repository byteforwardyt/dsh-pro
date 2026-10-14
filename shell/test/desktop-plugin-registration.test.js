'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { ensureProfile } = require('../src/profile.cjs')
const { parser } = require('../src/upstream-migration.cjs')

const shell = path.resolve(__dirname, '..')
const main = path.join(shell, 'src/main.cjs')
const shellRequire = createRequire(main)
const manifest = shellRequire('../package.json')
const packages = Object.keys(manifest.dependencies).filter(name => name.startsWith('@dsh-desktop/'))
const source = fs.readFileSync(main, 'utf8')
const resolver = source.match(/^function resolveDesktopPlugins \(\) \{[\s\S]*?^\}/m)?.[0]
assert.ok(resolver, 'The shell plugin resolver must remain testable without booting Electron')

function appOwnedEntries (value) {
  if (!value || typeof value !== 'object') return []
  const current = typeof value.name === 'string' && value.name.startsWith('@dsh-desktop/') ? [value.name] : []
  return [...current, ...Object.values(value).flatMap(appOwnedEntries)]
}

function resolvePlugins (isPackaged, resourcesPath) {
  const logs = []
  // Execute the production function, not a second list assembled by the test.
  // Only the Electron environment is supplied; filesystem/module resolution is real.
  const resolve = vm.runInNewContext('(' + resolver + ')', {
    app: { isPackaged }, process: { resourcesPath }, fs, path,
    require: shellRequire, recordLog: (stream, message) => logs.push({ stream, message }),
  }, { filename: main })
  return { resolved: resolve(), logs }
}

function assertProfileRegistration (t, packaged) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-registration-'))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const resources = path.join(temporary, 'Resources')
  const harness = path.join(resources, 'harness')
  if (packaged) {
    fs.mkdirSync(harness, { recursive: true })
    // Reproduce the packaged location with installed production dependencies;
    // no GUI launch, network access, or real user profile is involved.
    fs.symlinkSync(path.join(shell, 'node_modules'), path.join(harness, 'node_modules'), 'dir')
  }
  const { resolved, logs } = resolvePlugins(packaged, resources)
  assert.deepEqual(logs, [], 'All desktop dependencies must resolve in the shell launch path')
  assert.ok(resolved['@dsh-desktop/client-ui-supercode'], 'The actual shell must link SuperCode')
  assert.deepEqual(Object.keys(resolved).sort(), [...packages].sort(), 'The shell resolver must cover every app-owned production dependency')

  const profile = ensureProfile(path.join(temporary, 'home'), packaged ? harness : shell, resolved)
  const bundle = path.join(profile.dir, 'node_modules/@dsh-desktop/profile')
  const bundleManifest = JSON.parse(fs.readFileSync(path.join(bundle, 'package.json'), 'utf8'))
  const yaml = parser(packaged ? harness : shell)
  // Cordis predicates are source data here, never executable test input.
  const schema = yaml.DEFAULT_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }))
  const entries = new Set(bundleManifest.dsh.bundle.patch.flatMap(file => {
    const patch = fs.readFileSync(path.join(bundle, file), 'utf8')
    return appOwnedEntries(yaml.load(patch, { schema }))
  }))
  assert.ok(entries.has('@dsh-desktop/client-ui-supercode'), 'SuperCode must be mounted by the generated profile')
  assert.ok(entries.has('@dsh-desktop/tool-dispatch'), 'Preset-only dependencies must also be tested')
  const profileRequire = createRequire(path.join(profile.dir, 'package.json'))
  for (const entry of entries) {
    const packageName = entry.split('/').slice(0, 2).join('/')
    assert.ok(resolved[packageName], 'Generated profile entry is missing from shell resolver: ' + entry)
    const linked = path.join(profile.dir, 'node_modules', ...packageName.split('/'))
    assert.equal(fs.realpathSync(linked), resolved[packageName], 'Profile must use the shell-resolved package: ' + entry)
    assert.ok(profileRequire.resolve(entry), 'Generated profile entry must be importable: ' + entry)
  }
}

test('development shell resolver links every generated app-owned profile and preset entry', t => {
  assertProfileRegistration(t, false)
})

test('packaged shell resolver links every generated app-owned profile and preset entry', t => {
  assertProfileRegistration(t, true)
})
