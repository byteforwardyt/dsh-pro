/**
 * How a submitted command reaches the shell.
 *
 * The shell reads its script from the same pipe it hands every command as
 * stdin, so anything the harness has written but the shell has not yet parsed
 * is readable by the running program. Every assertion here is about that one
 * fact, and each of them was a live defect in 0.1.22.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
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
    try {
      await body({ sessions, id: opened.id, root, seen })
    } finally { detach() }
  } finally {
    restore()
    await sessions.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

const transcript = (seen) => seen.filter((event) => event.kind === 'chunk').map((event) => event.text).join('')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a command that reads stdin sees what the user typed and nothing of the protocol', async () => {
  await session(async ({ sessions, id, root, seen }) => {
    const captured = join(root, 'captured.txt')
    const started = sessions.run(id, 'head -n 1 > ' + captured)

    // Half a second is long enough for the marker to have been eaten if it
    // were in the pipe: 0.1.22 answered here with the printf line already
    // consumed and the run permanently pending.
    await pause(500)
    assert.equal(sessions.get(id).pendingRunId, started.runId, 'the command should still be waiting for input')
    assert.equal(seen.some((event) => event.kind === 'done'), false, 'nothing finished this command')

    sessions.write(id, 'typed-by-the-user\n')
    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 15_000 }), 20_000, 'the command')
    assert.equal(result.exitCode, 0)

    // What the program read is exactly what the user typed. In 0.1.22 this
    // file held the completion printf, secret and all.
    assert.equal(readFileSync(captured, 'utf8'), 'typed-by-the-user\n')

    // And the protocol never appeared on screen either.
    assert.doesNotMatch(transcript(seen), /\u001e/)
    assert.doesNotMatch(transcript(seen), /printf/)

    // The session recovered. A run that never completes leaves every later
    // command refused as "already running", which only /close cleared.
    assert.equal(sessions.get(id).pendingRunId, null)
    const next = sessions.run(id, 'echo still-usable')
    assert.match((await deadline(sessions.waitForRun(id, next.runId, { timeoutMs: 15_000 }), 20_000, 'the next command')).output,
      /still-usable/)
  })
})

test('a program cannot report a completion for a command that is still running', async () => {
  await session(async ({ sessions, id, seen }) => {
    // The audited exploit, unchanged: read the protocol off stdin and run it.
    // No secret is guessed — whatever the harness wrote is executed verbatim,
    // so it emits a genuine record for a command that has not finished. On
    // 0.1.22 this answered {"kind":"done","exitCode":0} immediately and the
    // late output landed against whatever ran next.
    const started = sessions.run(id, 'CAPTURED=$(head -n 1) ; eval "$CAPTURED" ; sleep 2 ; echo LATE_OUTPUT')

    await pause(900)
    assert.equal(seen.some((event) => event.kind === 'done'), false,
      'a completion was reported while the command was still running')
    assert.equal(status(() => sessions.run(id, 'echo interloper')), 409,
      'the session accepted a second command on the strength of a forged completion')

    // Nothing was there to steal, so the command is still waiting on stdin.
    sessions.write(id, 'true\n')
    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 15_000 }), 20_000, 'the command')
    assert.equal(result.exitCode, 0)
    // The tell the audit caught: output that arrives after the reported
    // completion. It belongs to this run and it has to be inside this result.
    assert.match(result.output, /LATE_OUTPUT/)
  })
})

test('a record the program invents for itself is only output', async () => {
  await session(async ({ sessions, id, seen }) => {
    // Right shape, guessed secret. It has to read as text, not as a completion.
    const started = sessions.run(id,
      'printf \'\\036%s %s %s\\036\\n\' dshfeedfacefeedfaceff 1 0 ; sleep 1 ; echo REALLY-DONE')
    await pause(600)
    assert.equal(seen.some((event) => event.kind === 'done'), false)
    const result = await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 15_000 }), 20_000, 'the command')
    assert.match(result.output, /REALLY-DONE/)
    assert.match(transcript(seen), /dshfeedfacefeedfaceff/, 'the invented record is the program\'s own output')
  })
})

test('the shell holds nothing a command could read the completion out of', async () => {
  // Every shell, because what a command can see differs between them: bash
  // prints function bodies from `set`, zsh does not, and a subshell inherits
  // functions in both.
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    await session(async ({ sessions, id, root }) => {
      const dump = join(root, 'dump.txt')
      // Everything a command can reach without debugging the parent: the
      // environment it inherits, every shell variable, every function body,
      // and the positional parameters. That last one is not decoration — the
      // start record used to be handed to __dsh_run as $2, and `set --` was
      // the whole reason it stayed unreadable. That defence held and was still
      // beside the point: the audit took the record from a redefined `printf`
      // instead. There is now no secret here to read, which is why the check
      // is for the record's construct rather than for a value.
      const started = sessions.run(id,
        '{ env ; set ; typeset -f 2>/dev/null || true ; echo "argv [$#] [$@] [$1] [$2]" ; } > ' + dump + ' 2>&1')
      await deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 15_000 }), 20_000, 'the dump')
      const text = readFileSync(dump, 'utf8')
      assert.doesNotMatch(text, /\u001e/, shell + ' left a record separator where a command could read it')
      assert.doesNotMatch(text, /dsh[0-9a-f]{18}/, shell + ': the per-session marker is reachable from inside the shell')
      assert.doesNotMatch(text, /@dsh@/, shell + ': the completion record is reachable from inside the shell')
      assert.doesNotMatch(text, /dsh-terminal-control-/, shell + ': the control channel path is reachable from inside the shell')
    }, shell)
  }
})

test('an unbalanced quote is contained instead of swallowing the marker', async () => {
  await session(async ({ sessions, id }) => {
    // Pasted raw, this consumed the completion printf as string content: the
    // run never finished and the shell went looking for a closing quote.
    const broken = sessions.run(id, 'echo \'oops')
    const first = await deadline(sessions.waitForRun(id, broken.runId, { timeoutMs: 15_000 }), 20_000, 'the broken command')
    assert.notEqual(first.exitCode, 0)
    assert.equal(first.exited, undefined, 'a syntax error must not take the shell down')

    // Same for a command that opens a here-document the shell would otherwise
    // fill from the protocol stream.
    const heredoc = sessions.run(id, 'cat <<END_OF_NOTHING')
    await deadline(sessions.waitForRun(id, heredoc.runId, { timeoutMs: 15_000 }), 20_000, 'the here-document')

    const after = sessions.run(id, 'echo recovered')
    assert.match((await deadline(sessions.waitForRun(id, after.runId, { timeoutMs: 15_000 }), 20_000, 'the recovery')).output,
      /recovered/)
    assert.equal(sessions.get(id).running, true)
  })
})

test('a command ending in a backslash does not desynchronise the parser', async () => {
  // bash 3.2 is /bin/sh and /bin/bash on macOS. A dangling line continuation
  // left eval waiting for input, and the NEXT submission died as
  // "syntax error near unexpected token `}'" — taking the shell with it.
  await session(async ({ sessions, id }) => {
    const dangling = sessions.run(id, 'echo first \\')
    assert.equal((await deadline(sessions.waitForRun(id, dangling.runId, { timeoutMs: 15_000 }), 20_000, 'the continuation')).exitCode, 0)
    const after = sessions.run(id, 'echo second')
    const result = await deadline(sessions.waitForRun(id, after.runId, { timeoutMs: 15_000 }), 20_000, 'the next command')
    assert.equal(result.exitCode, 0)
    assert.match(result.output, /second/)
    assert.equal(sessions.get(id).running, true, 'the shell died on the command after the backslash')
  }, '/bin/bash')
})

test('wrapping a command does not cost it its session', async () => {
  // The command is handed over as a quoted word now, so the things that make a
  // session a session have to be re-checked: state persists, control flow
  // still parses, and a status still belongs to the command that produced it.
  await session(async ({ sessions, id, root }) => {
    const run = async (command) => {
      const started = sessions.run(id, command)
      return deadline(sessions.waitForRun(id, started.runId, { timeoutMs: 15_000 }), 20_000, command)
    }
    await run('cd ' + root)
    assert.match((await run('pwd')).output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    await run('DSH_KEPT=persisted')
    assert.match((await run('echo recall-$DSH_KEPT')).output, /recall-persisted/)
    assert.equal((await run('sh -c "exit 7"')).exitCode, 7)
    assert.match((await run('for i in 1 2 3\ndo echo loop-$i\ndone')).output, /loop-1[\s\S]*loop-3/)
    assert.match((await run('echo "it\'s quoted"')).output, /it's quoted/)
  })
})
