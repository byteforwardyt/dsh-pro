/**
 * The dispatch engine, UI-free.
 *
 * This is the reusable core that used to live inside the Dispatch tab's HTTP
 * route: spawn one agent CLI, decode its NDJSON, wait for it to finish, and
 * hand back a normalized result. The tab is gone; the tool calls this directly,
 * in the same process, so there is no loopback, no SSE, and no run registry —
 * one `run()`, awaited to completion.
 *
 * Every safety property the tab had is kept here, because a dispatched agent is
 * a process running with the user's own credentials: the cwd is fenced to an
 * opened workspace by the caller, argv is an array (never a shell string), the
 * spawn goes through ctx.subprocess (credential scrub, tree-kill), and codex
 * stays read-only.
 */

import { parseLine } from './agents.js'

/** Long enough for a real task; short enough that a wedged CLI cannot sit forever. */
const RUN_TIMEOUT_MS = 10 * 60_000

/**
 * Run one agent CLI to completion.
 *
 * @param ctx - the plugin context (needs ctx.subprocess).
 * @param adapter - the chosen agent adapter from agents.js.
 * @param prompt - the task for the other agent.
 * @param cwd - an already-fenced absolute workspace path.
 * @param signal - the tool runtime's cancellation signal; aborting terminates the tree.
 * @returns { ok, exitCode, events, finalText, usage, error }
 */
export async function run ({ ctx, adapter, prompt, cwd, signal }) {
  const events = []
  let usage = null
  let stderrTail = ''

  const handle = ctx.subprocess.spawn({
    argv: adapter.argv({ prompt, cwd }),
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5000,
    signal,
  })

  // A watchdog independent of the caller's signal: some CLIs hang without
  // printing anything, and the tool must still return.
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { handle.terminate() } catch {} }, RUN_TIMEOUT_MS)

  let buffer = ''
  handle.stdout?.setEncoding('utf8')
  handle.stdout?.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const event = parseLine(adapter, line)
      if (event) {
        if ((event.kind === 'result' || event.kind === 'usage') && event.usage) usage = event.usage
        if (event.kind === 'usage') usage = event
        events.push(event)
      }
      index = buffer.indexOf('\n')
    }
    // A single line larger than this is not a message we can use.
    if (buffer.length > 2_000_000) buffer = ''
  })

  handle.stderr?.setEncoding('utf8')
  handle.stderr?.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000) })

  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    clearTimeout(timer)
    return { ok: false, exitCode: null, events, finalText: '', usage, error: error?.message ?? 'could not start' }
  }
  clearTimeout(timer)

  const exitCode = outcome?.code ?? outcome?.exitCode ?? null
  const finalText = pickFinalText(events)
  const aborted = signal?.aborted || timedOut

  // The adapters parse each agent's own success into the terminal result event's
  // `ok` (subtype === 'success', or !is_error). A clean exit code is not the
  // same as a successful turn — an agent can report a failure and still exit 0 —
  // so a result event that says ok:false makes the dispatch not-ok too.
  const resultEvent = [...events].reverse().find((e) => e.kind === 'result')
  const reportedFailure = Boolean(resultEvent && resultEvent.ok === false)

  return {
    ok: exitCode === 0 && !aborted && !reportedFailure,
    exitCode,
    events,
    finalText,
    usage,
    error: aborted
      ? (timedOut ? `no result after ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes` : 'cancelled')
      : (exitCode !== 0 ? (stderrTail.trim() || `exited ${exitCode}`)
        : (reportedFailure ? ((resultEvent.text || '').trim() || 'the agent reported a failure') : null)),
  }
}

/** The agent's answer: its explicit result if it gave one, else its prose. */
function pickFinalText (events) {
  const result = [...events].reverse().find((e) => e.kind === 'result' && e.text)
  if (result) return result.text
  return events.filter((e) => e.kind === 'text').map((e) => e.text).join('\n').trim()
}
