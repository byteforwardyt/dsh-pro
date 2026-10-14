import * as deepseek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { isDeepStrictEqual as deepEqualJson } from 'node:util'
import { settingsNamespace, settingsAccess } from './settings-access.js'

export const Config = deepseek.Config
export const inject = ['llm', 'settings', 'credentials']
const namespace = settingsNamespace('optional-deepseek')

/** Keep existing native connections; a fresh install has no mandatory vendor. */
export async function wantsNativeDeepSeek (ctx, config) {
  const user = settingsAccess(ctx).section(namespace) || {}
  if (Object.keys(user).length || !deepEqualJson(deepseek.plainOptions(config), deepseek.plainOptions(Config({})))) return true
  const reference = credentialRef(config.apiKeyEnv.get() || 'DEEPSEEK_API_KEY')
  return Boolean((await ctx.credentials.describe(reference))?.configured)
}

export async function apply (ctx, config) {
  let mounted = false
  let stopped = false
  let generation = 0
  ctx.on('dispose', () => { stopped = true; generation++ })
  const reconcile = async () => {
    if (mounted || stopped) return
    const current = ++generation
    let wanted
    try { wanted = await wantsNativeDeepSeek(ctx, config) }
    catch {
      // A metadata read failure must not disable a previously working account.
      ctx.logger?.warn?.('Could not check DeepSeek configuration; preserving the native provider.')
      wanted = true
    }
    if (!wanted || stopped || generation !== current || mounted) return
    ctx.plugin(deepseek, deepseek.plainOptions(config))
    mounted = true
  }
  ctx.on('credentials/reference-updated', () => { void reconcile() })
  await reconcile()
}
