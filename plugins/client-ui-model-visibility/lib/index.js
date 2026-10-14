import z from '@deepseek-ai/schemastery'
import { isTrustedRequest } from '@dsh-desktop/host-files-api/trust'

const NS = 'desktop-model-visibility'
export const Config = z.object({ selections: z.dict(z.array(z.string())).default({}).volatile() })
export const inject = ['webServer', 'settings', 'llm']

export function validSelection(body) {
  return body && typeof body.provider === 'string' && body.provider.length > 0 && body.provider.length <= 512
    && Number.isInteger(body.revision) && body.revision >= 0
    && (body.models === null || (Array.isArray(body.models) && body.models.length <= 10000
      && body.models.every(id => typeof id === 'string' && id.length > 0 && id.length <= 1024)))
    && !['__proto__', 'constructor', 'prototype'].includes(body.provider)
}

/** Preferences live in the host settings document, not a port-specific browser origin. */
export function apply(ctx, config) {
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  const snapshot = () => ({
    selections: config.selections.get(),
    revision: ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === NS).revision,
  })
  ctx.webServer.register({ kind: 'prefix', path: '/dsh-model-visibility', handler: async (req, res) => {
    const reply = (status, data) => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(data))
    }
    if (!isTrustedRequest(req)) return reply(403, { error: 'Forbidden' })
    const path = new URL(req.url, 'http://localhost').pathname
    try {
      if (req.method === 'GET' && path === '/dsh-model-visibility') return reply(200, snapshot())
      if (req.method === 'GET' && path === '/dsh-model-visibility/catalog') {
        const groups = await Promise.all(ctx.llm.listProviders().map(async provider => {
          try {
            return { ...provider, models: await ctx.llm.listModels(provider.id) }
          } catch {
            return { ...provider, models: [], error: 'This connection’s model catalog could not be loaded. Retry to check again.' }
          }
        }))
        return reply(200, { groups })
      }
      if (req.method !== 'POST' || path !== '/dsh-model-visibility') return reply(404, { error: 'Not found' })
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return reply(415, { error: 'Expected JSON' })
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > 1024 * 1024) return reply(413, { error: 'Selection is too large' })
        chunks.push(Buffer.from(chunk))
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(400, { error: 'Invalid JSON' }) }
      if (!validSelection(body)) return reply(400, { error: 'Invalid model selection' })
      await ctx.settings.mutate(NS, [{ op: body.models === null ? 'unset' : 'set',
        path: ['selections', body.provider], ...(body.models === null ? {} : { value: [...new Set(body.models)] }) }], body.revision)
      reply(200, snapshot())
    } catch (error) {
      reply(error?.name === 'SettingsConflictError' ? 409 : 500, { error: 'Could not save or load model preferences. Refresh and try again.' })
    }
  } })
}
