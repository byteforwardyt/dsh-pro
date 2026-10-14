import { randomUUID } from 'node:crypto'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'

/**
 * Tracks the one in-flight login per credential key and the prompt it is waiting
 * on, bridging a push-shaped seam onto a request/response HTTP surface.
 *
 * The subtle rule this class exists to enforce: **a prompt promise must never be
 * rejected because a surface stopped showing it.** `AuthorizationService.attempt`
 * treats an `AuthorizationDeclinedError` from `interaction.prompt` as the human
 * saying no and settles the whole attempt `cancelled`.
 *
 * That matters most on the flagship path. pi-ai's openai-codex flow races a
 * "paste your code" prompt against the loopback callback: rejecting the prompt
 * sets its internal `manualError`, force-resolves the loopback wait, and throws —
 * killing a login the user is at that moment completing in their browser. So a UI
 * that merely hides the paste box must leave the promise PENDING. Only two things
 * settle a prompt: a real answer, or the prompt's own `signal` (which the flow
 * fires when the other racer wins).
 *
 * Cancelling for real goes through `authorization.cancel(key)` — the request
 * signal — never through rejecting a prompt.
 */
export class AttemptRegistry {
  #attempts = new Map()
  #disposed = false
  #emit

  /** @param emit - broadcasts one event to every connected surface. */
  constructor (emit) {
    this.#emit = emit
  }

  /** Snapshot of live attempt state, for a surface that connects mid-login. */
  snapshot () {
    return [...this.#attempts.entries()].map(([key, a]) => ({
      key,
      attemptId: a.id,
      notices: a.notices.map(notice => ({ ...notice })),
      prompt: a.prompt && { ...a.prompt, options: a.prompt.options?.map(option => ({ ...option })) },
    }))
  }

  has (key, id) {
    const attempt = this.#attempts.get(key)
    return !!attempt && (id === undefined || attempt.id === id)
  }

  /**
   * Build the interaction handed to `authorization.begin`.
   *
   * Returns an attempt id alongside it. `close` requires that id back, because
   * closing by key alone races: cancel settles attempt A, a fresh begin opens
   * attempt B under the same key, and then A's cleanup — keyed only by provider —
   * would tear down B mid-flight, orphaning B's prompt where no answer, decline,
   * or abort listener can ever reach it.
   */
  open (key) {
    if (this.#disposed) throw new Error('the attempt registry is disposed')
    if (this.has(key)) throw new Error('an attempt already owns this key')
    const attempt = {
      id: randomUUID(),
      notices: [], prompt: null, resolve: null, reject: null, detach: null,
    }
    this.#attempts.set(key, attempt)
    const owns = () => !this.#disposed && this.#attempts.get(key) === attempt
    const emit = event => this.#emit({ ...event, key, attemptId: attempt.id })
    emit({ type: 'attempt-started' })

    const interaction = {
      notify: (notice) => {
        if (!owns()) return
        // Notices are informational: a surface that cannot render one must not
        // fail the flow, so nothing here throws.
        const entry = { message: notice.message, url: notice.url, code: notice.code }
        attempt.notices.push(entry)
        emit({ type: 'notice', notice: entry })
      },
      prompt: (prompt) => new Promise((resolve, reject) => {
        if (!owns()) return reject(new Error('the attempt is over'))
        if (prompt.signal?.aborted) return reject(new Error('prompt withdrawn by the flow'))
        if (attempt.prompt) return reject(new Error('another prompt is already pending'))
        const id = randomUUID()
        const wire = {
          id,
          kind: prompt.kind,
          message: prompt.message,
          placeholder: prompt.placeholder,
          options: prompt.options?.map((o) => ({ id: o.id, label: o.label, description: o.description })),
        }
        attempt.prompt = wire
        attempt.resolve = resolve
        attempt.reject = reject

        // The flow withdraws a losing racer through the prompt's own signal.
        // Settling here is correct and must NOT be reported as a decline.
        const onWithdraw = () => {
          if (!owns() || attempt.prompt?.id !== id) return
          attempt.detach?.()
          attempt.detach = null
          attempt.prompt = null
          attempt.resolve = null
          attempt.reject = null
          emit({ type: 'prompt-withdrawn', promptId: id })
          reject(new Error('prompt withdrawn by the flow'))
        }
        if (prompt.signal) {
          prompt.signal.addEventListener('abort', onWithdraw, { once: true })
          attempt.detach = () => prompt.signal.removeEventListener('abort', onWithdraw)
        } else {
          attempt.detach = null
        }

        emit({ type: 'prompt', prompt: wire })
      }),
    }

    return { interaction, id: attempt.id }
  }

  /**
   * Deliver a human's answer. Returns false when the prompt is already gone —
   * a late submit after the loopback callback won the race, which is normal.
   */
  answer (key, promptId, value) {
    const attempt = this.#attempts.get(key)
    if (!attempt || attempt.prompt?.id !== promptId || !attempt.resolve) return false
    const resolve = attempt.resolve
    attempt.detach?.()
    attempt.detach = null
    attempt.prompt = null
    attempt.resolve = null
    attempt.reject = null
    this.#emit({ type: 'prompt-answered', key, attemptId: attempt.id, promptId })
    resolve(value)
    return true
  }

  /**
   * The human explicitly refused a prompt that is the only way forward. This is
   * the ONLY place an AuthorizationDeclinedError is produced, and it is reached
   * only from an explicit "Cancel" gesture — never from hiding a racing prompt.
   */
  decline (key, promptId) {
    const attempt = this.#attempts.get(key)
    if (!attempt || attempt.prompt?.id !== promptId || !attempt.reject) return false
    const reject = attempt.reject
    attempt.detach?.()
    attempt.detach = null
    attempt.prompt = null
    attempt.resolve = null
    attempt.reject = null
    reject(new AuthorizationDeclinedError('the user declined the prompt'))
    return true
  }

  /**
   * Drop the state for one FINISHED attempt, identified by the id `open` minted.
   * A mismatched id means a newer attempt owns the key now — leave it alone.
   *
   * A prompt still pending here belongs to an orphaned flow (the seam has
   * already settled and lets a withdrawn flow "finish on its own"). Rejecting it
   * with a plain Error — never AuthorizationDeclinedError, which means a human
   * said no — lets that flow unwind and release what it holds (the openai-codex
   * loopback listener on port 1455) instead of awaiting forever.
   */
  close (key, id) {
    const attempt = this.#attempts.get(key)
    if (!attempt || attempt.id !== id) return false
    attempt.detach?.()
    attempt.detach = null
    const reject = attempt.reject
    attempt.prompt = null
    attempt.resolve = null
    attempt.reject = null
    this.#attempts.delete(key)
    if (reject) reject(new Error('the attempt is over'))
    return true
  }

  dispose () {
    this.#disposed = true
    for (const [key, attempt] of this.#attempts) this.close(key, attempt.id)
  }
}
