import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { inheritedEnv } = require_('../src/host-process.cjs')

// The harness child is spawned from the app's own signed binary with
// ELECTRON_RUN_AS_NODE=1, so it is Node and honours Node's loader variables.
// On macOS `launchctl setenv` sets those for every process the user launches,
// persistently and without a prompt, so one write would otherwise mean code
// running inside the process that holds the user's provider credentials.

test('the loader variables that inject code do not reach the harness', () => {
  const env = inheritedEnv({
    NODE_OPTIONS: '--require /tmp/inject.js',
    NODE_REPL_EXTERNAL_MODULE: '/tmp/inject.js',
    NODE_PATH: '/tmp/shadow',
    DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    LD_PRELOAD: '/tmp/inject.so',
    LD_AUDIT: '/tmp/audit.so',
    ELECTRON_RUN_AS_NODE: '0',
  })
  assert.deepEqual(Object.keys(env), [], `these must not be inherited: ${Object.keys(env).join(', ')}`)
})

test('the ban is by prefix, so a loader variable added later is refused too', () => {
  // Node has added loader hooks more than once. A list of today's names would
  // pass this file while failing the user.
  const env = inheritedEnv({
    NODE_SOMETHING_INVENTED_LATER: 'x',
    ELECTRON_SOMETHING_INVENTED_LATER: 'x',
    DYLD_SOMETHING_INVENTED_LATER: 'x',
  })
  assert.deepEqual(Object.keys(env), [])
})

test('the user environment the agent shells out through survives', () => {
  // An allowlist would have quietly broken every one of these, and the failure
  // would surface as somebody's build tool behaving differently inside the app.
  const source = {
    HOME: '/Users/someone',
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    SSH_AUTH_SOCK: '/private/tmp/agent.sock',
    TMPDIR: '/private/tmp/',
    JAVA_HOME: '/opt/java',
    CARGO_HOME: '/Users/someone/.cargo',
    HTTPS_PROXY: 'http://proxy.internal:8080',
    TERM: 'xterm-256color',
  }
  assert.deepEqual(inheritedEnv(source), source)
})

test('LD_LIBRARY_PATH is kept, because the Linux build loads native modules through it', () => {
  // Banning the whole LD_ prefix would have broken the AppImage, where the
  // runtime sets this for itself. Only the two injection names go.
  const env = inheritedEnv({ LD_LIBRARY_PATH: '/opt/appimage/lib', LD_PRELOAD: '/tmp/inject.so' })
  assert.deepEqual(env, { LD_LIBRARY_PATH: '/opt/appimage/lib' })
})

test('NODE_EXTRA_CA_CERTS is the one documented exception', () => {
  // It names a PEM file and cannot execute anything, and dropping it breaks TLS
  // behind a corporate proxy in a way that is miserable to diagnose. Anyone who
  // can set it can add a trust anchor by easier routes.
  const env = inheritedEnv({ NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem', NODE_OPTIONS: '--require /tmp/x.js' })
  assert.deepEqual(env, { NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem' })
})

test('an unset variable does not become the string "undefined"', () => {
  const env = inheritedEnv({ HOME: '/Users/someone', EMPTY: undefined })
  assert.equal('EMPTY' in env, false)
  assert.equal(env.HOME, '/Users/someone')
})
