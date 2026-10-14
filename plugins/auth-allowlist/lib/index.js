import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKeyId } from '@deepseek-ai/dsh-credentials'

import { isLoginAllowed } from './allowlist.js'

/**
 * Registration happens during boot, before any surface exists to report through,
 * so decisions go to stderr behind an opt-in flag. Off by default: the decline
 * list would otherwise read like a series of errors in normal operation.
 */
const debug = process.env.DSH_DESKTOP_DEBUG
  ? (message) => process.stderr.write(`[auth-allowlist] ${message}\n`)
  : () => {}

/**
 * `ctx.authorization`, narrowed to an explicit provider allowlist.
 *
 * This subclass occupies the same service seat as the upstream
 * `@deepseek-ai/dsh-authorization` plugin and must be mounted INSTEAD of it (one
 * service, one provider). Everything except registration is inherited unchanged:
 * `begin`, `cancel`, `list`, `describe`, the single-flight rule, the
 * commit confirmation, and the `authorization/settled` event.
 *
 * Filtering at `registerFlow` rather than at `begin` is deliberate. A rejected
 * flow is never in `flows`, so it cannot be listed, described, or started, and no
 * surface can accidentally offer it — whereas a `begin`-time check leaves the
 * capability present and one missing guard away from being reachable.
 *
 * A rejected registration is not an error. `registerPiAiFlows` walks the whole
 * catalog in one pass; throwing would abort the walk and cost us the providers we
 * do want. The caller receives a working no-op disposer instead.
 */
export default class AllowlistedAuthorizationService extends AuthorizationService {
  /**
   * Provider routes whose registration was declined, for diagnostics.
   * Initialized lazily rather than as a class field so the filter stays testable
   * without standing up a cordis context to run the constructor.
   * @type {Set<string> | undefined}
   */
  declined

  registerFlow (flow) {
    const providerId = credentialKeyId(flow.key)
    if (!isLoginAllowed(providerId)) {
      (this.declined ??= new Set()).add(providerId)
      debug(`declined ${providerId}: ${JSON.stringify(flow.methods?.map((m) => m.id) ?? [])}`)
      return () => {}
    }
    debug(`registered login flow for ${providerId}: ${JSON.stringify({ label: flow.label, methods: flow.methods })}`)
    return super.registerFlow(flow)
  }

  /** Provider routes that asked to register a login and were refused. */
  declinedProviders () {
    return [...(this.declined ?? [])].sort()
  }
}

export { ALLOWED_LOGIN_PROVIDERS, FORBIDDEN_LOGIN_PROVIDERS, isLoginAllowed } from './allowlist.js'
