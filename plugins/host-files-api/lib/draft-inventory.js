import { once } from 'node:events'
import { containedPath } from './roots.js'

// A separate additive endpoint keeps legacy /drafts callers compatible. The
// response contains metadata only; opening/discarding still uses guarded routes.
export async function streamDraftInventory (req, res, store, ctx, lifetime) {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, lifetime])
  const cancel = () => controller.abort()
  req.once('aborted', cancel); res.once('close', cancel)
  let scanned = 0, unreadable = 0, batch = [], lastFlush = Date.now()
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  const send = async payload => {
    signal.throwIfAborted()
    if (!res.write(JSON.stringify(payload) + '\n')) await once(res, 'drain', { signal })
  }
  try {
    await send({ drafts: [], scanned, unreadable, done: false })
    for await (const item of store.inventory({ signal })) {
      scanned++
      if (item.unreadable) unreadable++
      else {
        const contained = await containedPath(ctx, item.draft.path)
        signal.throwIfAborted()
        if (contained?.path === item.draft.path) batch.push({ ...item.draft, root: contained.root })
      }
      if (batch.length >= 25 || scanned % 100 === 0 || Date.now() - lastFlush >= 100) {
        await send({ drafts: batch, scanned, unreadable, done: false })
        batch = []; lastFlush = Date.now()
      }
    }
    await send({ drafts: batch, scanned, unreadable, done: true })
    res.end()
  } catch (error) {
    if (!signal.aborted && !res.destroyed) {
      res.end(JSON.stringify({ error: 'Draft scan did not finish. Refresh drafts to try again.' }) + '\n')
      ctx.logger?.warn?.('draft inventory: %s', error?.message ?? error)
    } else if (!res.destroyed) res.destroy()
  } finally { req.off('aborted', cancel); res.off('close', cancel) }
}
