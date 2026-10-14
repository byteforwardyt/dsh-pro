import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

// This directory existed but was never in the root test glob, so anything
// written here ran only when someone invoked it by hand. Adding the glob makes
// an empty directory fatal — zsh fails the whole command on a no-match — so
// this file is both the guard and the placeholder that keeps the glob valid.

test('the root test script runs this directory', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.scripts.test, /plugins\/terminal\/test\/\*\.test\.js/,
    'terminal plugin tests are not in the root test glob, so they do not run in CI or before a release')
})
