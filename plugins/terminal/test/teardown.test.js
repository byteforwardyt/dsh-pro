/**
 * What a closed session takes with it.
 *
 * The claim under test is the one the plugin makes out loud: close a session
 * and the dev server started inside it dies too. 0.1.22 made that claim while
 * signalling only the shell's process group, so a child that had left the
 * group outlived the app — verified with ps, reparented to init and still
 * running 5.5 s after close.
 *
 * 1d79ba8 answered that by recording, before terminating, which descendants
 * were ALREADY outside the group. A child that leaves while it is being
 * terminated is outside both paths, and measured against 1d79ba8 it survived
 * every close: dispose() returned success at 341 ms and the child was still
 * running when the test gave up 15 s later. So there is a case here for each
 * moment a child can leave — before the close, and during it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createSessions } from '../lib/sessions.js'
import { alive, descendants, fixtureContext, plainShell, processes, until, workspace } from './harness.js'

/**
 * A hang is a worse failure than a failure. On 0.1.22 the pipe-holding cases
 * below do not fail, they never return: the escaped child keeps the shell's
 * stdout open, the handle never settles, and dispose() waits forever — 2m36s
 * before the runner was killed by hand. node:test has no default per-test
 * timeout, so a regression would stall CI rather than report one. These bounds
 * exist only to turn a hang into a result. Measured runtimes are 160-440 ms,
 * except the late-detaching case at 6.25 s: that child ignores both SIGTERMs,
 * so it waits out two polled grace windows before anything can kill it.
 */
const bounded = { timeout: 30_000 }

/**
 * A background child that leaves the shell's process group on purpose.
 *
 * macOS ships no setsid(1), so POSIX::setsid through the perl every macOS does
 * ship stands in for it, and the real binary is used where there is one. What
 * matters is only that the child ends up in a process group of its own, which
 * is exactly what a group signal can no longer reach.
 */
const escaping = (tag) => (existsSync('/usr/bin/setsid')
  ? 'setsid sleep ' + tag + ' &'
  : "perl -e 'use POSIX qw(setsid) ; setsid() ; sleep " + tag + "' &")

/**
 * A classic double-fork daemon, which is the shape close() documents as
 * unreachable: it is reparented to init before any scan could see it. It keeps
 * the shell's stdout, exactly as a program that forgets to redirect would.
 */
const daemonizing = (tag) =>
  "perl -e 'exit if fork ; use POSIX qw(setsid) ; setsid() ; exit if fork ; sleep " + tag + "' &"

/**
 * A child that is INSIDE the shell's process group when the teardown scan runs
 * and leaves it on the way out.
 *
 * It does not die on SIGTERM, it calls setsid() while handling it, which is
 * what a dev server that re-execs or daemonises during shutdown looks like from
 * outside. perl unconditionally here, with no setsid(1) branch: the binary
 * detaches at startup and cannot be made to detach on a signal, and the delay
 * is the whole point of the case.
 *
 * It writes `ready` once the trap is armed, because a child that has been
 * exec'd but has not reached that line yet dies on the group's SIGTERM like any
 * other process and would make this test pass for the wrong reason.
 */
const detachingOnTerm = (tag, ready) =>
  "perl -e 'use POSIX qw(setsid) ; $SIG{TERM} = sub { setsid() } ; "
  + "open my $handle, \">\", $ARGV[0] ; close $handle ; sleep 1 for 1.." + tag + "' '" + ready + "' &"

/** A live session, plus a place to record a pid the test must not leak. */
async function session (body) {
  const root = workspace()
  const sessions = createSessions(fixtureContext([root]), { reapIntervalMs: 3_600_000 })
  const restore = plainShell('/bin/sh')
  const started = []
  try {
    const opened = await sessions.open({ cwd: root })
    await body({ sessions, id: opened.id, pid: opened.pid, started, root })
  } finally {
    // Only ever pids this test itself started, and only when an assertion
    // failed on the way past. A leaked sleep outlives the whole suite.
    for (const pid of started) {
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* raced us */ } }
    }
    restore()
    await sessions.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Wait until the child is real AND has its own process group. */
async function escaped (shellPid, tag, started) {
  const row = await until(
    () => descendants(shellPid).find((child) => new RegExp(tag).test(child.command) && child.pgid !== shellPid),
    15_000,
    'the child to leave the shell\'s process group',
  )
  started.push(row.pid)
  return row.pid
}

test('a child that left the process group does not survive close', bounded, async () => {
  await session(async ({ sessions, id, pid, started }) => {
    sessions.run(id, escaping(4007))
    const child = await escaped(pid, '4007', started)

    sessions.close(id)
    await until(() => !alive(pid), 10_000, 'the shell to exit')
    // The whole defect in one assertion: on 0.1.22 this child is still running
    // here, because the only signal sent went to a group it had left.
    await until(() => !alive(child), 10_000, 'the escaped child to be reaped')
  })
})

