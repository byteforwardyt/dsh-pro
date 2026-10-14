import z from '@deepseek-ai/schemastery'

export const inject = ['settings']
export const DEFAULT = 'dsh-agent'
export const LEGACY = new Set(['standard', 'code', 'minimal', 'cordis', 'dispatch'])
export const Config = z.object({ initialized: z.boolean().default(false).volatile() })

/** One-time new-chat default migration. Never rewrites existing sessions. */
export function apply(ctx) {
  ctx.effect(() => ctx.settings.configure({ auto: false }))
}
