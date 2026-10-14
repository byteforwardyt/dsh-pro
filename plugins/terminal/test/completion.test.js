/**
 * Who is allowed to say that a command finished.
 *
 * Shell state persists across runs — that is what makes a session a session —
 * so anything an earlier command defined is still there when the next one is
 * submitted. Every test in this file is one door that led to the same place: a
 * `done` published for a command that was still running, which tool.js turns
 * into `ok` with an exit status attached. All of them were reproduced against
 * 0.1.23 (1d79ba8) before they were fixed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessions } from '../lib/sessions.js'
import { deadline, fixtureContext, plainShell, status, workspace } from './harness.js'

/** A session in a throwaway workspace, with the teardown these tests all need. */
async function session (body, shell = '/bin/sh') {
  const root = workspace()
  const sessions = createSessions(fixtureContext([root]), { reapIntervalMs: 3_600_000 })
  const restore = plainShell(shell)
  const seen = []
  try {
    const opened = await sessions.open({ cwd: root })
    const detach = sessions.subscribe(opened.id, null, (event) => seen.push(event))
    const run = async (command, timeoutMs = 30_000) => {
      const started = sessions.run(opened.id, command)
      return deadline(sessions.waitForRun(opened.id, started.runId, { timeoutMs }), timeoutMs + 5_000, command)
    }
    try {
      await body({ sessions, id: opened.id, root, seen, run })
    } finally { detach() }
  } finally {
    restore()
    await sessions.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

const transcript = (seen) => seen.filter((event) => event.kind === 'chunk').map((event) => event.text).join('')
const doneFor = (seen, runId) => seen.filter((event) => event.kind === 'done' && event.runId === runId)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const size = (path) => { try { return statSync(path).size } catch { return 0 } }

test('a command that redefines printf is handed nothing to replay', async () => {
  // The audited exploit, run as the auditor ran it. On 1d79ba8 the completion
  // signal was `printf '\036%s %s %s\036\n' <secret> <runId> <status>`, and
  // printf is an ordinary command name, so this function received the session
  // secret as $2 and cap.bin came back 28 bytes long. Run 2 rewrote the run id
  // with sed, cat'ed it back, and the registry published a done for a command
  // that still had six seconds to run.
  await session(async ({ sessions, id, root, seen, run }) => {
    const cap = join(root, 'cap.bin')
    const forge = join(root, 'forge.bin')

    const armed = await run('printf () { command printf "$@" >> ' + cap
      + ' ; command printf "$@" ; } ; echo ARMED')
    assert.equal(armed.exitCode, 0)
    // Without this the test could pass because the shadow never installed,
    // which is a different thing from the shadow never being called.
    assert.match(armed.output, /ARMED/, 'the shadow was never installed, so this proves nothing')

    // The assertion that matters. No part of the completion path is a command
    // word any more, so the shadow is never reached and captures nothing.
    assert.equal(size(cap), 0,
      'the completion signal was handed to a command name the session redefined')

    const started = sessions.run(id, "sed 's/ 1 0/ 2 0/' " + cap + ' > ' + forge
      + ' ; cat ' + forge + ' ; sleep 6 ; echo LATE_OUTPUT_FORGED')

    // Well inside the sleep. On 1d79ba8 both dones were on the wire by now, the
    // real one for run 1 and the forged one for run 2.
    await pause(2000)
    assert.deepEqual(doneFor(seen, started.runId), [],
      'a completion was published for a command that is still running')
    assert.equal(status(() => sessions.run(id, 'echo interloper')), 409,
      'a second command was accepted onto the pipe on the strength of a forgery')

    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 30_000 }), 35_000, 'the sleep')
    // The tell the audit used: output arriving after the reported completion.
    // It belongs to this run, so it has to be inside this run's result.
    assert.match(result.output, /LATE_OUTPUT_FORGED/)
    assert.equal(result.exitCode, 0)
  })
})

