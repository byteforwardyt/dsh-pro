/**
 * Keep the default model pointed at an account the user actually has.
 *
 * Upstream's base composition hardcodes a DeepSeek default
 * (`dsh-base/cordis.patch.yml`: `agent-default-model` → provider
 * `deepseek-official`, model `deepseek-v4-flash`). That is the right default
 * for DeepSeek's own build. It is the wrong one here: this product is the
 * provider-agnostic edition, it offers sign-in for ChatGPT, Grok, Kimi and
 * OpenRouter, and it ships no DeepSeek credential — so a fresh install pointed
 * every new session at a provider the user had not configured and could not
 * use without going and getting a DeepSeek key.
 *
 * The fix is not another hardcoded vendor, which would only move the problem.
 * It is to follow the user: if the default provider has no stored credential
 * and some allowlisted provider does, retarget to that one and take its first
 * catalogued model. A default the user has explicitly chosen, or one that
 * works, is never touched.
 */

import { credentialKey, credentialKeyId } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace, settingsAccess } from './settings-access.js'

const NS = 'agent-default-model'

/** Preference order when several accounts are connected: the flagship paths first. */
const PREFERENCE = ['openai-codex', 'xai', 'kimi-coding', 'openrouter']

/** Is a credential stored for this provider? */
async function isConfigured (ctx, provider) {
  try {
    const record = await ctx.credentials.describeRecord(credentialKey('llm-pi-ai', provider))
    return Boolean(record?.configured)
  } catch {
    return false
  }
}

/** Providers this build can sign into, in preference order, that are connected. */
async function connectedProviders (ctx) {
  // credentialKeyId is the seam's own parser; splitting the key string by hand
  // would encode an assumption about its grammar that is not ours to make.
  const registered = ctx.authorization.list()
    .map((entry) => credentialKeyId(entry.key))
    .filter(Boolean)
  const ordered = [
    ...PREFERENCE.filter((id) => registered.includes(id)),
    ...registered.filter((id) => !PREFERENCE.includes(id)),
  ]
  const connected = []
  for (const provider of ordered) {
    if (await isConfigured(ctx, provider)) connected.push(provider)
  }
  return connected
}

/**
 * Retarget the default model when, and only when, it cannot work.
 *
 * @returns 'ok' when the current default is usable or the user set it,
 *   'retargeted' when it was moved, or a reason it could not be.
 */
export async function ensureUsableDefaultModel (ctx) {
  const settings = settingsAccess(ctx)
  if (settings === undefined) return 'unavailable'

  let current
  try {
    current = settings.describe({ redactSecrets: true }).find(row => row.ns === NS)?.value
  } catch {
    return 'unavailable'
  }
  const provider = current?.provider
  if (typeof provider === 'string' && provider && await isConfigured(ctx, provider)) return 'ok'

  const connected = await connectedProviders(ctx)
  if (connected.length === 0) return 'no-accounts'
  const next = connected[0]

  // The model comes from the live catalog rather than a constant here: model
  // ids move with every pi-ai bump, and a stale hardcoded id would point the
  // default at a model that no longer exists — the same class of failure this
  // function exists to remove.
  // ctx.get('llm') rather than ctx.llm: this plugin does not inject the llm
  // service (it must keep working in a composition without one), and a
  // non-injected service is not a property on the context.
  let model
  try {
    const llm = ctx.get('llm')
    const models = await llm?.listModels?.(next)
    model = models?.[0]?.id ?? models?.[0]?.model
  } catch (error) {
    ctx.logger?.warn?.(`default model: listing models for ${next} failed: ${error?.message}`)
    model = undefined
  }
  if (typeof model !== 'string' || !model) return 'no-models'

  try {
    await settings.mutate(settingsNamespace(NS), [
      { op: 'set', path: ['provider'], value: next },
      { op: 'set', path: ['model'], value: model },
    ])
    ctx.logger?.info?.(`default model retargeted to ${next}/${model} (was ${provider ?? 'unset'})`)
    return 'retargeted'
  } catch (error) {
    ctx.logger?.warn?.(`default model retarget failed: ${error?.message}`)
    return 'failed'
  }
}
