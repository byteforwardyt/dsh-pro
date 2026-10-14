/**
 * The shared trust fence.
 *
 * These assertions used to live in host-auth-api, against a private copy of the
 * predicate lifted out of that module's source text. There is one fence now, so
 * they test the real exported function instead of a slice of a string.
 *
 * Two things are being guarded, and they fail for different reasons. The header
 * checks stop a browser page on another origin. The capability stops another
 * PROCESS on this machine — which the header checks never could, because a
 * process just omits the headers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isTrustedRequest, hasCapability, CAPABILITY_COOKIE, CAPABILITY_ENV } from '../lib/trust.js'

const req = (headers) => ({ headers })

/** Run `body` with the shell's secret configured, then restore the environment. */
function withCapability (secret, body) {
  const had = Object.prototype.hasOwnProperty.call(process.env, CAPABILITY_ENV)
  const previous = process.env[CAPABILITY_ENV]
  process.env[CAPABILITY_ENV] = secret
  try { body() } finally {
    if (had) process.env[CAPABILITY_ENV] = previous
    else delete process.env[CAPABILITY_ENV]
  }
}

test('accepts a same-origin request from the loopback host', () => {
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', origin: 'http://127.0.0.1:51234' })), true)
  assert.equal(isTrustedRequest(req({ host: 'localhost:3080', origin: 'http://localhost:3080' })), true)
})

test('rejects a rebound DNS name even when Origin agrees with Host', () => {
  // Internally consistent, and a lie: the attacker controls both headers but
  // not the requirement that Host be a loopback authority.
  assert.equal(isTrustedRequest(req({ host: 'evil.test:51234', origin: 'http://evil.test:51234' })), false)
})

test('rejects a cross-site Origin', () => {
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', origin: 'https://attacker.example' })), false)
})

test("honours the browser's own cross-site declaration", () => {
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', 'sec-fetch-site': 'same-origin' })), true)
})

test('refuses same-site, which is what keeps a previewed page out', () => {
  // Two loopback ports are same-site to a browser. The preview pane serves the
  // user's own pages on a second port; accepting same-site would hand them the
  // app's API.
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', 'sec-fetch-site': 'same-site' })), false)
})

test('accepts bracketed IPv6 loopback', () => {
  assert.equal(isTrustedRequest(req({ host: '[::1]:51234' })), true)
})

test('rejects a missing Host outright', () => {
  assert.equal(isTrustedRequest(req({})), false)
})

test('without a configured secret the capability is not required', () => {
  // This is what keeps `dsh web` usable straight from a terminal.
  assert.equal(hasCapability(req({ host: '127.0.0.1:51234' })), true)
})

test('with a secret configured, a header-clean local process is refused', () => {
  // The whole point. This request passes every header check — it is exactly
  // what any other process on this machine can send — and it is still refused.
  withCapability('s3cr3t-value', () => {
    assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234' })), false)
    assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', origin: 'http://127.0.0.1:51234' })), false)
  })
})

test('the app window, carrying the seeded cookie, is admitted', () => {
  withCapability('s3cr3t-value', () => {
    const cookie = `${CAPABILITY_COOKIE}=s3cr3t-value`
    assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', cookie })), true)
    // Alongside whatever else the session is carrying, in either order.
    assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', cookie: `a=1; ${cookie}; b=2` })), true)
    assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', cookie: `${cookie}; a=1` })), true)
  })
})

test('a wrong or truncated secret is refused', () => {
  withCapability('s3cr3t-value', () => {
    for (const value of ['', 'nope', 's3cr3t-valu', 's3cr3t-value-extra', 'S3CR3T-VALUE']) {
      assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', cookie: `${CAPABILITY_COOKIE}=${value}` })), false,
        `"${value}" was accepted in place of the secret`)
    }
  })
})

test('the capability is read from the cookie by name, not by position', () => {
  withCapability('s3cr3t-value', () => {
    // A cookie whose NAME merely ends with ours must not be mistaken for it.
    assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', cookie: `not_${CAPABILITY_COOKIE}=s3cr3t-value` })), false)
  })
})

test('a secret containing = survives cookie parsing', () => {
  // Base64 secrets carry padding. Splitting on every '=' would truncate this to
  // its first segment and fail closed, which reads as a wrong secret rather
  // than as a parsing bug — so it is worth pinning.
  withCapability('YWJjZA==', () => {
    assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', cookie: `${CAPABILITY_COOKIE}=YWJjZA==` })), true)
  })
})

test('the header fence still runs first, so the capability cannot rescue a bad origin', () => {
  withCapability('s3cr3t-value', () => {
    assert.equal(isTrustedRequest(req({
      host: 'evil.test:51234',
      cookie: `${CAPABILITY_COOKIE}=s3cr3t-value`,
    })), false)
  })
})

test('another loopback PORT is another origin', () => {
  // The preview server is a different port on the same host, and the port is
  // the only thing separating it from the app. Testing just the hostname let
  // `Origin: http://127.0.0.1:54874` through with a 200 while the docblock
  // claimed this branch was what kept a previewed page out of the app's API.
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', origin: 'http://127.0.0.1:54874' })), false)
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', origin: 'http://127.0.0.1:3000' })), false)
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', origin: 'http://localhost:51234' })), false,
    'a different name for the same address is still a different origin to the browser')
  // The real same-origin case must survive, or every panel in the app breaks.
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234', origin: 'http://127.0.0.1:51234' })), true)
  assert.equal(isTrustedRequest(req({ host: '[::1]:51234', origin: 'http://[::1]:51234' })), true)
  // No Origin at all is still allowed: media elements and top-level
  // navigations send none, and the capability is what covers that gap.
  assert.equal(isTrustedRequest(req({ host: '127.0.0.1:51234' })), true)
})
