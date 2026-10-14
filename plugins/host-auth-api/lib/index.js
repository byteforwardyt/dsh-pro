import { credentialKeyId } from '@deepseek-ai/dsh-credentials'
import { isTrustedRequest } from '@dsh-desktop/host-files-api/trust'

import { AttemptRegistry } from './attempts.js'
import { ensureProviderDeclared, retractProviderIfAuto } from './declare.js'
import { CODEX_LOOPBACK_PORT, isLoopbackBusy } from './loopback.js'
import { installUsageObserver, usageSnapshots, forgetUsage } from './usage-observer.js'
import { pollActiveUsage } from './poll-usage.js'
import { usageSummary } from './usage-history.js'
import { ensureUsableDefaultModel } from './default-model.js'
import { installLocalModels } from './local-models.js'
import { installModelCatalog } from './model-catalog.js'

/**
 * HTTP surface for the authorization seam.
 *
 * Upstream's own Agent Note names this as the missing piece: "the wire contract
 * that carries notices and prompts to the browser, and the Models-page control
 * that starts a login." The apiproxy's `RpcMethodMap` is a compile-locked table
 * we cannot extend from out of tree, so this registers its own prefix route on
 * `ctx.webServer` instead — which the carrier explicitly supports, including
 * handlers that hold a response open for SSE.
 *
 * Routes (all under /dsh-auth):
 *   GET  /state     current accounts and any live attempt
 *   GET  /events    SSE stream: notice, prompt, prompt-withdrawn, settled, state
 *   POST /begin     {provider, method?}  start a login
 *   POST /answer    {provider, promptId, value}
 *   POST /decline   {provider, promptId}  explicit human refusal
 *   POST /cancel    {provider, attemptId?}  withdraw the whole attempt
 *   POST /signout   {provider}  forget the local record
 */

const PREFIX = '/dsh-auth'

/** Services this plugin cannot work without. */
export const inject = ['webServer', 'authorization', 'credentials']

