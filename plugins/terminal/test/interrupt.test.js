/**
 * Ctrl+C.
 *
 * Three separate claims are being checked, and 0.1.22 got all three wrong for
 * the same underlying reason — it signalled the shell's direct children rather
 * than the process group, and then reported whether the signal had a target
 * rather than whether the command stopped.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { createSessions } from '../lib/sessions.js'
import { deadline, descendants, fixtureContext, plainShell, until, workspace } from './harness.js'

async function session (body, shell = '/bin/sh') {
  const root = workspace()
  const sessions = createSessions(fixtureContext([root]), { reapIntervalMs: 3_600_000 })
  const restore = plainShell(shell)
  const seen = []
  try {
    const opened = await sessions.open({ cwd: root })
    const detach = sessions.subscribe(opened.id, null, (event) => seen.push(event))
    try { await body({ sessions, id: opened.id, pid: opened.pid, root, seen }) } finally { detach() }
  } finally {
    restore()
    await sessions.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

const transcript = (seen) => seen.filter((event) => event.kind === 'chunk').map((event) => event.text).join('')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for the command to become a real process before interrupting it.
 *
 * A fixed pause measures the scheduler rather than the defect. A cold
 * `zsh -l` spends its profile before it reads anything the session wrote —
 * 477-528 ms idle on this machine, over 2 s with the rest of the suite running
 * alongside — so at 500 ms the command has often not started yet, and an
 * interrupt correctly answering "nothing stopped" reads as a regression.
 */
const running = (pid, pattern) =>
  until(() => descendants(pid).some((row) => pattern.test(row.command)), 15_000, 'the command to start')

test('an interrupt reaches a grandchild, not only the direct child', async () => {
  await session(async ({ sessions, id, pid }) => {
    // The npm-run-dev and make shape: the shell's child is a shell of its own,
    // and the process doing the work is one level further down. pkill -P
    // signalled the middle one and left the pair running.
    const started = sessions.run(id, 'sh -c "sleep 4003 ; echo NEVER_REACHED"')
    await running(pid, /sleep 4003/)

    const outcome = await deadline(sessions.interrupt(id), 10_000, 'the interrupt')
    assert.deepEqual(outcome, { interrupted: true })

    // The whole subtree is gone, checked against the process table rather than
    // against the registry's opinion of it.
    await until(() => descendants(pid).length === 0, 8_000, 'the command tree to die')

    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 10_000 }), 15_000, 'the run')
    assert.notEqual(result.exitCode, 0, 'an interrupted command must not report success')
    assert.equal(sessions.get(id).running, true, 'the shell has to survive its own interrupt')
  })
})

test('an interrupt abandons the rest of the command line', async () => {
  await session(async ({ sessions, id, pid, seen }) => {
    // make clean; make install. Interrupting the first must not start the
    // second. 0.1.22 printed AFTER_SLEEP and reported exitCode 0, because the
    // status it reported belonged to the echo.
    const started = sessions.run(id, 'sleep 300 ; echo AFTER_SLEEP')
    await running(pid, /sleep 300/)
    assert.deepEqual(await deadline(sessions.interrupt(id), 10_000, 'the interrupt'), { interrupted: true })

    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 10_000 }), 15_000, 'the run')
    await pause(400)
    assert.doesNotMatch(transcript(seen), /AFTER_SLEEP/, 'the second command ran anyway')
    assert.equal(result.exitCode, 130, 'an abandoned command line must not report the last command\'s status')

    const next = sessions.run(id, 'echo recovered')
    assert.match((await deadline(sessions.waitForRun(id, next.runId, { timeoutMs: 10_000 }), 15_000, 'the next command')).output,
      /recovered/)
  })
})

test('interrupted means the command stopped', async () => {
  await session(async ({ sessions, id, pid }) => {
    // Nothing is running, so nothing was interrupted. Signalling regardless is
    // also a live hazard: an interrupt landing on an idle zsh with the wrong
    // trap armed exits it 130.
    const idle = await sessions.interrupt(id)
    assert.equal(idle.interrupted, false)

    // A command that ignores SIGINT does not stop, and the answer says so
    // rather than reporting a delivery that changed nothing.
    // Five seconds, not three: the answer is only meaningful if the command
    // outlives the settle window, or "did not stop" would just mean "finished".
    const stubborn = sessions.run(id, 'sh -c \'trap "" INT ; sleep 5\'')
    await running(pid, /sleep 5/)
    const ignored = await deadline(sessions.interrupt(id), 10_000, 'the interrupt')
    assert.equal(ignored.interrupted, false)
    // The two false answers are opposite situations for whoever pressed the
    // key, and the pane says which. A single boolean reported the idle case
    // whenever a command had ignored the signal and was still running.
    assert.notEqual(ignored.reason, idle.reason)
    assert.match(ignored.reason, /still running/)
    assert.equal(sessions.get(id).pendingRunId, stubborn.runId, 'the command really is still running')

    await deadline(sessions.waitForRun(id, stubborn.runId, { timeoutMs: 15_000 }), 20_000, 'the stubborn command')
    assert.equal(sessions.get(id).running, true)
  })
})

test('the shell stays interruptible after an interrupt', async () => {
  // The trap that unwinds the command has to be put back, or the second
  // interrupt finds 'return 130' at top level — an error everywhere and, on
  // zsh, exit 130.
  await session(async ({ sessions, id, pid }) => {
    for (const attempt of [1, 2, 3]) {
      const started = sessions.run(id, 'sleep 60 ; echo NEVER_' + attempt)
      await running(pid, /sleep 60/)
      assert.deepEqual(await deadline(sessions.interrupt(id), 10_000, 'interrupt ' + attempt), { interrupted: true })
      const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 10_000 }), 15_000, 'run ' + attempt)
      assert.equal(result.exitCode, 130, 'attempt ' + attempt)
    }
    assert.equal(sessions.get(id).running, true)
  }, '/bin/zsh')
})
