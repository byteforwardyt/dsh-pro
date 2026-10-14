import { isTrustedRequest } from '@dsh-desktop/host-files-api/trust'
import { createSchedules } from './schedules.js'

export const inject = ['webServer', 'agents', 'sessions', 'sessionPersistence', 'sessionQuery', 'tools', 'schedule']

export function apply (ctx) {
  const schedules = createSchedules(ctx)
  const active = new Set()
  const json = (res, status, payload) => {
    if (res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/dsh-workspace', handler: async (req, res) => {
    if (!isTrustedRequest(req)) return json(res, 403, { error: 'Cross-origin request refused.' })
    const controller = new AbortController()
    active.add(controller)
    const cancel = () => { controller.abort(); if (!req.complete) req.destroy() }
    req.once('aborted', cancel); res.once('close', cancel)
    const timer = setTimeout(cancel, 30000)
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/dsh-workspace/sessions') return json(res, 200, await schedules.sessions(controller.signal))
      if (req.method === 'GET' && url.pathname === '/dsh-workspace/schedules') return json(res, 200, await schedules.list(url.searchParams.get('session'), controller.signal))
      if (req.method === 'POST' && url.pathname === '/dsh-workspace/schedules') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON body required.' })
        const chunks = []
        let size = 0
        for await (const chunk of req) {
          size += chunk.length
          if (size > 40000) return json(res, 413, { error: 'Request too large.' })
          chunks.push(chunk)
        }
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return json(res, 400, { error: 'Invalid JSON.' }) }
        return json(res, 200, await schedules.change(body, controller.signal))
      }
      json(res, 404, { error: 'Not found.' })
    } catch (error) {
      json(res, error.status || 503, { error: controller.signal.aborted ? 'Request timed out. Refresh to check whether the change was saved.' : error.status ? error.message : 'Could not load schedules. Try refreshing.' })
    } finally {
      clearTimeout(timer); active.delete(controller); req.off('aborted', cancel); res.off('close', cancel)
    }
  } })
  ctx.on('dispose', () => { dispose(); for (const controller of active) controller.abort() })
}
