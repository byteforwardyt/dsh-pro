import { settingsNamespace, settingsAccess } from './settings-access.js'

/**
 * Declare a provider in the `llm-pi-ai` settings namespace after a sign-in, and
 * retract that declaration when the account is removed.
 *
 * A committed credential record alone changes nothing the user can see: the
 * adapter routes only DECLARED providers, so `llm.models` keeps serving the old
 * catalog and the model picker never learns the new account exists (verified
 * live: with a ChatGPT grant stored, `openai-codex` stayed `active: false` until
 * a profile appeared). The Models page writes `["providers", <route>]` for this;
 * we write the same path with a MINIMAL profile — the catalog supplies api, base
 * URL and models for a built-in route, and credentials resolve through the
 * record store (also verified live: `{}` flips the route to `active: true` and
 * the full model group appears).
 *
 * The one field we add beyond that empty shape is `displayName`. An empty `{}`
 * carries no name, so the Models tab and the composer's model-picker group
 * header fell back to showing the bare route id — literally `openai-codex` —
 * a couple of inches from a sidebar that already says "ChatGPT connected". It
 * read as unfinished. `displayName` is the only key this file ever writes, and
 * that fact is what `AUTO_WRITTEN_KEYS` / `isOurs` below key off of when
 * deciding what is safe to retract.
 */
const NS = 'llm-pi-ai'

/**
 * Human name per provider id. Matched to the exact strings client-ui-accounts/
 * lib/client.js's `PRESENTATION` table already shows on the Accounts card (its
 * `name` field), so the Accounts panel and the Models/model-picker surfaces
 * agree on what to call each provider. auth-allowlist/lib/allowlist.js's
 * `ALLOWED_LOGIN_PROVIDERS` is the authoritative list of ids this build can
 * actually sign a user into: openai-codex, xai, openrouter, kimi-coding. Any id
 * outside that map — a route this build never offers login for — falls back to
 * the raw id below; it never throws and never writes `undefined`.
 */
const DISPLAY_NAMES = {
  'openai-codex': 'ChatGPT',
  xai: 'Grok',
  openrouter: 'OpenRouter',
  'kimi-coding': 'Kimi',
}

/** @returns a human display name for a provider id; the id itself if unmapped. */
function displayNameFor (providerId) {
  return DISPLAY_NAMES[providerId] || providerId
}

/**
 * Keys `ensureProviderDeclared` ever writes into a profile. `retractProviderIfAuto`
 * treats a stored profile whose keys are all drawn from this list as still
 * "ours" to remove — which includes the legacy bare `{}` some installs already
 * have on disk, since the empty key set is trivially a subset. A profile
 * carrying any other key was created or extended by the user (a base URL, a
 * key, anything of theirs) and must be left alone.
 */
const AUTO_WRITTEN_KEYS = ['displayName']

/** @returns the settings service, or undefined in a composition without one. */
function service (ctx) {
  return settingsAccess(ctx)
}

/** True only for the bare `{}` shape — a route declared but not yet named. */
function isEmptyProfile (profile) {
  return typeof profile === 'object' && profile !== null && Object.keys(profile).length === 0
}

/** True when every key in the profile is one of our own auto-written keys. */
function isOurs (profile, providerId) {
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return false
  return Object.keys(profile).every((key) => AUTO_WRITTEN_KEYS.includes(key))
    && (profile.displayName === undefined || profile.displayName === displayNameFor(providerId))
}

/**
 * Decide ownership and write against the SAME namespace revision. A queued
 * path operation alone protects siblings, not a profile edited since our read.
 * Unrelated conflicts retry from a fresh snapshot; custom profiles are kept.
 */
async function updateAutoProvider (ctx, providerId, remove) {
  const settings = service(ctx)
  if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.section !== 'function') return 'unavailable'
  for (let retry = 0; retry < 3; retry++) {
    try {
      const snapshot = settings.describe({ redactSecrets: true }).find(entry => entry.ns === NS)
      if (!snapshot || !Number.isSafeInteger(snapshot.revision)) return 'unavailable'
      // Redaction removes secret-bearing KEYS, so its user projection cannot
      // establish ownership. Read the raw section locally without logging or
      // returning it; no asynchronous work separates this from the revision.
      const profile = settings.section(settingsNamespace(NS))?.providers?.[providerId]
      if (remove) {
        if (profile === undefined || !isOurs(profile, providerId)) return 'kept'
      } else if (profile !== undefined && !isEmptyProfile(profile)) return 'already'
      const operation = remove
        ? { op: 'unset', path: ['providers', providerId] }
        : { op: 'set', path: ['providers', providerId], value: { displayName: displayNameFor(providerId) } }
      await settings.mutate(settingsNamespace(NS), [operation], snapshot.revision)
      return remove ? 'retracted' : 'declared'
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT' && retry < 2) continue
      ctx.logger?.warn?.(`auto-${remove ? 'retract' : 'declare'} of ${providerId} failed: ${error?.message}`)
      return 'failed'
    }
  }
}

/** Activate a provider without replacing a profile the user already configured. */
export function ensureProviderDeclared (ctx, providerId) {
  return updateAutoProvider(ctx, providerId, false)
}

/** Remove only our unchanged declaration, preserving renamed/custom profiles. */
export function retractProviderIfAuto (ctx, providerId) {
  return updateAutoProvider(ctx, providerId, true)
}