test('a command that redefines the run wrapper is handed nothing to replay', async () => {
  // The second, independent vector. On 1d79ba8 the submission called
  // `__dsh_run '<command>' '<start record>'`, so a faithful reimplementation
  // kept the session behaving normally while taking the marker out of $2.
  // Reimplemented faithfully here for that reason: a hijack that broke the
  // session would be caught by the session breaking, which is not the defect.
  await session(async ({ sessions, id, root, seen, run }) => {
    const cap = join(root, 'wrapper.bin')
    const forge = join(root, 'wrapper-forged.bin')
    const hijack = "__dsh_run () { trap 'return 130' INT ; "
      + 'command printf ' + JSON.stringify('%s\n') + ' "$2" >> ' + cap + ' ; '
      + 'command printf ' + JSON.stringify('%s\n') + ' "$2" ; '
      + '__c=$1 ; set -- ; eval "$__c" ; } ; echo WRAPPED'

    const armed = await run(hijack)
    assert.equal(armed.exitCode, 0)
    assert.match(armed.output, /WRAPPED/, 'the hijack was never installed, so this proves nothing')

    // A second run, because the definition installed during run 1 is the one
    // run 2 would call. Nothing reaches it: every submission redefines the
    // wrapper, and the call sits inside the scope where fd 3 is closed, so even
    // a definition we failed to replace has no channel to write on.
    const second = await run('echo still-ours')
    assert.equal(second.exitCode, 0)
    assert.match(second.output, /still-ours/)
    assert.equal(size(cap), 0, 'the start record was handed to a function the session redefined')

    const started = sessions.run(id, "sed 's/ [0-9][0-9]* run/ 4 0/' " + cap + ' > ' + forge
      + ' ; cat ' + forge + ' ; sleep 6 ; echo LATE_AFTER_WRAPPER')
    await pause(2000)
    assert.deepEqual(doneFor(seen, started.runId), [],
      'the redefined wrapper produced a completion for a command still running')

    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 30_000 }), 35_000, 'the sleep')
    assert.match(result.output, /LATE_AFTER_WRAPPER/)
  })
})

test('a command that redirects stdout onto stderr still completes, and discloses nothing', async (t) => {
  // Blocker 2, on every shell, because `exec` is a builtin and the three differ
  // in how they treat an already-redirected stdout.
  //
  // On 1d79ba8 the completion printf followed stdout wherever the command sent
  // it and the scanner only ever read stdout. So this published the session
  // secret into the transcript in plaintext, never completed the run, refused
  // every later command with 409, and answered /signal with "the command
  // ignored the interrupt" for a command that had finished seconds earlier.
  // Only /close recovered, at the cost of the shell's whole state.
  //
  // A subtest per shell rather than a loop. Against 1d79ba8 the /bin/sh case
  // fails on a 15 s timeout, and in a loop that throw ends the test before
  // bash and zsh are ever tried — so the evidence for two of the three shells
  // simply did not exist. Each one now reports on its own.
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    await t.test(shell, async () => {
      await session(async ({ sessions, id, seen, run }) => {
        const result = await run('exec 1>&2 ; echo REDIRECTED', 15_000)
        const text = transcript(seen)

        // Disclosure first, deliberately. Both halves of this defect happen at
        // once on 1d79ba8, and whichever assertion fires first is the one that
        // names it: "the run never completed" is the symptom the user saw,
        // while this is what was published to every reader of the transcript
        // while they waited. Measured there, the transcript reads
        // 'REDIRECTED\n\x1e<secret> 1 0\x1e\n'.
        assert.doesNotMatch(text, /dsh[0-9a-f]{18}/, shell + ': a per-session secret reached the transcript')
        assert.doesNotMatch(text, /@dsh@/, shell + ': the completion record reached the transcript')
        assert.doesNotMatch(text, /\u001e/, shell + ': a record separator reached the transcript')
        assert.match(text, /REDIRECTED/, shell + ': the output went missing')

        // Then the wedge, which is what the user actually felt: no completion,
        // and every later command refused with 409 until the session was closed.
        assert.equal(result.timedOut, false, shell + ': the run never completed')
        assert.equal(result.exitCode, 0, shell + ': wrong status')
        assert.equal(sessions.get(id).pendingRunId, null, shell + ': the session is still pending')
        const after = await run('echo recovered', 15_000)
        assert.equal(after.exitCode, 0)
        assert.match(transcript(seen), /recovered/, shell + ': the session never took another command')
      }, shell)
    })
  }
})

