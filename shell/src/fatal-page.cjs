'use strict'
/**
 * Policy for the fatal screen, kept off Electron so the fence can be tested
 * as URL strings rather than as a running window.
 *
 * Retry restarts the host. Reveal Logs opens a file on disk. The same preload
 * is attached to the harness page, so those two calls must no-op unless the
 * sender is the fatal document itself. A prefix check on the URL would accept
 * `file:///tmp/error.html.evil` or an http page whose path happened to match.
 * Protocol plus a resolved-path equality with the bundled error.html is the
 * whole test.
 */

const path = require('node:path')

/**
 * True only for our bundled error page, never for the harness origin.
 *
 * @param {string} rawUrl
 * @param {string} errorPagePath absolute path of shell/src/ui/error.html
 */
function isFatalPage (rawUrl, errorPagePath) {
  if (!errorPagePath) return false
  try {
    const parsed = new URL(String(rawUrl ?? ''))
    if (parsed.protocol !== 'file:') return false
    let pathname = decodeURIComponent(parsed.pathname)
    // Chromium's file URL for `C:\...` is `/C:/...`. Strip the extra slash
    // so path.resolve can compare it to a Windows absolute path.
    if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
    return path.resolve(pathname) === path.resolve(errorPagePath)
  } catch {
    return false
  }
}

/**
 * After a host that had become ready dies, should we restart it ourselves or
 * stop and let the person decide?
 *
 * Two silent restarts, then we stop. A crash loop that keeps relaunching on
 * its own looks like a hang: the loading screen flashes, the window never
 * stays up, and Retry on the fatal page is the thing they cannot reach.
 * `consecutive` is how many crashes have already been auto-restarted in this
 * streak (0 on the first death).
 */
function crashRestartPlan (consecutive, { max = 2, delaysMs = [800, 2400] } = {}) {
  const n = Number(consecutive)
  if (!Number.isFinite(n) || n < 0 || n >= max) return { action: 'fatal' }
  const delayMs = delaysMs[Math.min(n, delaysMs.length - 1)]
  return { action: 'retry', delayMs }
}

/**
 * The sentence on the fatal screen for a host that died after it was ready.
 *
 * The exit code belongs in the title so the first thing a person reads names
 * what failed. A signal without a code is named as the signal; a code wins
 * when both are present, and the signal goes in the body.
 */
function unexpectedStopTitle (code, signal) {
  if ((code === null || code === undefined) && signal) {
    return `The harness stopped unexpectedly (${signal})`
  }
  return `The harness stopped unexpectedly (exit ${code})`
}

module.exports = { isFatalPage, crashRestartPlan, unexpectedStopTitle }