test('a child that leaves the process group during the teardown does not survive close', bounded, async () => {
  // The case above has already left the group when close is called, so the
  // first scan sees it. This one is still in the group while that scan runs
  // and leaves on the way out, so the scan files it as an ordinary member and
  // the group SIGKILL that follows cannot reach it any more. Against 1d79ba8
  // it never dies; the fix decides who got away by reading the table a second
  // time, after the shell is dead, rather than trusting the first reading.
  await session(async ({ sessions, id, pid, started, root }) => {
    const ready = join(root, 'armed')
    sessions.run(id, detachingOnTerm(4013, ready))
    await until(() => existsSync(ready), 15_000, 'the child to arm its SIGTERM handler')
    const row = await until(
      () => descendants(pid).find((child) => /4013/.test(child.command) && child.pgid === pid),
      15_000,
      'the child to appear inside the shell\'s process group',
    )
    started.push(row.pid)

    sessions.close(id)
    await until(() => !alive(pid), 10_000, 'the shell to exit')
    // This child ignores both SIGTERMs, so it pays the whole bound: two polled
    // grace windows and two scans, measured at 6.09 s from the terminate and
    // 6.25 s for the test. The allowance is headroom, not a stopwatch.
    await until(() => !alive(row.pid), 15_000, 'the late-detaching child to be reaped')
  })
})

test('an ordinary background job is still reaped by close', bounded, async () => {
  // The sweep must not become the only thing that works. nohup + & is the
  // common shape, it stays in the process group, and the group signal is what
  // catches it — this fails if the escape handling ever displaces that.
  await session(async ({ sessions, id, pid, started }) => {
    sessions.run(id, 'nohup sleep 4008 > /dev/null 2>&1 &')
    const row = await until(
      () => descendants(pid).find((child) => /4008/.test(child.command)),
      15_000,
      'the background job to start',
    )
    started.push(row.pid)

    sessions.close(id)
    await until(() => !alive(row.pid), 10_000, 'the background job to be reaped')
  })
})

test('unloading the plugin waits for the children it is still killing', bounded, async () => {
  // ctx.on('dispose') hands the app dispose() and does not await it, so
  // dispose() has to be the thing that reaches quiescence. Returning while a
  // sweep is still in flight would orphan the child at exactly the moment
  // nothing is left to finish the job.
  const root = workspace()
  const sessions = createSessions(fixtureContext([root]), { reapIntervalMs: 3_600_000 })
  const restore = plainShell('/bin/sh')
  const started = []
  try {
    const opened = await sessions.open({ cwd: root })
    sessions.run(opened.id, escaping(4009))
    const child = await escaped(opened.pid, '4009', started)

    await sessions.dispose()
    // Bounded, not instant: the child is a zombie until its new parent reaps
    // it, and that is the kernel's schedule rather than ours. Measured under 30
    // ms; the allowance is wide enough not to be a stopwatch.
    await until(() => !alive(child), 2_000, 'the escaped child to be gone once dispose returned')
  } finally {
    for (const pid of started) {
      if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* raced us */ } }
    }
    restore()
    await sessions.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a child the sweep cannot reach does not wedge the teardown', bounded, async () => {
  // The honest half of the same defect. This child cannot be killed — that is
  // stated in close() and it is not what is under test. What is under test is
  // that failing to kill it does not also mean failing to FINISH: setsid()
  // leaves file descriptors alone, so the daemon still holds the shell's
  // stdout, and a handle settles only on exit AND stdio EOF. On 0.1.22 the
  // shell died, the handle never settled, and dispose() never returned.
  const root = workspace()
  const sessions = createSessions(fixtureContext([root]), { reapIntervalMs: 3_600_000 })
  const restore = plainShell('/bin/sh')
  let orphan = null
  try {
    const opened = await sessions.open({ cwd: root })
    sessions.run(opened.id, daemonizing(4011))
    // Waiting for the reparent is what keeps this test honest: until ppid is 1
    // the child is still reachable by the parent-link walk, and this would be
    // quietly re-testing the case above.
    const row = await until(
      () => processes().find((child) => /4011/.test(child.command) && child.ppid === 1),
      15_000,
      'the daemon to reparent to init',
    )
    orphan = row.pid

    await sessions.dispose()
    assert.equal(alive(opened.pid), false, 'dispose returned with the shell still running')
    assert.equal(sessions.get(opened.id), null, 'dispose returned but left the session in the registry')
  } finally {
    if (orphan !== null && alive(orphan)) { try { process.kill(orphan, 'SIGKILL') } catch { /* raced us */ } }
    restore()
    await sessions.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
