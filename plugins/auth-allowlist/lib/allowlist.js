/**
 * The provider routes this build is willing to obtain a subscription login for.
 *
 * This list is a product decision AND a compliance boundary, so it is data, kept
 * apart from the service that enforces it and asserted by its own test.
 *
 * `registerPiAiFlows` offers a login for every catalog provider declaring
 * `auth.oauth`. In pi-ai 0.82.1 that is exactly six, verified at runtime:
 * anthropic, github-copilot, kimi-coding, openai-codex, openrouter, xai.
 *
 * ── THE RULE THIS LIST ENCODES ─────────────────────────────────────────────
 * A provider is excluded when its vendor has PUBLISHED a restriction on
 * third-party clients using subscription credentials. It is admitted when no
 * such published restriction was found.
 *
 * That is the only line this list draws, and it is drawn on published terms —
 * not on how the flow is implemented.
 *
 * ── THE ISSUE THIS LIST DOES *NOT* RESOLVE ─────────────────────────────────
 * pi-ai authenticates using each vendor's OWN first-party client id — OpenAI's
 * Codex CLI (`app_EMoamEEZ73f0CkXaXp7hrann`), xAI's CLI
 * (`b1a00492-073a-47ea-816f-4c329264a828`), and others. The consent screen a
 * user sees therefore names a client that is not this product.
 *
 * That applies to EVERY entry below, equally. It is not a reason one provider
 * is admitted and another excluded, and an earlier version of this file wrongly
 * used it that way — excluding github-copilot for borrowing a client id while
 * admitting openai-codex and xai, which do exactly the same thing.
 *
 * It is instead a single unresolved RELEASE GATE, tracked in docs/BACKLOG.md:
 *
 *   Before distributing to anyone other than the developer, either
 *     (a) register a first-party OAuth client per vendor and use only those, or
 *     (b) drop subscription login for any vendor that will not issue one and
 *         offer API-key auth instead.
 *   Until then the sign-in surface must disclose whose client the consent
 *   screen will name (client-ui-accounts renders this).
 *
 * Providers can also revoke a borrowed client at any time, which would break
 * every installed copy at once.
 *
 * Adding an entry is a deliberate act: read the vendor's published terms on
 * third-party client use first, and record the finding beside the entry.
 */
export const ALLOWED_LOGIN_PROVIDERS = Object.freeze([
  // ChatGPT Plus/Pro/Business. Loopback PKCE on port 1455, device-code fallback.
  // No published prohibition on third-party clients found.
  'openai-codex',
  // SuperGrok / X Premium. RFC 8628 device code; also offers an API key.
  // No published prohibition found.
  'xai',
  // OpenRouter documents OAuth PKCE specifically FOR third-party applications —
  // the one flow here that is unambiguously intended for integrators, and the
  // only one free of the borrowed-client-id issue above.
  'openrouter',
  // Moonshot's Kimi coding subscription. No published restriction found;
  // revisit if Moonshot publishes one.
  'kimi-coding',
])

/**
 * Providers with a PUBLISHED restriction on third-party subscription login.
 * Named explicitly so the test asserts on identities rather than on absence.
 * Both remain reachable by API key, which is the permitted path in each case.
 */
export const FORBIDDEN_LOGIN_PROVIDERS = Object.freeze([
  // Anthropic's usage policy: "Anthropic does not permit third-party developers
  // to offer Claude.ai login or to route requests through Free, Pro, or Max plan
  // credentials on behalf of their users... Anthropic reserves the right to take
  // measures to enforce these restrictions and may do so without prior notice."
  'anthropic',
  // GitHub restricts Copilot access to approved clients; a third-party desktop
  // app is not one. (The borrowed-client-id problem is real here too, but it is
  // not the distinguishing reason — see the header.)
  'github-copilot',
])

/**
 * Providers whose OAuth flow authenticates as another vendor's first-party
 * client. The sign-in surface discloses this to the user before they consent.
 */
export const BORROWED_CLIENT_PROVIDERS = Object.freeze(['openai-codex', 'xai', 'kimi-coding'])

/** @param {string} providerId */
export function isLoginAllowed (providerId) {
  return ALLOWED_LOGIN_PROVIDERS.includes(providerId)
}

/** @param {string} providerId */
export function usesBorrowedClient (providerId) {
  return BORROWED_CLIENT_PROVIDERS.includes(providerId)
}