export function apply (ctx) {
  const lifetime = new AbortController()
  let streamReads = new AbortController()
  let stateRevision = 0
  let broadcastRead = null
  let accountUsageRefresh = null
  /** stream -> its heartbeat interval. Write-after-end returns false rather than
   *  throwing, so cleanup must be explicit — a catch-based prune never fires. */
  const streams = new Map()

  const dropStream = (res) => {
    const beat = streams.get(res)
    if (beat !== undefined) clearInterval(beat)
    streams.delete(res)
    if (!streams.size) streamReads.abort()
    syncUsagePolling()
  }

  const emit = (event) => {
    // State snapshots retain the revision they read. Incremental events advance
    // it so clients can reject a snapshot captured before a newer prompt/event.
    const stamped = event.type === 'state' ? event : {...event,revision:++stateRevision}
    const frame = `data: ${JSON.stringify(stamped)}\n\n`
    for (const res of streams.keys()) {
      if (res.writableEnded || res.destroyed) { dropStream(res); continue }
      res.write(frame)
    }
  }

  const attempts = new AttemptRegistry(emit)
  const signingOut = new Set()
  const signOutGenerations = new Map()
  const signOutWarnings = new Map()
  const declarations = new Map()
  const declareProvider = key => {
    if (signingOut.has(key) || lifetime.signal.aborted) return Promise.resolve('unavailable')
    if (declarations.has(key)) return declarations.get(key)
    const pending = ensureProviderDeclared(ctx, credentialKeyId(key)).finally(() => {
      if (declarations.get(key) === pending) declarations.delete(key)
    })
    declarations.set(key, pending)
    void pending.then(() => {
      if (!signingOut.has(key) && !lifetime.signal.aborted) void modelCatalog.connected(credentialKeyId(key))
    })
    return pending
  }

  // Local model servers (Ollama, LM Studio): detect, declare, retract.
  const localModels = installLocalModels(ctx)
  const modelCatalog = installModelCatalog(ctx)

  // Passive usage readout: harvested from response headers on traffic the
  // harness already sends. Empty until the first model request flows.
  /**
   * Bring already-connected providers up to the current declaration shape.
   *
   * `ensureProviderDeclared` only ever ran after a fresh sign-in, so an install
   * that connected an account BEFORE this build kept whatever was written then
   * — for most people an empty `{}` profile, which is why the Models tab and
   * the model picker showed a raw `openai-codex` next to a sidebar reading
   * "ChatGPT connected". Those users would never have seen the fix, because
   * nothing would call the writer again until they signed out and back in.
   *
   * Idempotent by construction: a profile the user has edited is left alone,
   * and one that already carries our name returns 'already' untouched. Failures
   * are logged and dropped — this is a cosmetic reconciliation and must never
   * be able to stop the plugin from coming up.
   */
  let reconciled = false
  const reconcileDeclarations = async () => {
    if (reconciled) return
    try {
      const entries = ctx.authorization.list()
      ctx.logger?.info?.(`declaration reconcile: ${entries.length} flow(s) registered`)
      if (entries.length === 0) return
      reconciled = true
      for (const entry of entries) {
        if (signingOut.has(entry.key)) continue
        const generation = signOutGenerations.get(entry.key)
        const record = await ctx.credentials.describeRecord(entry.key).catch(() => null)
        // A read that predates a completed sign-out must not recreate its route.
        if (signingOut.has(entry.key) || signOutGenerations.get(entry.key) !== generation) continue
        if (!record || !record.configured) continue
        await declareProvider(entry.key)
      }
      // Upstream's base composition defaults every new session to a DeepSeek
      // model. This build ships no DeepSeek credential, so that default cannot
      // work here — retarget it to an account the user actually connected.
      // Only ever moves a default that is unusable.
      const retarget = await ensureUsableDefaultModel(ctx)
      if (retarget !== 'ok') ctx.logger?.info?.(`default model check: ${retarget}`)
    } catch (error) {
      ctx.logger?.warn?.(`declaration reconcile failed: ${error?.message}`)
    }
  }
  ctx.on('ready', () => { void reconcileDeclarations() })

  const broadcastState = () => {
    if (!streams.size || lifetime.signal.aborted) return
    if (broadcastRead && !broadcastRead.signal.aborted) return
    const signal = AbortSignal.any([lifetime.signal, streamReads.signal])
    const job = {signal,revision:stateRevision}
    broadcastRead = job
    void readState(signal).then((state) => {
      job.revision = state.revision
      if (!signal.aborted && state.revision === stateRevision) emit({ type: 'state', ...state })
    }).catch(() => {
      if (signal.aborted) return
      // An open stream with no fresh state looks healthy to EventSource. Close
      // it so clients enter their bounded reconnect/staleness flow instead.
      for (const res of streams.keys()) { dropStream(res); res.end() }
    }).finally(() => {
      if (broadcastRead !== job) return
      broadcastRead = null
      // An invalidation may arrive between readState resolving and publication.
      // Retry that change once; an unchanged failing read must not spin.
      if (!signal.aborted && job.revision !== stateRevision) broadcastState()
    })
  }
  const invalidateState = () => { stateRevision++; broadcastState() }
  const uninstallUsage = installUsageObserver(invalidateState)

  // A GET request's incoming body may finish while its response is still being
  // built. Listen to the response closing, not IncomingMessage's normal close.
  const readForResponse = async (res, read) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    if (res.destroyed) abort()
    const signal = AbortSignal.any([lifetime.signal, controller.signal])
    const shutdown = () => { if (lifetime.signal.aborted && !res.destroyed) res.destroy() }
    signal.addEventListener('abort', shutdown, {once:true})
    try {
      if (signal.aborted) shutdown()
      signal.throwIfAborted()
      const value = await read(signal)
      signal.throwIfAborted()
      return value
    } finally {
      res.removeListener('close', abort)
      signal.removeEventListener('abort', shutdown)
    }
  }

  /** Discard a read invalidated by credentials, usage, or live attempt events. */
  const readState = async (signal) => {
    for (;;) {
      signal?.throwIfAborted()
      const revision = stateRevision
      const state = await readStateOnce(signal)
      signal?.throwIfAborted()
      if (revision === stateRevision) return {...state,revision}
    }
  }

  /** Compose the account list from the flow registry plus stored records. */
  const readStateOnce = async (signal) => {
    signal?.throwIfAborted()
    // Reconcile here rather than at apply(): at apply time the authorization
    // service has not necessarily registered its flows yet, so list() is empty
    // and there is nothing to upgrade. readState runs as soon as any surface
    // asks for the account list, by which point the registry is populated.
    void reconcileDeclarations()
    const entries = ctx.authorization.list()
    // Only openai-codex needs a loopback; probing once per read keeps the UI
    // honest about whether its browser path is currently available.
    const loopbackBusy = entries.some((e) => credentialKeyId(e.key) === 'openai-codex')
      ? await isLoopbackBusy()
      : false
    const accounts = await Promise.all(entries.map(async (entry) => {
      const record = await ctx.credentials.describeRecord(entry.key)
      const provider = credentialKeyId(entry.key)
      return {
        provider,
        key: entry.key,
        label: entry.label,
        methods: entry.methods.map((m) => ({ id: m.id, label: m.label })),
        inFlight: entry.inFlight,
        signingOut: signingOut.has(entry.key),
        signOutWarning: signOutWarnings.get(entry.key),
        // `configured` is the whole fact for a record: presence, not layering.
        configured: record.configured,
        kind: record.kind,
        // Present only where it means something.
        loopbackPort: provider === 'openai-codex' ? CODEX_LOOPBACK_PORT : undefined,
        loopbackBusy: provider === 'openai-codex' ? loopbackBusy : undefined,
        usage: usageSnapshots()[provider],
      }
    }))
    // Durable spend, per provider, folded from the session logs. The card used
    // to say "usage appears after your first message" forever on any provider
    // that does not volunteer quota headers — with 133 turns on record. Tokens
    // spent is a fact every provider leaves behind, so it is always available
    // even when a plan percentage is not.
    let spend = null
    try {
      const summary = await usageSummary({signal})
      spend = { total: summary.totals, coverage: summary.coverage, byProvider: Object.create(null) }
      for (const model of summary.models) {
        const bucket = spend.byProvider[model.provider] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 }
        bucket.input += model.input
        bucket.output += model.output
        bucket.cacheRead += model.cacheRead
        bucket.cacheWrite += model.cacheWrite
        bucket.total += model.total
        bucket.turns += model.turns
        spend.byProvider[model.provider] = bucket
      }
    } catch { signal?.throwIfAborted(); spend = null }

    return { accounts, live: attempts.snapshot(), spend }
  }

  // Owned attempts publish their terminal event only after registry cleanup.
  // Otherwise a state read can briefly resurrect an already-settled prompt.
  ctx.on('authorization/settled', (key, settlement) => {
    if (lifetime.signal.aborted) return
    if (!attempts.has(key)) emit({ type: 'settled', key, settlement })
    invalidateState()
  })

  ctx.on('credentials/record-updated', (key) => {
    forgetUsage(credentialKeyId(key))
    invalidateState()
    void modelCatalog.refresh(credentialKeyId(key))
    // A newly connected account should not wait for the five-minute interval.
    // Debounce credential writes; concurrent refreshes share the existing poll.
    clearTimeout(accountUsageRefresh)
    accountUsageRefresh = setTimeout(() => {
      accountUsageRefresh = null
      if (streams.size && !lifetime.signal.aborted) {
        void pollActiveUsage(ctx, AbortSignal.any([lifetime.signal, streamReads.signal])).catch(() => {})
      }
    }, 250)
  })

  const keyFor = (provider) => {
    const entry = ctx.authorization.list().find((e) => credentialKeyId(e.key) === provider)
    return entry?.key
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(PREFIX.length) || '/'

    // The fence runs BEFORE the read-only routes, not after.
    //
    // It used to sit below them and to compare Origin against Host — two
    // headers the caller supplies, which therefore agree trivially under DNS
    // rebinding. A page served from evil.test resolving to 127.0.0.1 satisfied
    // "same origin" by simply being consistent about a lie. GET /state and
    // GET /events answered above the fence with no check at all, exposing the
    // account list and any in-flight device code, and POST /signout was
    // reachable the same way.
    //
    // Mirrors upstream's own isTrustedApiRequest: pin Host to a loopback
    // authority — a name the attacker does not control — and honour the
    // browser's own cross-site declaration.
    if (!isTrustedRequest(req)) {
      return json(res, 403, { error: 'cross-origin request refused' })
    }

    if (route === '/events' && req.method === 'GET') return openStream(req, res)

    if (route === '/usage' && req.method === 'GET') {
      // Durable usage, folded out of the session logs — provider-agnostic and
      // retrospective, unlike the plan meter which depends on a vendor
      // volunteering headers.
      try {
        return json(res, 200, await readForResponse(res, signal => usageSummary({signal})))
      } catch (error) {
        if (res.destroyed || lifetime.signal.aborted) return
        ctx.logger?.warn?.(`usage summary failed: ${error?.message}`)
        return json(res, 200, { totals: null, models: [], days: [], hours: [] })
      }
    }

    if (route === '/state' && req.method === 'GET') {
      try { return json(res, 200, await readForResponse(res, readState)) }
      catch (error) { if (!res.destroyed && !lifetime.signal.aborted) throw error }
      return
    }

    if (route === '/local-models' && req.method === 'GET') {
      // Live snapshot from the reconciler — which servers answered the last
      // probe and what they serve. Read-only and loopback-fenced above.
      return json(res, 200, localModels.state)
    }

    if (route === '/models' && req.method === 'GET') {
      void modelCatalog.refreshAll()
      return json(res, 200, modelCatalog.state)
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method-not-allowed' })

    // Mirrors the apiproxy's own cross-site fence: a browser will not send this
    // content type cross-origin without a preflight the server never answers.
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      return json(res, 415, { error: 'expected application/json' })
    }

    const body = await readJson(req).catch(() => null)
    if (route === '/models/refresh' && body && typeof body === 'object') {
      await modelCatalog.refreshAll(true)
      return json(res, 200, modelCatalog.state)
    }
    if (!body || typeof body.provider !== 'string') {
      return json(res, 400, { error: 'provider is required' })
    }
    const key = keyFor(body.provider)
    if (!key) return json(res, 404, { error: `no login flow for "${body.provider}"` })

    switch (route) {
      case '/begin': return beginLogin(res, key, body.method)
      case '/answer':
        return json(res, 200, { delivered: attempts.answer(key, body.promptId, String(body.value ?? '')) })
      case '/decline':
        return json(res, 200, { declined: attempts.decline(key, body.promptId) })
      case '/cancel':
        if (body.attemptId !== undefined && !attempts.has(key, body.attemptId)) {
          return json(res, 409, { error: 'stale-attempt' })
        }
        try {
          await ctx.authorization.cancel(key)
          return json(res, 200, { ok: true })
        } catch {
          return json(res, 500, { error: 'The sign-in could not be cancelled. Check its current status before trying again.' })
        }
      case '/signout': return signOut(res, key)
      default:
        return json(res, 404, { error: 'unknown route' })
    }
  }

  const signOut = async (res, key) => {
    if (lifetime.signal.aborted) return json(res, 503, { error: 'The app is shutting down.' })
    if (signingOut.has(key)) return json(res, 409, { error: 'Sign-out is already in progress.' })
    if (attempts.has(key) || ctx.authorization.list().some(entry => entry.key === key && entry.inFlight)) {
      return json(res, 409, { error: 'Finish or cancel the current sign-in before signing out.' })
    }
    // Reserve synchronously, before either storage operation can yield. All
    // Accounts surfaces share this guard, and unrelated providers remain usable.
    signingOut.add(key)
    signOutGenerations.set(key, (signOutGenerations.get(key) || 0) + 1)
    signOutWarnings.delete(key)
    invalidateState()
    try {
      await declarations.get(key)
      lifetime.signal.throwIfAborted()
      await modelCatalog.disconnect(credentialKeyId(key))
      await ctx.credentials.deleteRecord(key)
      forgetUsage(credentialKeyId(key))
      const cleanup = await retractProviderIfAuto(ctx, credentialKeyId(key))
      const warning = cleanup === 'failed'
        ? 'The local credential was removed, but provider settings could not be cleaned up. Review this provider in Models.'
        : undefined
      if (warning) signOutWarnings.set(key, warning)
      return json(res, 200, { ok: true, revokedRemotely: false, cleanup, warning })
    } catch {
      return json(res, 500, { error: 'Sign-out could not finish. Check account status before trying again.' })
    } finally {
      signingOut.delete(key)
      invalidateState()
    }
  }

  const beginLogin = async (res, key, method) => {
    if (signingOut.has(key)) return json(res, 409, { error: 'Sign-out is still finishing. Wait before signing in again.' })
    if (attempts.has(key)) return json(res, 409, { error: 'already-in-flight' })
    signOutWarnings.delete(key)
    const { interaction, id } = attempts.open(key)
    // Answer the caller immediately: the attempt runs for as long as the human
    // takes, and its progress arrives on the event stream.
    json(res, 202, { started: true, key, attemptId: id })
    let settlement = 'failed'
    const owns = () => !lifetime.signal.aborted && attempts.has(key, id)
    try {
      const outcome = await ctx.authorization.begin({ key, method, interaction, signal: lifetime.signal })
      if (!owns()) return
      settlement = outcome.status
      if (outcome.status === 'authorized') {
        // A stored grant activates nothing by itself — the adapter routes only
        // declared providers (verified live). Declaring here is what turns a
        // completed sign-in into models in the picker without another gesture.
        await declareProvider(key)
      }
      if (owns()) emit({ type: 'outcome', key, attemptId: id, status: outcome.status })
    } catch (error) {
      settlement = 'failed'
      if (owns()) emit({ type: 'outcome', key, attemptId: id, status: 'failed', message: describeError(error) })
    } finally {
      if (attempts.close(key, id) && !lifetime.signal.aborted) {
        emit({ type: 'settled', key, attemptId: id, settlement })
        broadcastState()
      }
    }
  }

  /**
   * Active usage polls run only while someone is watching: the first open SSE
   * stream starts the interval, the last one closing stops it. A closed app
   * makes no vendor traffic, and an open one makes bounded usage reads every
   * five minutes.
   */
  let usagePollTimer = null
  const syncUsagePolling = () => {
    const shouldRun = streams.size > 0
    if (shouldRun && usagePollTimer === null) {
      void pollActiveUsage(ctx, AbortSignal.any([lifetime.signal, streamReads.signal])).catch(() => {})
      usagePollTimer = setInterval(() => { void pollActiveUsage(ctx, AbortSignal.any([lifetime.signal, streamReads.signal])).catch(() => {}) }, 5 * 60_000)
    } else if (!shouldRun && usagePollTimer !== null) {
      clearInterval(usagePollTimer)
      usagePollTimer = null
    }
  }

  const openStream = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(': connected\n\n')
    // Proxies and laptops sleeping mid-login both benefit from a heartbeat.
    const beat = setInterval(() => {
      if (res.writableEnded || res.destroyed) dropStream(res)
      else res.write(': ping\n\n')
    }, 25_000)
    if (!streams.size) streamReads = new AbortController()
    streams.set(res, beat)
    syncUsagePolling()
    void readForResponse(res, readState).then((state) => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`data: ${JSON.stringify({ type: 'state', ...state })}\n\n`)
      }
    }).catch(() => { if (!res.destroyed && !res.writableEnded) res.end() })
    res.on('close', () => dropStream(res))
    req.on('error', () => dropStream(res))
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler })

  ctx.on('dispose', () => {
    clearTimeout(accountUsageRefresh)
    lifetime.abort()
    attempts.dispose()
    streamReads.abort()
    dispose()
    localModels.dispose()
    modelCatalog.dispose()
    if (usagePollTimer !== null) { clearInterval(usagePollTimer); usagePollTimer = null }
    // SSE responses never end on their own; teardown would hang without this —
    // and each one's heartbeat interval must be cleared or it outlives the plugin
    // (an HMR reload of this plugin would leak one interval per open stream).
    for (const [res, beat] of streams) {
      clearInterval(beat)
      try { res.end() } catch {}
    }
    streams.clear()
    uninstallUsage()
  })
}

function json (res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function readJson (req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64_000) {
        // Rejecting alone keeps the socket draining into memory; kill it.
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

/** Surface the seam's error codes, which name the real problem. */
function describeError (error) {
  const code = error?.code
  if (code === 'ALREADY_IN_FLIGHT') return 'A sign-in for this provider is already running.'
  if (code === 'NO_FLOW') return 'This provider does not offer a sign-in.'
  if (code === 'UNKNOWN_METHOD') return 'That sign-in method is not offered.'
  if (code === 'NOT_COMMITTED') return 'The sign-in finished without saving a credential.'
  return error?.message ?? 'The sign-in failed.'
}
