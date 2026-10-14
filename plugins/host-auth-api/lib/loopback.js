import net from 'node:net'

/**
 * pi-ai's openai-codex browser login binds a HARDCODED loopback port for its
 * RFC 8252 redirect: http://localhost:1455/auth/callback. Two consequences the
 * surface has to cope with, both observed in practice:
 *
 *  1. Cancelling an attempt releases the seam's key immediately, but the flow
 *     itself is left to unwind on its own ("the orphaned run is left to finish"),
 *     so the listener can outlive the cancel. An instant retry would fail with
 *     EADDRINUSE from inside the flow, surfacing as an opaque error.
 *  2. Anyone running OpenAI's real Codex CLI holds the same port.
 *
 * Probing lets the UI say which of those it is and offer the device-code path,
 * instead of letting the user meet a raw bind error.
 */
export const CODEX_LOOPBACK_PORT = 1455

/** @returns {Promise<boolean>} true when something already holds the port. */
export function isLoopbackBusy (port = CODEX_LOOPBACK_PORT) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (error) => {
      // EADDRINUSE is the answer we are looking for; anything else (EACCES on a
      // locked-down box) is also "cannot use it", so treat it the same way.
      resolve(error?.code === 'EADDRINUSE' || error?.code === 'EACCES')
    })
    probe.once('listening', () => probe.close(() => resolve(false)))
    // Bind the same interface pi-ai does, or the probe answers a different question.
    try { probe.listen(port, '127.0.0.1') } catch { resolve(true) }
  })
}
