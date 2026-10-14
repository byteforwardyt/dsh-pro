const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const { generate, names } = require('../sync-material-symbols.cjs')
const spec = require('../material-symbols-map.cjs')
const data = require('../../plugins/client-ui-theme-holo/material-symbols.json')

test('Material artwork and all native/owned mappings are reproducible without network access', () => {
  execFileSync(process.execPath, ['scripts/sync-material-symbols.cjs', '--check'])
  assert.equal(data.revision, spec.revision)
  assert.match(data.license, /Apache License/)
  assert.deepEqual(Object.keys(data.icons), names)
  for (const svg of Object.values(data.icons)) {
    assert.match(svg, /^<svg /)
    assert.doesNotMatch(svg, /<script|foreignObject|onload|href=/i)
  }
})

test('semantic controls are distinct and retain the same locally bundled icon family', () => {
  const output = generate(data)
  assert.ok(output.count > 130)
  assert.equal(spec.views.terminal, 'terminal')
  assert.equal(spec.views.preview, 'web')
  assert.equal(spec.settings.accounts, 'manage_accounts')
  assert.equal(spec.settings.models, 'smart_toy')
  assert.equal(spec.settings.plugins, 'extension')
  assert.equal(spec.settings['model-connections'], 'hub')
  assert.equal(spec.controls['.sc-mode-icon'], 'groups')
  assert.equal(new Set(Object.values(output.views)).size, 5)
  assert.doesNotMatch(output.css, /fonts\.googleapis|@font-face|https:\/\//)
  assert.match(output.css, /body\[data-dshd-desktop\]/)
  assert.doesNotMatch(output.css, /pointer-events|display:none|width:0|height:0/)
  // Branding must remain the separate existing provider system.
  assert.doesNotMatch(output.css, /data-dshd-model-brand/)
  const theme = fs.readFileSync('plugins/client-ui-theme-holo/lib/client.js', 'utf8')
  assert.match(theme, /CSS \+ brandIconCSS\(\) \+ MATERIAL_CSS/)
})