test('a record a trap writes from inside the shell does not finish a running command', async () => {
  // The hole a dedicated descriptor opens, and the reason a record alone is
  // never enough. A DEBUG trap runs in the SHELL rather than in the command, so
  // it executes at moments when fd 3 is open, and the record construct is in
  // this repository — there is no secret left in it to fail to guess.
  //
  // What stops it is that a done also needs a sync probe to come back, and the
  // shell only reads its next line at top level. While a command runs the shell
  // is inside wait(), so the probe sits in the pipe for the COMMAND to read.
  // The forged record is therefore taken as a claim and never confirmed.
  //
  // `trap` is shadowed on purpose, and the test is worth nothing without it.
  // Every submission disarms DEBUG on the way in and on the way out, so an
  // ordinary armed trap is gone before the next run and this passes whatever
  // the completion path does. Measured: with the sync probe deleted and no
  // shadow, this test still passed; with the shadow, the same build published
  // {"kind":"done","runId":"2","exitCode":0} 2.5 s into a six-second sleep and
  // left pendingRunId null. The shadow is what reaches the defence under test.
  await session(async ({ sessions, id, seen, run }) => {
    const record = "( 9< '/dev/null/@dsh@ 2 0 @dsh@' < /dev/null ) 2>&3 || __dsh_ok=1"
    // Armed with the real builtin first, then the builtin is taken away, so
    // the submission's own `trap - DEBUG` on the way out cannot undo it.
    const armed = await run('trap ' + JSON.stringify(record) + ' DEBUG ; trap () { : ; } ; echo TRAP_ARMED')
    assert.match(armed.output, /TRAP_ARMED/, 'the trap was never armed, so this proves nothing')

    const started = sessions.run(id, 'sleep 6 ; echo LATE_AFTER_TRAP')
    await pause(2500)
    assert.deepEqual(doneFor(seen, started.runId), [],
      'a forged record finished a command that was still running')
    assert.equal(sessions.get(id).pendingRunId, started.runId,
      'the session stopped considering a still-running command pending')

    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 30_000 }), 35_000, 'the sleep')
    assert.match(result.output, /LATE_AFTER_TRAP/,
      'the output arrived after the run had already been reported finished')
  }, '/bin/bash')
})

test('the completion channel has no name and no descriptor a command can reach', async () => {
  // The invariant behind the four tests above, asserted directly instead of
  // through an exploit: nothing left to steal, and nowhere to write.
  //
  // Unlike the rest of this file, this one is NOT regression evidence and is
  // not claimed as any. Run against 1d79ba8 it passes, and passes vacuously:
  // `@dsh@`, the control path and a raw \u001e are all constructs this rewrite
  // introduced, so every doesNotMatch below is trivially true there, and the
  // EBADF assertion is satisfied by fd 3 not existing at all rather than by it
  // being closed to the command. It is here to fail if a later change hands
  // any of this back to the session, which is the direction the last three
  // audits all came from.
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    await session(async ({ root, run }) => {
      const dump = join(root, 'reach.txt')
      // Everything a command can read without debugging its parent, plus an
      // explicit attempt to write on the descriptor itself.
      await run('{ env ; set ; typeset -f 2>/dev/null || true ; echo "argv [$#] [$@] [$1] [$2]" ; '
        + 'echo LEAKED_TO_FD3 >&3 ; } > ' + dump + ' 2>&1', 20_000)
      const text = readFileSync(dump, 'utf8')

      // The record's own sentinel. On 1d79ba8 the equivalent was the session
      // secret, which sat in a positional parameter until set -- cleared it.
      assert.doesNotMatch(text, /@dsh@/, shell + ': the record is readable from inside the shell')
      assert.doesNotMatch(text, /dsh-terminal-control-/, shell + ': the channel path is readable from inside the shell')
      assert.doesNotMatch(text, /\u001e/, shell + ': a record separator is readable from inside the shell')

      // The write has to have failed. Several spellings, because the three
      // shells word EBADF differently.
      assert.match(text, /[Bb]ad file descriptor|not open/,
        shell + ': a command could write on the completion descriptor')
      // No assertion on the sentinel itself: `set` prints __dsh_command, so
      // the command's own text is in this dump whether the write worked or
      // not. The EBADF line is the proof, and it is the shell's, not ours.
    }, shell)

    // And the file behind it is unlinked once the shell holds the descriptor,
    // so there is no path left to discover, open or truncate. Its own prefix,
    // so this cannot trip over the fixtures' throwaway workspaces.
    const leftovers = readdirSync(tmpdir()).filter((name) => name.startsWith('dsh-terminal-control-'))
    assert.deepEqual(leftovers, [], shell + ': the control channel outlived its session on disk')
  }
})
