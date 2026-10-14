/**
 * The trust fence, shared by every server the desktop plugins run.
 *
 * It is two independent checks, and they answer different questions.
 *
 * ── 1. The header fence: which BROWSER page is calling? ───────────────────
 * Host is the load-bearing check: a rebound DNS name reaches us with its own
 * hostname in Host, so requiring a loopback authority rejects it no matter
 * what Origin claims. Origin is still checked when present — a media element
 * or a top-level navigation sends none, which is why absence is allowed — and
 * Sec-Fetch-Site is honoured because a browser sets it itself and a page
 * cannot forge it. 'same-site' is deliberately NOT accepted: two loopback
 * ports are same-site to a browser, and refusing it is one of the two things
 * that keep a previewed workspace page from calling the app's own API. The
 * other is that a supplied Origin must match this server's own authority, port
 * included. Either alone would do it in practice — every browser that can
 * fetch sends Sec-Fetch-Site — but an audit found only the first was actually
 * enforced, and a separation that rests on one header is not defence in depth.
 *
 * ── 2. The capability: is the caller THIS APP at all? ─────────────────────
 * The header fence is a CSRF defence and nothing more. It cannot tell an app
 * window from any other process on the machine, because a process simply omits
 * Origin and Sec-Fetch-Site and passes. That was a documented release gate:
 * with the terminal and files routes on this server, any local code running as
 * the user could read the workspace or execute commands through it.
 *
 * So the desktop shell mints a secret per run, hands it to this process in the
 * environment, and seeds it as a cookie into the app window's session before
 * the window loads. The browser then attaches it to every same-origin request
 * on its own — including EventSource streams and media element loads, neither
 * of which can set a header, which is why this is a cookie and not a bearer
 * token. A different process has no way to obtain it.
 *
 * When no secret is configured the capability is not required, so `dsh web`
 * run straight from a terminal behaves exactly as before. That fallback is
 * deliberate, and it is also the reason this is defence in depth rather than a
 * replacement: the header fence still runs first, and still stands alone for
 * anyone using the CLI.
 */

import { timingSafeEqual } from 'node:crypto'

/** Cookie the shell seeds into the app window's session. */
export const CAPABILITY_COOKIE = 'dsh_cap'

/** Environment variable the shell passes the same secret through. */
export const CAPABILITY_ENV = 'DSHPRO_API_TOKEN'

/** The secret this process expects, or null when none was configured. */
function expectedCapability () {
  const value = process.env[CAPABILITY_ENV]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Read one cookie out of a Cookie header.
 *
 * Deliberately hand-rolled rather than split(';').map(split('=')): a cookie
 * value may itself contain '=', so only the FIRST '=' separates name from
 * value, and a naive split silently truncates such a token to its first
 * segment — which would fail closed but look like a wrong secret.
 */
function readCookie (header, name) {
  if (typeof header !== 'string' || header === '') return null
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    if (pair.slice(0, eq).trim() !== name) continue
    return pair.slice(eq + 1).trim()
  }
  return null
}

/**
 * Constant-time secret comparison.
 *
 * timingSafeEqual throws on a length mismatch rather than returning false, and
 * comparing lengths first leaks only the length — which is fixed and public.
 */
function secretMatches (supplied, expected) {
  if (typeof supplied !== 'string') return false
  const a = Buffer.from(supplied, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Does this request carry the shell's capability? True when none is required. */
export function hasCapability (req) {
  const expected = expectedCapability()
  if (expected === null) return true
  return secretMatches(readCookie(req.headers?.cookie, CAPABILITY_COOKIE), expected)
}

/**
 * Is this authority a loopback one?
 *
 * Strips the port, then the brackets an IPv6 authority is required to carry,
 * so `[::1]:51234` and `127.0.0.1:51234` both reduce to a bare host. A name
 * that merely contains a loopback literal — `localhost.evil.com`,
 * `evil.com#127.0.0.1` — does not equal one of the three and is refused.
 */
function loopbackAuthority (value) {
  if (!value) return false
  const host = String(value).replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

/**
 * Does the request address this server by a loopback name?
 *
 * Exported on its own because the preview server needs exactly this check and
 * nothing else around it: it is a deliberately separate origin that must stay
 * reachable from an iframe, so the Origin, Sec-Fetch-Site and capability checks
 * below would break it — but it still has to refuse a rebound name. Sharing
 * this function keeps one definition of what counts as loopback.
 */
export function hasLoopbackHost (req) {
  return loopbackAuthority(req?.headers?.host)
}

export function isTrustedRequest (req) {
  if (!hasLoopbackHost(req)) return false

  const site = String(req.headers['sec-fetch-site'] ?? '')
  if (site && site !== 'same-origin' && site !== 'none') return false

  const origin = req.headers.origin
  if (origin) {
    let originHost = null
    try { originHost = new URL(origin).host } catch {}
    // Full authority, not just the hostname. Testing only the host let
    // `Origin: http://127.0.0.1:54874` through with a 200 — a different port is
    // a different origin, and the port is the only thing separating the app
    // from the preview server. An audit found the docblock above claiming that
    // refusing 'same-site' "keeps a previewed workspace page from calling the
    // app's own API" while the Origin branch it sits next to did not enforce
    // it, leaving the separation resting on Sec-Fetch-Site alone. Every browser
    // that can fetch sends that header, so this was not exploitable — but one
    // header is not two.
    if (!loopbackAuthority(originHost)) return false
    if (originHost !== req.headers.host) return false
  }
  return hasCapability(req)
}
