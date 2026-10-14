'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { smokePackagedHost } = require('../smoke-packaged-host.cjs')

test('packaging uses shared locked deployment, not legacy dependency resolution', () => {
  const source = fs.readFileSync(path.join(__dirname, '../stage-harness.cjs'), 'utf8')
  assert.match(source, /'deploy', '--prod', '--config.inject-workspace-packages=true'/)
  assert.doesNotMatch(source, /'--legacy'/)
})

test('desktop CSP permits the upstream same-origin base but no external base', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../shell/src/main.cjs'), 'utf8')
  const policy = source.slice(source.indexOf('const CSP = ['), source.indexOf("].join('; ')", source.indexOf('const CSP = [')))
  assert.match(policy, /"base-uri 'self'"/)
  assert.doesNotMatch(policy, /base-uri[^\n]*(?:https?:|\*)/)
  assert.match(policy, /"object-src 'none'"/)
  assert.match(policy, /"frame-ancestors 'none'"/)
})

test('a ready URL followed by a startup crash fails the packaged-host gate', async t => {
  const harness = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-fixture-'))
  t.after(() => fs.rmSync(harness, { recursive: true, force: true }))
  fs.mkdirSync(path.join(harness, 'node_modules/@dsh-desktop'), { recursive: true })
  const lib = path.join(harness, 'node_modules/@deepseek-ai/dsh/lib')
  fs.mkdirSync(lib, { recursive: true })
  fs.writeFileSync(path.join(lib, '../package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  const preset = path.join(lib, '../../dsh-web-app/presets')
  fs.mkdirSync(preset, { recursive: true })
  fs.writeFileSync(path.join(preset, '../package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app' }))
  fs.writeFileSync(path.join(preset, 'standard.patch.yml'), "- insert:\n    - id: preset-standard\n      config:\n        id: standard\n        order: 1\n        plugins:\n          - id: persona\n            config:\n              prefix: You are a coding agent powered by the {{model}} model.\n")
  fs.writeFileSync(path.join(lib, 'bin.js'), "console.log('dsh web: http://127.0.0.1:1'); setTimeout(() => { console.error('HMR missing'); process.exit(1) }, 50)")
  await assert.rejects(smokePackagedHost(process.execPath, harness), /Packaged host exited \(1\)[\s\S]*HMR missing/)
})
