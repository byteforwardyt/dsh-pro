/**
 * The /dsh-auth trust fence.
 *
 * This plugin used to carry its own copy of the predicate, and this file used
 * to test a slice of that copy lifted out of the source text. Both are gone:
 * there is one fence, in @dsh-desktop/host-files-api/trust, and its behaviour
 * is asserted next to it. What is left here is what is specific to this
 * plugin, and it is the part that actually went wrong before — an earlier
 * fence compared two caller-supplied headers, and the read-only routes
 * answered above it entirely. docs/AUDIT-FIXES.md recorded both as fixed when
 * they were not.
 *
 * This is the most credential-adjacent surface in the app, so it is also the
 * worst possible place for a private copy of a security check to drift.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('the fence is the shared one, not a private copy', () => {
  assert.match(source, /import \{ isTrustedRequest \} from '@dsh-desktop\/host-files-api\/trust'/,
    'this plugin no longer imports the shared fence')
  assert.equal(source.includes('function isTrustedRequest'), false,
    'a private copy of the fence has reappeared: two implementations will drift, and this one guards the credential seam')
})

test('every route is served below the fence, not above it', () => {
  const fenceAt = source.indexOf('isTrustedRequest(req)')
  assert.ok(fenceAt >= 0, 'handler never calls isTrustedRequest')
  for (const route of ['/events', '/state', '/begin', '/answer', '/decline', '/cancel', '/signout']) {
    const at = source.indexOf(`route === '${route}'`)
    if (at < 0) continue
    assert.ok(fenceAt < at, `${route} is served before the fence runs`)
  }
})
