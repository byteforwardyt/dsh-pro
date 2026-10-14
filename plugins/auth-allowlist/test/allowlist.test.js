import assert from 'node:assert/strict'
import { test } from 'node:test'

import AllowlistedAuthorizationService from '../lib/index.js'
import {
  ALLOWED_LOGIN_PROVIDERS,
  BORROWED_CLIENT_PROVIDERS,
  FORBIDDEN_LOGIN_PROVIDERS,
  isLoginAllowed,
  usesBorrowedClient,
} from '../lib/allowlist.js'

test('offers a subscription login only for the providers this build has vetted', () => {
  assert.deepEqual(
    [...ALLOWED_LOGIN_PROVIDERS].sort(),
    ['kimi-coding', 'openai-codex', 'openrouter', 'xai'],
  )
})

test('covers every oauth-capable provider except the two that are excluded', () => {
  // pi-ai 0.82.1 declares auth.oauth for exactly these six (verified at runtime).
  const OAUTH_CAPABLE = ['anthropic', 'github-copilot', 'kimi-coding', 'openai-codex', 'openrouter', 'xai']
  const unaccounted = OAUTH_CAPABLE.filter(
    (p) => !ALLOWED_LOGIN_PROVIDERS.includes(p) && !FORBIDDEN_LOGIN_PROVIDERS.includes(p),
  )
  assert.deepEqual(unaccounted, [], 'every oauth provider must be explicitly allowed or forbidden')
})

test('never offers a login for a provider with a published restriction', () => {
  // Anthropic prohibits third-party Claude.ai login; GitHub restricts Copilot to
  // approved clients. Both stay API-key-only. This assertion is the compliance
  // gate — do not relax it without a written terms review.
  for (const provider of FORBIDDEN_LOGIN_PROVIDERS) {
    assert.equal(isLoginAllowed(provider), false, `${provider} must not be offered a login`)
  }
})

test('the allow and forbid lists cannot overlap', () => {
  const overlap = ALLOWED_LOGIN_PROVIDERS.filter((p) => FORBIDDEN_LOGIN_PROVIDERS.includes(p))
  assert.deepEqual(overlap, [])
})

test('an unknown provider is refused by default, not admitted', () => {
  assert.equal(isLoginAllowed('some-provider-shipped-next-week'), false)
  assert.equal(isLoginAllowed(''), false)
})

/**
 * Exercises the override without booting cordis: `registerFlow` must decide using
 * only the flow key, and must reach `super` exactly for allowed providers.
 */
function harness () {
  const registered = []
  const service = Object.create(AllowlistedAuthorizationService.prototype)
  // Stand in for Service#ctx.effect, which is all super.registerFlow touches.
  // cordis passes it a GENERATOR that performs the registration before its first
  // `yield` (the yielded value being the teardown), so the stub must advance it.
  Object.defineProperty(service, 'ctx', {
    value: {
      effect: (fn) => {
        const iter = fn()
        const { value: teardown } = iter.next()
        return () => { if (typeof teardown === 'function') teardown() }
      },
    },
    configurable: true,
  })
  service.flows = new Map()
  service.running = new Map()
  return {
    service,
    registered,
    call (key) {
      const before = service.flows.size
      const dispose = service.registerFlow({ key, label: key, methods: ['oauth'], run: async () => {} })
      const reached = service.flows.size > before
      if (reached) registered.push(key)
      assert.equal(typeof dispose, 'function', 'registerFlow must always return a disposer')
      return reached
    },
  }
}

test('registerFlow admits allowed providers and silently declines the rest', () => {
  const h = harness()
  assert.equal(h.call('llm-pi-ai/xai'), true)
  assert.equal(h.call('llm-pi-ai/openai-codex'), true)
  assert.equal(h.call('llm-pi-ai/anthropic'), false)
  assert.equal(h.call('llm-pi-ai/github-copilot'), false)
  assert.equal(h.call('llm-pi-ai/openrouter'), true)
  assert.equal(h.call('llm-pi-ai/deepseek'), false)
  assert.deepEqual(h.registered, ['llm-pi-ai/xai', 'llm-pi-ai/openai-codex', 'llm-pi-ai/openrouter'])
  assert.deepEqual(h.service.declinedProviders(), ['anthropic', 'deepseek', 'github-copilot'])
})

test('declining does not throw, so a catalog-wide registration pass survives it', () => {
  const h = harness()
  assert.doesNotThrow(() => h.call('llm-pi-ai/anthropic'))
})


test('every borrowed-client provider is one we actually offer', () => {
  // The disclosure list must not name a provider the user can never reach, and
  // must not silently drift out of sync with what is admitted.
  for (const provider of BORROWED_CLIENT_PROVIDERS) {
    assert.equal(
      ALLOWED_LOGIN_PROVIDERS.includes(provider), true,
      `${provider} is disclosed as borrowed-client but is not offered`,
    )
  }
})

test('openrouter is the one oauth provider free of the borrowed-client issue', () => {
  // OpenRouter publishes PKCE for third-party apps, so it needs no disclosure.
  assert.equal(usesBorrowedClient('openrouter'), false)
})
