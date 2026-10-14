/**
 * The session registry: one long-lived shell per session, piped, bounded, and
 * fenced to a directory the user actually opened.
 *
 * A terminal is the most dangerous surface this app has. Everything else in
 * the desktop layer reads or writes files through a seam that can refuse; a
 * shell runs arbitrary programs with the user's own credentials. So the fences
 * are the design, not a wrapper around it:
 *
 *   - `containedPath` decides the cwd. A session may only start inside a
 *     workspace root, and the check is realpath-based, so a symlink pointing
 *     out of the workspace does not smuggle one past it.
 *   - argv is always an ARRAY (see shell.js). No path, flag or command is ever
 *     concatenated into a string a shell would parse.
 *   - the spawn goes through ctx.subprocess, which scrubs credential-shaped
 *     environment entries and owns process-group termination. Closing a
 *     session kills its descendants rather than orphaning a dev server: the
 *     ordinary ones through the group, and the ones that left it by reading
 *     the process table twice — once while the shell is alive and its parent
 *     links still exist, once after it is dead — and signalling whatever is
 *     still there under the same command. That covers a child that detached
 *     before the close, during the scan, and while handling the group's
 *     SIGTERM; the last of those outlived 1d79ba8 indefinitely, measured.
 *     The double-fork daemon is still out of reach, and close() says so
 *     instead of claiming the tree.
 *
 * Two problems come free with a real terminal and have to be solved here.
 *
 * MEMORY. A `yarn build` can print tens of megabytes. Output is therefore
 * kept in a ring bounded by total BYTES, dropping whole events from the front,
 * so a session's retained transcript has a hard ceiling no matter how long it
 * runs or how noisy the command is.
 *
* COMPLETION. A piped shell gives no signal that a command finished — there is
 * no prompt to wait for, so the session has to manufacture one. Every earlier
 * attempt manufactured it out of something a command could talk the shell into
 * lying about, and each was broken by an audit against the running build:
 *
 *   - a printf of a per-session secret into STDOUT. A command that read stdin
 *     ate it — `head -n 1` printed the marker line, secret and all, into the
 *     transcript — and `exec 1>&2` published it verbatim and then wedged the
 *     session forever, because the scanner only ever looked at stdout;
 *   - the same printf moved into one compound submission, which did keep it
 *     out of the pipe. But `printf` is an ordinary command name: a `printf ()
 *     { … }` left behind by an earlier run received the marker as $2 and
 *     replayed it for a command still in flight. So did a redefinition of the
 *     helper function the submission called. A longer secret buys nothing —
 *     the marker was being HANDED to a name the shell resolves.
 *
 * Absolute paths do not rescue that. Measured here: a function named
 * `/usr/bin/printf` intercepts `/usr/bin/printf` on bash 3.2 and zsh 5.9, and
 * a function outranks `unset`, `command` and `builtin` on both. On those two
 * shells there is no command word a session cannot take away from us.
 *
 * So the completion signal is no longer a command and carries no secret.
 *
 * A DEDICATED DESCRIPTOR. fd 3 is opened once, before the caller can submit
 * anything, onto a file this registry holds open and then UNLINKS. It has no
 * name left in the filesystem, so no path a command discovers reaches it, and
 * every submission runs its command inside `{ … } 3>&-`, so the command has no
 * descriptor 3 either. Measured on all three shells: `echo x >&3` inside a
 * command is EBADF, and the shell's own fd 3 is intact for the next record
 * even after the command did `exec 3>somewhere` of its own.
 *
 * NO COMMAND WORD. The record is a REDIRECTION FAILURE, which the shell
 * reports itself: `( 9< '/dev/null/…record…' < /dev/null ) 2>&3`. Opening
 * anything beneath /dev/null is ENOTDIR unconditionally — it is a character
 * device and no session can make it a directory — so the shell prints the
 * path, which is the record, onto a stderr that is fd 3. Nothing is looked up,
 * so nothing can be shadowed: measured against functions named printf, echo,
 * :, exec, eval, unset, command, builtin, trap, cat, true and the exact path
 * string itself, on all three shells, none of them altered the record.
 *
 * Every piece of that line is load-bearing. zsh routes a redirection
 * diagnostic to the stderr the failing command STARTED with, so a flat `2>&3`
 * never applied and the record went to the transcript instead; the subshell
 * commits the redirection first, which fixes zsh and costs the other two
 * nothing. `( … )` is also the only grouping that is not a reserved word —
 * `alias case=…` or `alias '{'=…` turns a reserved-word form into a syntax
 * error that kills bash outright, and an alias cannot name an operator.
 * `< /dev/null` keeps zsh's NULLCMD from ever reading the script. `|| __dsh_ok
 * =1` is an assignment rather than `:` or `!`, because the record must not
 * fail the session under `set -e` and must not be a name either.
 *
 * The record is printable ASCII, because zsh renders a control byte inside a
 * path as a caret escape: \u001e came back as `^^` and was unparseable.
 *
 * IDLENESS IS PROVED, NOT ASSERTED. One hole survives all of that. A DEBUG or
 * ERR trap left behind by an earlier run executes in the SHELL rather than in
 * the command, so it runs at a moment when fd 3 is open and can write whatever
 * it likes there. Every submission disarms both, inside the fd-3-closed scope,
 * on the way in and on the way out — enough on its own unless the session has
 * also shadowed `trap` itself. So a `done` is never published on the strength
 * of a record alone: when one arrives, the registry writes a fresh random SYNC
 * probe to stdin and publishes only once that probe's own record comes back. A
 * record can be forged; reading the next line of the script cannot, because
 * the shell only does that at top level and it is inside wait() for the whole
 * time a command is running. A `done` therefore means the shell really is back
 * and ready, which is what the pane and the agent tool needed it to mean.
 *
 * Everything the user types through /input still reaches the running program,
 * because a submission is ONE compound command in ONE write: the shell cannot
 * execute any of it before it has parsed all of it, so the pipe is empty while
 * the command runs. Measured: `head -n 1` sees the line the user typed and no
 * part of the protocol.
 *
 * WHAT IS STILL REACHABLE, stated rather than left to the next audit.
 *
 *   - a session that shadows `trap` AND leaves a DEBUG trap armed can write to
 *     fd 3 from inside the shell. The sync probe stops that from finishing a
 *     command still in flight — measured: with the probe removed the same
 *     session published a done for run 2 two and a half seconds into a
 *     six-second sleep, and with it the run stayed pending — but the trap can
 *     still influence the status reported for its OWN command. That is worth
 *     nothing: a command can already choose its own exit status by exiting.
 *   - `alias '{'=…` makes the submission's own braces a syntax error and takes
 *     the shell with it on bash. Nothing in the record constructs is aliasable
 *     — they are operators, deliberately — but the enclosing group is, and it
 *     predates this build. It costs the session that armed it and nothing else.
 *   - fish would not understand the bootstrap at all. resolveShell only ever
 *     hands us sh, bash or zsh today; a fourth shell needs its own bootstrap
 *     rather than a hope that this one parses.
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, open as openFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { containedPath, workspaceRoots } from './roots.js'
import { resolveShell, shellEnv } from './shell.js'

/** Retained transcript per session. Older events fall off the front. */
export const MAX_SCROLLBACK_BYTES = 256 * 1024

/** One stored event never exceeds this, so the ring never trims inside one. */
const MAX_EVENT_CHARS = 16 * 1024

/** Concurrent live shells. A pane needs one; the agent reuses it. */
export const MAX_SESSIONS = 8

/** No reader and no API call for this long, and the shell is reaped. */
export const IDLE_GRACE_MS = 5 * 60_000

/** How often the reaper looks. Coarse on purpose; this is not a deadline. */
const REAP_INTERVAL_MS = 30_000

/** SIGTERM to SIGKILL window when a session is closed or the plugin unloads. */
const TERMINATE_GRACE_MS = 3000

/**
 * How long close waits for one process-table scan before terminating anyway.
 * Re-measured for this build, because the old figure here (20 ms) no longer
 * matched anything: one scan costs 35-39 ms, median 36 over 12 runs against
 * this machine's 870 rows, standalone and through processTable() alike. The
 * bound is 27x that, and exists only so a wedged `ps` cannot hold up a
 * teardown the user asked for.
 *
 * Losing that race is a silent degradation rather than a loud one: the scan
 * resolves to [] and the teardown falls back to group-only, catching every
 * ordinary descendant and none of the escapees. Left as it is because the
 * margin is 27x, not because it is a good failure mode.
 */
const PROCESS_SCAN_MS = 1000

/**
 * How long the shell's read ends are left open after its pid is gone, so a
 * last line already buffered is delivered before they are dropped. Measured:
 * an ordinary exit settles the handle in under a millisecond, so this only
 * ever runs out when something else is holding the pipe.
 */
const PIPE_SETTLE_MS = 250

/**
 * How long an interrupt waits for the command to actually stop before saying
 * it did not. Long enough for the trap to unwind, the completion record to
 * reach fd 3 and the sync probe to make the round trip through the shell's
 * stdin: measured end to end at 10-12 ms on /bin/sh, /bin/bash and /bin/zsh
 * alike, so the bound is about 170x the cost. Short enough that a program
 * which catches SIGINT and carries on is reported as still running rather
 * than waited out.
 */
const INTERRUPT_SETTLE_MS = 2000

/**
 * How long an interrupt waits for the command it is meant to stop to actually
 * start. See the START record below for why signalling before that is both
 * useless and dangerous.
 *
 * Measured on this machine, spawn to the shell executing what we wrote:
 * /bin/sh 3-6 ms, /bin/bash -l 5-6 ms, /bin/zsh -l 477-528 ms. The login
 * profile is the whole of the difference and it is user-supplied, so the bound
 * is an order of magnitude above the slowest measurement rather than a fit.
 */
const RUN_START_GRACE_MS = 5000

/** A single command line. Long enough for a real pipeline, not for a payload. */
const MAX_COMMAND_BYTES = 8 * 1024

/** One raw stdin write, for answering a prompt from a running program. */
const MAX_INPUT_BYTES = 64 * 1024

/** Live output kept for one awaited run before the middle is elided. */
const COLLECT_HEAD_CHARS = 256 * 1024
const COLLECT_TAIL_CHARS = 32 * 1024

/**
 * The completion record's sentinel, and the pattern that finds one.
 *
 * Printable ASCII on purpose: zsh renders a control byte inside a path as a
 * caret escape, so the old \u001e delimiter arrived on fd 3 as the two
 * characters `^^` and matched nothing.
 */
const SENTINEL = '@dsh@'
const RECORD_SOURCE = SENTINEL + ' (\\S+) (\\S+) ' + SENTINEL

/**
 * How often fd 3's file is read while a command is in flight, and while none
 * is. A shell's error output is unbuffered, so a record lands in the file
 * within a millisecond of the shell writing it and this interval is the whole
 * of the latency the channel adds. Idle sessions poll a quarter second apart,
 * because nothing can arrive while nothing is running.
 */
const CONTROL_POLL_BUSY_MS = 4
const CONTROL_POLL_IDLE_MS = 250

/** One read of the control file. A record is tens of bytes; this is slack. */
const CONTROL_READ_BYTES = 8 * 1024

/**
 * Unparsed control text held between reads. Only the shell's own diagnostics
 * reach fd 3, so this normally holds half a record — unless the session turned
 * on `set -x`, whose trace of the record construct goes there too.
 */
const CONTROL_TAIL_MAX = 64 * 1024

/**
 * Sync probes written for one run before the registry stops writing them.
 * Each probe costs a forger one line of their own stdin and buys them nothing,
 * so this bounds noise rather than an attack. A run that exhausts it stays
 * pending, which is the honest state: interrupt and close both still work.
 */
const MAX_SYNC_PROBES = 16

/**
 * Written once, before any command, and the reason interrupting works at all.
 *
 * A non-interactive shell with no tty has no job control, so a command's
 * processes share the shell's own process group and there is no foreground
 * group to signal on its own. Measured on macOS across zsh 5.9, bash 3.2 and
 * /bin/sh, every obvious way around that fails:
 *
 *   - signalling only the running child leaves the shell to treat the death as
 *     an ordinary exit status, so `sleep 300; echo AFTER` still printed AFTER
 *     and the marker reported 0;
 *   - `set -m` is fatal on zsh without a tty ("set: can't change option: -m",
 *     then exit 1), and on bash it only buys a job process group that still
 *     does not abandon the rest of the command list;
 *   - `trap '' INT` is inherited as SIG_IGN, which makes the child immune and
 *     wedges the session on a command that can no longer be interrupted.
 *
 * What works, identically on all three, is this: keep a CATCHING trap on the
 * shell so a group-wide SIGINT cannot kill it, and run each command under a
 * trap that returns 130. Signalling the whole group then kills the command's
 * processes — children of a caught trap inherit the DEFAULT disposition, so
 * they really do die — while the trap unwinds the shell out of the rest of the
 * command list. The command still runs in the shell itself, not a subshell,
 * which is what keeps `cd` and `export` working; a subshell aborts just as
 * well but loses every state change the session exists to hold.
 *
 * The order inside the run function is the load-bearing part. The trap is
 * armed as its very first act, before the command it wraps can run, so from
 * the moment the run starts every SIGINT reaching this group unwinds it.
 *
 * The start record is emitted just OUTSIDE that function, because fd 3 is
 * closed inside the scope the function runs in and a record cannot be written
 * without it. That leaves a window between the record and the armed trap of a
 * few shell tokens wide, during which a signal would land on the harmless
 * top-level trap and be lost. That is not the failure the start record exists
 * for: the one measured in the field was a login zsh whose profile takes half
 * a second, so an interrupt aimed at the first command arrived before the
 * shell had read the submission at all — and the record still cannot be
 * emitted until it has. An interrupt that does fall in the small window is
 * reported as still running rather than claimed, which is the honest answer.
 */

/**
 * One completion record, written with no command word anywhere in it.
 *
 * See the header for why every piece of this line is the way it is. fd 9
 * rather than a low descriptor so a session that left something on 0-2 cannot
 * collide with it; the open fails either way, which is the whole point.
 */
function literalRecord (first, second) {
  const path = '/dev/null/' + SENTINEL + ' ' + first + ' ' + second + ' ' + SENTINEL
  return '( 9< ' + singleQuoted(path) + ' < /dev/null ) 2>&3 || __dsh_ok=1'
}

/**
 * The same record, with the shell filling in the status it just captured.
 *
 * Double quotes because $__dsh_status has to expand. The run id is a decimal
 * counter this file generates, so neither half of the path is ever text a
 * session chose.
 */
function statusRecord (runId) {
  return '( 9< "/dev/null/' + SENTINEL + ' ' + runId + ' $__dsh_status ' + SENTINEL
    + '" < /dev/null ) 2>&3 || __dsh_ok=1'
}

/**
 * The run wrapper, redefined in every submission rather than installed once.
 *
 * A wrapper installed once is a name an earlier command can take over. Making
 * every submission redefine it means our definition is the one that runs —
 * except on bash and /bin/sh, where `readonly -f __dsh_run` really does refuse
 * the redefinition. Measured: bash 3.2 keeps the original body and reports
 * "readonly function"; zsh has no equivalent and accepted every redefinition.
 * That is why the CALL sits inside the fd-3-closed scope. A wrapper we failed
 * to replace can misbehave in the session's own shell, but it cannot reach the
 * channel, so it cannot fake a completion for a command still running.
 *
 * DEBUG and ERR are disarmed on the way out, inside that same closed scope,
 * because a trap the command left armed would otherwise run in the shell at a
 * moment when fd 3 is open. 2>/dev/null so a shell that has never heard of
 * either signal does not complain about it once per run.
 */
const RUN_FUNCTION = (
  "__dsh_run () { trap 'return 130' INT ; __dsh_command=$1 ; "
  // set -- clears the positional parameter before the command runs, so a
  // command reading $1 or $@ sees what it would at a prompt rather than its
  // own text.
  + 'set -- ; '
  + 'eval "$__dsh_command" ; __dsh_status=$? ; '
  // Restored on the way out so an interrupt arriving while the shell is idle
  // finds the harmless handler; zsh exits 130 if it finds 'return 130' there.
  + "trap ':' INT ; trap - DEBUG 2>/dev/null ; trap - ERR 2>/dev/null ; "
  + 'return $__dsh_status ; }'
)

/**
 * Written before anything the caller can submit.
 *
 * Three statements and no more: the catching INT trap, which has to exist
 * before any command can run or an interrupt would kill the shell instead of
 * the command; the open of fd 3, which happens while nothing has had the
 * chance to shadow `exec`; and one record, whose arrival is how the registry
 * learns the descriptor is live and the file's name can be taken away.
 */
function bootstrap (controlPath) {
  return (
    // Catching, never ignoring: SIG_IGN would be inherited by every child.
    "trap ':' INT\n"
    + 'exec 3>>' + singleQuoted(controlPath) + '\n'
    + literalRecord('open', '1') + '\n'
  )
}

/**
 * Quote arbitrary text as ONE shell word.
 *
 * Single quotes are the only shell context with no escapes whatsoever, so the
 * single case to handle is a quote character ending the run early: `'\\''`
 * closes the run, escapes one literal quote, and opens the next. Everything
 * else — backslashes, dollars, backticks, newlines, the record separator —
 * survives byte for byte, which is what lets a command be handed to the shell
 * as data rather than pasted into a line the shell is parsing.
 */
export function singleQuoted (text) {
  return "'" + text.split("'").join("'\\''") + "'"
}

/** An error carrying the status the HTTP layer should answer with. */
export class SessionError extends Error {
  constructor (status, message, code) {
    super(message)
    this.name = 'SessionError'
    this.status = status
    if (code) this.code = code
  }
}

/**
 * Split text so no stored event exceeds the cap, never between the halves of a
 * surrogate pair — the pieces are JSON-encoded onto the wire and a lone
 * surrogate round-trips as a replacement character.
 */
export function splitChunk (text, max = MAX_EVENT_CHARS) {
  if (text.length <= max) return [text]
  const pieces = []
  let index = 0
  while (index < text.length) {
    let end = Math.min(index + max, text.length)
    if (end < text.length) {
      const code = text.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end -= 1
    }
    pieces.push(text.slice(index, end))
    index = end
  }
  return pieces
}

/**
 * The bounded transcript.
 *
 * Events are sequenced so a client that loses its stream can ask for what it
 * missed instead of redrawing everything. When the bytes it asked for have
 * already been dropped the replay reports `truncated`, and the pane replaces
 * its transcript rather than silently splicing a hole into it.
 */
export function createRing (limit = MAX_SCROLLBACK_BYTES) {
  const stored = []
  let bytes = 0
  let seq = 0
  let dropped = false

  return {
    push (event) {
      seq += 1
      const entry = { ...event, seq }
      const cost = typeof entry.text === 'string' ? Buffer.byteLength(entry.text) : 0
      stored.push({ entry, cost })
      bytes += cost
      // Never drop the event just pushed: splitChunk caps every event well
      // below the limit, so this only ever discards genuinely older ones.
      while (bytes > limit && stored.length > 1) {
        bytes -= stored.shift().cost
        dropped = true
      }
      return entry
    },
    since (from) {
      const all = stored.map((row) => row.entry)
      if (!Number.isInteger(from) || from < 0) return { events: all, truncated: dropped }
      const kept = all.filter((event) => event.seq > from)
      // A gap between what the client last saw and the oldest event still held
      // is the one case the client cannot repair by appending.
      const truncated = kept.length > 0 ? kept[0].seq > from + 1 : dropped && seq > from
      return { events: kept, truncated }
    },
    get seq () { return seq },
    get bytes () { return bytes },
    get dropped () { return dropped },
  }
}

/**
 * Bounded accumulation for one awaited command: the head, which holds the
 * failing command and its first error, plus a rolling tail, which holds the
 * summary. Dropping the middle is what keeps a long build usable as a tool
 * result instead of returning a fragment that starts mid-stack-trace.
 */
export function createCollector (head = COLLECT_HEAD_CHARS, tail = COLLECT_TAIL_CHARS) {
  let front = ''
  let back = ''
  let omitted = 0
  return {
    add (text) {
      if (front.length < head) {
        const room = head - front.length
        front += text.slice(0, room)
        text = text.slice(room)
        if (!text) return
      }
      back += text
      if (back.length > tail) {
        omitted += back.length - tail
        back = back.slice(back.length - tail)
      }
    },
    get text () {
      if (!back) return front
      return front + '\n[... ' + omitted + ' characters of output omitted ...]\n' + back
    },
    get truncated () { return omitted > 0 },
  }
}

/** The workspaces a session may start in, and whether the user really opened one. */
export function listRoots (ctx) {
  const roots = []
  const registered = new Set()
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (typeof workspace.path !== 'string' || !workspace.path) continue
    registered.add(workspace.path)
    roots.push({
      id: String(workspace.id),
      path: workspace.path,
      title: workspace.title || basename(workspace.path) || workspace.path,
      registered: true,
    })
  }
  // workspaceRoots adds the harness cwd so a fresh install is not a dead end.
  // It is reported with registered:false, because a shell in a directory the
  // user never chose is a different proposition from one they did, and the
  // pane says so rather than quietly starting there.
  for (const path of workspaceRoots(ctx)) {
    if (registered.has(path)) continue
    roots.push({ id: 'cwd:' + path, path, title: basename(path) || path, registered: false })
  }
  return roots
}

/**
 * The file behind fd 3.
 *
 * A private 0700 directory, then a 0600 file inside it, then a read handle.
 * Both modes are belt and braces around the real fence, which is that the
 * name barely lives: channelOpened unlinks it the moment the shell's `open`
 * record proves the descriptor exists, and from then on the inode has no name
 * anywhere in the filesystem for a command to find, open or truncate.
 *
 * Opened 'r' and never for writing. The shell holds the only write end, so
 * nothing in this process can put bytes on the channel either — which is what
 * lets drainControl treat a well-formed record as something the shell wrote.
 *
 * A regular file rather than a fifo because the read end has to exist before
 * the shell opens the write end, and a fifo's open blocks until both do. This
 * one is created empty, read by offset, and never rewound.
 */
async function createControlChannel () {
  // A prefix of its own. The test fixtures make their throwaway workspaces
  // with mkdtemp(tmpdir() + '/dsh-terminal-') too, and a test that wants to
  // assert this directory is gone has to be able to tell the two apart.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-terminal-control-'))
  const path = join(dir, 'control')
  await writeFile(path, '', { mode: 0o600 })
  const handle = await openFile(path, 'r')
  return {
    dir,
    path,
    handle,
    offset: 0,
    buffer: Buffer.allocUnsafe(CONTROL_READ_BYTES),
    decoder: new StringDecoder('utf8'),
    tail: '',
    opened: false,
    closed: false,
  }
}

/**
 * Create the registry. Everything the routes and the agent tool do to a shell
 * goes through here, so there is exactly one place that knows how a session is
 * started, fed, interrupted and torn down.
 *
 * @param ctx - needs ctx.subprocess and ctx.workspaceRegistry.
 * @param options - test seams for the bounds; production uses the defaults.
 */
export function createSessions (ctx, options = {}) {
  const scrollbackBytes = options.scrollbackBytes ?? MAX_SCROLLBACK_BYTES
  const idleGraceMs = options.idleGraceMs ?? IDLE_GRACE_MS
  const maxSessions = options.maxSessions ?? MAX_SESSIONS
  const sessions = new Map()
  let disposed = false

  function summarize (session) {
    return {
      id: session.id,
      cwd: session.cwd,
      root: session.root,
      title: session.title,
      shell: session.shellName,
      pid: session.pid,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      running: session.running,
      exitCode: session.exitCode,
      signal: session.signal,
      pendingRunId: session.pendingRun ? session.pendingRun.runId : null,
    }
  }

  function emit (session, event) {
    const stored = session.ring.push(event)
    for (const listener of [...session.listeners]) {
      try { listener(stored) } catch (error) { ctx.logger?.warn?.('terminal listener: %s', error?.message ?? error) }
    }
    return stored
  }

  function pushOutput (session, stream, text) {
    for (const piece of splitChunk(text)) emit(session, { kind: 'chunk', stream, text: piece })
  }

  /**
   * Read whatever the shell has put on fd 3 and act on the complete records.
   *
   * A record can arrive split across two reads, so the unparsed tail is kept
   * rather than dropped. It is bounded because a session that turns on `set -x`
   * gets the trace of the record construct itself written here too, and that
   * would otherwise grow for as long as the session lives.
   */
  async function drainControl (session) {
    const control = session.control
    if (!control || control.closed) return
    for (;;) {
      let read
      // The file is unlinked and only this handle holds it open, so a failure
      // here means the session is going away, not that a record was missed.
      try { read = await control.handle.read(control.buffer, 0, control.buffer.length, control.offset) } catch { return }
      if (read.bytesRead === 0) break
      control.offset += read.bytesRead
      control.tail += control.decoder.write(control.buffer.subarray(0, read.bytesRead))
      if (read.bytesRead < control.buffer.length) break
    }
    // A fresh matcher each time. Two sessions drain concurrently and a shared
    // lastIndex would let one of them step over the other's records.
    const pattern = new RegExp(RECORD_SOURCE, 'g')
    let consumed = 0
    let match
    while ((match = pattern.exec(control.tail)) !== null) {
      consumed = match.index + match[0].length
      applyRecord(session, match[1], match[2])
    }
    control.tail = control.tail.slice(consumed)
    if (control.tail.length > CONTROL_TAIL_MAX) control.tail = control.tail.slice(-SENTINEL.length)
  }

  /**
   * Nothing but this file writes to fd 3 and no command can reach it, so a
   * well-formed record here was written by the shell. What it is NOT is proof
   * that the shell is idle — see requestSync for why that has to be separate.
   */
  function applyRecord (session, first, second) {
    if (first === 'open') return channelOpened(session)
    if (first === 'sync') return syncArrived(session, second)
    if (second === 'run') return startRun(session, first)
    const status = Number(second)
    if (Number.isInteger(status)) recordDone(session, first, status)
  }

  /**
   * The shell has the descriptor, so take the file's name away.
   *
   * That the path exists until this record arrives is deliberate rather than a
   * race: a shell reads its script in order, so nothing the caller can submit
   * runs before the bootstrap that opens it. Unlinking earlier is the real
   * hazard — `exec 3>>path` creates the file it cannot find, and every record
   * would then be written to an inode nobody is reading.
   */
  function channelOpened (session) {
    const control = session.control
    if (!control || control.opened) return
    control.opened = true
    unlink(control.path).then(() => rmdir(control.dir)).catch(() => { /* it goes with the session */ })
  }

  /** A completion record for the run in flight. Not yet a `done`. */
  function recordDone (session, runId, exitCode) {
    const pending = session.pendingRun
    // A record for a run that is not in flight is not a late answer, it is a
    // guess at a future one — and with sequential run ids the guess is free.
    if (!pending || pending.runId !== runId) return
    pending.exitCode = exitCode
    pending.probed = false
    requestSync(session)
  }

  /**
   * Make the shell prove it is idle before the run is called finished.
   *
   * The proof is that it READ this line. A record only says something wrote to
   * fd 3, and a DEBUG trap the session left armed runs in the shell at a moment
   * when fd 3 is open, so it can write one. Reading the next line of the script
   * is different in kind: the shell only does that at top level, and it spends
   * the whole of a command inside wait(). So the nonce is fresh, unguessable
   * and written only after a record, and the `done` waits for it to come back.
   *
   * A later record re-probes. A forged one is written while the command is
   * still running, so the probe sits in the pipe where that command can read it
   * instead of the shell; the real record arrives when the command ends and the
   * probe written for THAT one is answered by a shell that is genuinely back.
   */
  function requestSync (session) {
    const pending = session.pendingRun
    if (!pending || pending.probed || pending.exitCode === undefined) return
    if (pending.probes >= MAX_SYNC_PROBES) return
    pending.probes += 1
    pending.probed = true
    pending.nonce = randomBytes(9).toString('hex')
    try { session.handle.stdin.write(literalRecord('sync', pending.nonce) + '\n') } catch { /* the shell went away */ }
  }

  function syncArrived (session, nonce) {
    const pending = session.pendingRun
    if (!pending || pending.nonce !== nonce || pending.exitCode === undefined) return
    completeRun(session, pending.runId, pending.exitCode)
  }

  function completeRun (session, runId, exitCode) {
    if (session.pendingRun && session.pendingRun.runId === runId) session.pendingRun = null
    // Remembered so a waiter that attaches a tick late still gets its answer
    // rather than sitting on a timeout for a command that already finished.
    session.lastDone = { runId, exitCode }
    emit(session, { kind: 'done', runId, exitCode })
  }

  /**
   * The command is now running under an armed trap. Deliberately not an event:
   * no client asked for it, and the only caller that needs it is interrupt().
   */
  function startRun (session, runId) {
    if (!session.pendingRun || session.pendingRun.runId !== runId) return
    session.pendingRun.started = true
    for (const wake of [...session.startWaiters]) wake()
    session.startWaiters.clear()
  }

  /**
   * Poll fd 3's file, fast while a run is in flight and slowly otherwise.
   *
   * A regular file rather than a pipe because the subprocess seam maps exactly
   * three descriptors and a plugin cannot ask it for a fourth. The cost is that
   * the channel is polled instead of pushed; what it buys is no mkfifo, no
   * ordering dance between two opens, and a name that can simply be unlinked.
   */
  function scheduleControl (session) {
    if (session.controlTimer || !session.running) return
    if (!session.control || session.control.closed) return
    const busy = session.pendingRun !== null || !session.control.opened
    session.controlTimer = setTimeout(() => {
      session.controlTimer = null
      drainControl(session).catch(() => {}).then(() => scheduleControl(session))
    }, busy ? CONTROL_POLL_BUSY_MS : CONTROL_POLL_IDLE_MS)
    session.controlTimer.unref?.()
  }

  /** Drop an idle-cadence timer, so a submission is not waited out at 250 ms. */
  function wakeControl (session) {
    if (session.controlTimer) {
      clearTimeout(session.controlTimer)
      session.controlTimer = null
    }
    scheduleControl(session)
  }

  function stopControl (session) {
    if (session.controlTimer) {
      clearTimeout(session.controlTimer)
      session.controlTimer = null
    }
    const control = session.control
    if (!control || control.closed) return
    control.closed = true
    control.handle.close().catch(() => {})
    unlink(control.path).catch(() => {}).then(() => rmdir(control.dir).catch(() => {}))
  }

  function finish (session, outcome) {
    if (!session.running) return
    session.running = false
    session.exitCode = outcome?.exitCode ?? null
    session.signal = outcome?.signal ?? null
    session.pendingRun = null
    // A dead shell will never answer another sync probe, so the channel has
    // nothing left to say and the file behind it can go.
    stopControl(session)
    emit(session, { kind: 'exit', exitCode: session.exitCode, signal: session.signal })
    // A command in a dead shell will never report that it started. Waking the
    // waiters lets them see that rather than sit out their bound.
    for (const wake of [...session.startWaiters]) wake()
    session.startWaiters.clear()
    if (session.closing) destroy(session)
  }

  function destroy (session) {
    session.listeners.clear()
    stopControl(session)
    sessions.delete(session.id)
  }

  function lookup (id) {
    const session = sessions.get(id)
    if (!session) throw new SessionError(404, 'no such terminal session')
    session.lastActivity = Date.now()
    return session
  }

  function requireRunning (id) {
    const session = lookup(id)
    if (!session.running) throw new SessionError(409, 'this shell has exited')
    return session
  }

  /**
   * One submission, as a single compound command.
   *
   * Three properties have to hold at once, and they are why this is not the
   * command line with a completion record written after it.
   *
   * PARSED BEFORE EXECUTED. `{ … ; }` is not complete until its closing brace,
   * so a shell reading this pipe consumes the whole submission before running
   * any of it, and nothing of the protocol is left in the pipe for the command
   * to read. Measured: `head -n 1` sees the line the user typed through /input
   * and no part of this. Written as three separate lines instead — which is
   * the obvious shape once the records stopped being printfs — the same
   * command ate the completion record and the run never finished.
   *
   * QUOTED, NOT PASTED. The command goes in as one single-quoted word — the
   * only shell context with no escape characters at all — so no amount of
   * unbalanced quoting inside it can reach the rest of the line. Pasting it
   * raw meant `echo 'oops` swallowed what followed as string content and
   * `cat <<EOF` swallowed it as here-document body.
   *
   * TERMINATED. The trailing blank line closes a dangling line continuation.
   * A command ending in an odd backslash leaves `eval` waiting for another
   * line, and on bash 3.2 (macOS /bin/bash and /bin/sh) that desynchronised
   * the outer parser: `echo A \\` ran, and the NEXT submission died with
   * "syntax error near unexpected token `}'" and took the shell with it.
   * Measured: with one appended newline the shell still dies, with two it
   * survives and both runs report their own status. zsh was never affected.
   *
   * The inner `{ … } 3>&-` is the fence. Everything the session can influence
   * — the wrapper definition, the wrapper call, the command itself, and any
   * trap it leaves armed — runs with no descriptor 3, while the two records sit
   * outside it where nothing but this line reaches them.
   */
  function submission (runId, command) {
    // Two records, not one. The second word tells them apart: `run` once the
    // command is under an armed trap, the exit status once it is over.
    return '{ ' + literalRecord(runId, 'run') + ' ; { '
      // Disarmed on the way in as well as on the way out, because the run that
      // armed them may also be the one that refused to be replaced.
      + 'trap - DEBUG 2>/dev/null ; trap - ERR 2>/dev/null ; '
      + RUN_FUNCTION + ' ; '
      + '__dsh_run ' + singleQuoted(command + '\n\n') + ' ; __dsh_status=$? ; '
      // An interrupt leaves the shell's trap as 'return 130', which is an error
      // at top level and, on zsh, exit 130 the next time one arrives. Restored
      // here because the trap's own restore is the step the interrupt skipped.
      + "trap ':' INT ; trap - DEBUG 2>/dev/null ; trap - ERR 2>/dev/null ; "
      + '} 3>&- ; '
      + statusRecord(runId) + ' ; }\n'
  }

  async function open (request = {}) {
    if (disposed) throw new SessionError(503, 'the terminal is shutting down')
    let live = 0
    for (const session of sessions.values()) if (session.running) live += 1
    if (live >= maxSessions) {
      throw new SessionError(429, 'Too many terminal sessions are open. Close one and try again.')
    }

    const asked = [request.cwd, request.root].find((value) => typeof value === 'string' && value)
      ?? workspaceRoots(ctx)[0] ?? null
    if (!asked) throw new SessionError(403, 'Open a folder before starting a terminal.')

    const contained = await containedPath(ctx, asked)
    // Never echo the path back: a distinguishable "outside the workspace" and
    // "does not exist" pair is a directory oracle for the whole disk.
    if (!contained) throw new SessionError(403, 'outside the workspace')

    const info = await stat(contained.path).catch(() => null)
    if (!info || !info.isDirectory()) throw new SessionError(400, 'a terminal needs a directory')

    const shell = await resolveShell()
    if (!shell) throw new SessionError(503, 'No usable shell was found on this machine.')

    const cols = clamp(request.cols, 20, 500, 80)
    const rows = clamp(request.rows, 5, 300, 24)

    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: shell.argv,
        cwd: contained.path,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: TERMINATE_GRACE_MS,
        env: shellEnv(cols, rows),
      })
    } catch (error) {
      throw new SessionError(503, 'Could not start ' + shell.name + ': ' + (error?.message ?? 'spawn failed'))
    }
    if (handle.pid === -1) throw new SessionError(503, 'Could not start ' + shell.name + '.')

    let control
    try {
      control = await createControlChannel()
    } catch {
      // Without the channel no run could ever report finishing, so this is a
      // failed start rather than a session that quietly never completes.
      try { handle.terminate() } catch { /* nothing to stop */ }
      throw new SessionError(503, 'Could not open the terminal control channel.')
    }

    const session = {
      id: randomBytes(12).toString('hex'),
      cwd: contained.path,
      root: contained.root,
      title: basename(contained.path) || contained.path,
      shellName: shell.name,
      pid: handle.pid,
      cols,
      rows,
      startedAt: new Date().toISOString(),
      running: true,
      exitCode: null,
      signal: null,
      closing: false,
      handle,
      control,
      controlTimer: null,
      runCounter: 0,
      pendingRun: null,
      lastDone: null,
      startWaiters: new Set(),
      ring: createRing(scrollbackBytes),
      listeners: new Set(),
      lastActivity: Date.now(),
    }
    sessions.set(session.id, session)

    handle.stdout?.setEncoding('utf8')
    // Verbatim: there is nothing of ours in stdout left to filter out. That is
    // also why `exec 1>&2` can no longer publish a secret or wedge a run — the
    // protocol is on neither of the two streams a command can redirect.
    handle.stdout?.on('data', (chunk) => pushOutput(session, 'stdout', chunk))
    handle.stderr?.setEncoding('utf8')
    handle.stderr?.on('data', (chunk) => pushOutput(session, 'stderr', chunk))
    handle.stdin?.on('error', () => { /* the shell went away; done settles below */ })
    handle.done.then(
      (outcome) => finish(session, outcome),
      (error) => {
        pushOutput(session, 'stderr', String(error?.message ?? error) + '\n')
        finish(session, { exitCode: null, signal: null })
      },
    )

    // Before anything the caller can submit, so no command can run without the
    // trap that makes it interruptible or the descriptor that carries its
    // completion.
    handle.stdin?.write(bootstrap(control.path))
    scheduleControl(session)

    return summarize(session)
  }

  /**
   * Submit one command line and arm its completion record.
   *
   * One command at a time per session, deliberately: a second write while the
   * first is still running would be read as that program's stdin, not as a
   * command, and the exit status the record reports would belong to whichever
   * finished last. That rule is also what keeps the pipe clean — while a
   * command runs, the only bytes written to it are the ones `write()` sends on
   * the user's behalf, so a program reading stdin reads exactly what the user
   * typed and nothing of ours.
   *
   * The run id is a decimal counter and deliberately not a secret. Nothing is
   * kept safe by it being unguessable: a record naming a run that is not the
   * one in flight is dropped, and the run in flight is not finished on a
   * record alone. Guessing the next id buys a forger exactly what guessing the
   * old marker bought them, which is now nothing. See requestSync.
   */
  function run (id, command) {
    const session = requireRunning(id)
    if (typeof command !== 'string' || command === '') {
      throw new SessionError(400, 'command must be a non-empty string')
    }
    if (command.includes('\0')) throw new SessionError(400, 'command must not contain a null byte')
    if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new SessionError(413, 'command is too long')
    if (session.pendingRun) throw new SessionError(409, 'a command is already running in this session')

    const runId = String(session.runCounter += 1)
    session.pendingRun = {
      runId,
      submittedAt: Date.now(),
      started: false,
      // The status a record has CLAIMED, held here until a sync probe proves
      // the shell is idle. undefined rather than null, because 0 is a status.
      exitCode: undefined,
      nonce: null,
      probes: 0,
      probed: false,
    }
    // One write, so the shell cannot see a half-formed compound command and
    // start executing part of it.
    session.handle.stdin.write(submission(runId, command))
    // The channel polls a quarter second apart while nothing is running, and
    // a short command finishes well inside one of those. Switching to the busy
    // cadence here is the difference between `true` completing in about 4 ms
    // and completing in up to 250.
    wakeControl(session)
    return { runId }
  }

  /** Raw stdin, for answering a prompt a running program printed. */
  function write (id, data) {
    const session = requireRunning(id)
    if (typeof data !== 'string') throw new SessionError(400, 'data must be a string')
    if (data.includes('\0')) throw new SessionError(400, 'data must not contain a null byte')
    if (Buffer.byteLength(data) > MAX_INPUT_BYTES) throw new SessionError(413, 'input is too long')
    session.handle.stdin.write(data)
  }

  /**
   * Interrupt whatever the shell is running, and not the shell itself.
   *
   * The signal goes to the shell's whole PROCESS GROUP. The seam spawns
   * detached, so the group id is the shell's own pid and every descendant that
   * has not deliberately left the session is in it. That is the only way to
   * reach a grandchild: `pkill -INT -P <shell>` matched direct children only,
   * so interrupting `sh -c 'sleep 4003; …'` — the shape of `npm run dev` and
   * `make` — signalled the `sh` and left both it and the `sleep` running while
   * the route still answered {"ok":true,"interrupted":true}.
   *
   * The shell survives its own group's signal because of the trap installed at
   * startup, and that trap is also what abandons the rest of the command line:
   * `sleep 300; echo AFTER_SLEEP` interrupted no longer prints AFTER_SLEEP and
   * no longer reports 0, so `make clean; make install` stops at the first.
   *
   * `interrupted` now means the command STOPPED, which is the question the
   * caller is actually asking. It was previously "pkill matched something".
   *
   * A false answer carries a reason, because "nothing was running" and "the
   * command ignored it and is still running" are opposite situations for the
   * person who pressed the key, and the boolean alone had the pane reporting
   * the first whenever the second happened. A true answer carries nothing
   * extra: there is only one way for a command to have stopped.
   */
  async function interrupt (id, name = 'SIGINT') {
    const session = requireRunning(id)
    if (name !== 'SIGINT') throw new SessionError(400, 'only SIGINT is supported')
    // Nothing running is not a failure, and signalling anyway is a real
    // hazard: an interrupt that lands on an idle zsh with the wrong trap
    // armed exits it 130.
    const pending = session.pendingRun
    if (!pending) return { interrupted: false, reason: 'Nothing was running to interrupt.' }
    // A signal sent before the command starts is not early, it is lost: it
    // lands on the harmless top-level trap and the command then runs anyway.
    // A login zsh reproduced that on every session, because its profile takes
    // half a second and the first command is usually submitted immediately.
    if (!pending.started && !await whenStarted(session, RUN_START_GRACE_MS)) {
      return { interrupted: false, reason: 'The command has not started yet.' }
    }
    try {
      // Not the seam's terminate(), which is a process-GROUP SIGTERM and would
      // take the shell down with the command. The pid cannot have been recycled
      // under us: the handle is still open, so the child is ours until it is
      // reaped, and requireRunning has already established that it is.
      process.kill(-session.pid, 'SIGINT')
    } catch (error) {
      // ESRCH means the group went away between the check and the signal.
      if (error?.code !== 'ESRCH') throw new SessionError(503, 'Could not deliver the interrupt on this machine.')
    }
    // The completion record is written after the trap unwinds, so a stopped
    // command reports 130 the same way a finished one reports its own status,
    // and it is still followed by the sync probe — an interrupt does not get a
    // cheaper proof of idleness than an ordinary completion. Waiting for that
    // is what makes the answer trustworthy, and what stops the next command
    // being refused as "already running" for a session that is idle.
    await settled(session, pending.runId, INTERRUPT_SETTLE_MS)
    if (session.pendingRun?.runId !== pending.runId) return { interrupted: true }
    return { interrupted: false, reason: 'The command ignored the interrupt and is still running.' }
  }

  /** Resolve when this run reports done, the shell exits, or the bound expires. */
  function settled (session, runId, timeoutMs) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        session.listeners.delete(listener)
        resolve()
      }
      const listener = (event) => {
        if (event.kind === 'exit' || (event.kind === 'done' && event.runId === runId)) finish()
      }
      const timer = setTimeout(finish, timeoutMs)
      timer.unref?.()
      session.listeners.add(listener)
    })
  }

  /** Resolve to whether the pending command has started, up to the bound. */
  function whenStarted (session, timeoutMs) {
    const pending = session.pendingRun
    if (!pending) return Promise.resolve(false)
    if (pending.started) return Promise.resolve(true)
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        session.startWaiters.delete(wake)
        resolve(pending.started === true)
      }
      const timer = setTimeout(wake, timeoutMs)
      timer.unref?.()
      session.startWaiters.add(wake)
    })
  }

  /**
   * Record new dimensions and tell the shell about them.
   *
   * Without a pty there is no ioctl to resize, so COLUMNS/LINES are exported
   * for the next command instead. It is only written while the session is
   * idle: mid-command it would be read as that program's stdin.
   */
  function resize (id, cols, rows) {
    const session = requireRunning(id)
    session.cols = clamp(cols, 20, 500, session.cols)
    session.rows = clamp(rows, 5, 300, session.rows)
    if (!session.pendingRun) {
      session.handle.stdin.write('export COLUMNS=' + session.cols + ' LINES=' + session.rows + '\n')
    }
    return summarize(session)
  }

  /**
   * Read the process table once: pid, parent, process group, command.
   *
   * Through the seam rather than child_process, so this scan is scrubbed and
   * group-terminated like everything else the plugin starts. Not "tree-scoped":
   * the seam signals a process group, which is exactly why the rest of this
   * file has to read the table at all.
   */
  async function processTable () {
    let ps = '/bin/ps'
    try { ps = await ctx.subprocess.resolveExecutable('ps') } catch { /* the usual path */ }
    const handle = ctx.subprocess.spawn({
      argv: [ps, '-Ao', 'pid=,ppid=,pgid=,command='],
      // The harness's own directory, not the session's. A scan of the process
      // table has nothing to do with the workspace, and a session whose
      // directory was removed before it was closed made the spawn itself fail
      // with ENOENT — losing the scan for the one teardown that needed it.
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' },
      graceMs: TERMINATE_GRACE_MS,
    })
    let output = ''
    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', (chunk) => { output += chunk })
    await handle.done
    const rows = []
    for (const line of output.split('\n')) {
      const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line)
      if (fields) {
        rows.push({ pid: Number(fields[1]), ppid: Number(fields[2]), pgid: Number(fields[3]), command: fields[4] })
      }
    }
    return rows
  }

  /**
   * Every descendant of the shell, by parent link, with the group each one is
   * in at the moment of the scan.
   *
   * The walk has to run while the shell is still alive: a child that called
   * setsid() keeps its parent link, and loses it the moment the shell dies and
   * it is reparented to init. This is the only moment the tree exists, so all
   * of it is kept rather than only the rows already sitting outside the group.
   *
   * Keeping only those rows was the previous shape and it had a hole in the
   * middle of it. A child that is still in the group when the scan runs, and
   * leaves it while handling the group's SIGTERM, is in neither path: the scan
   * did not record it, and the group SIGKILL that follows can no longer reach
   * it. Measured against 1d79ba8 with a child that calls setsid() from its
   * SIGTERM handler — the shape of a dev server that re-execs or daemonises on
   * the way down — the shell exited on schedule and the child was still there
   * when the test gave up 15 s later, reparented to init with a process group
   * of its own. Which side of the fence a row is on is decided after the
   * terminate instead, by reading the table again.
   */
  function descendantsOf (rows, shellPid) {
    const children = new Map()
    for (const row of rows) {
      const kin = children.get(row.ppid)
      if (kin) kin.push(row)
      else children.set(row.ppid, [row])
    }
    const found = []
    const seen = new Set([shellPid])
    let frontier = [shellPid]
    while (frontier.length > 0) {
      const next = []
      for (const parent of frontier) {
        for (const row of children.get(parent) ?? []) {
          if (seen.has(row.pid)) continue
          seen.add(row.pid)
          next.push(row.pid)
          found.push(row)
        }
      }
      frontier = next
    }
    return found
  }

  const signalGroup = (pgid, name) => {
    // kill(-1) is "every process this user owns" — the whole desktop session,
    // the editor, the app itself. No descendant can legitimately be in group 0
    // or 1, so a parse that produced one is a bug in the scan and never an
    // instruction to signal. Refusing costs one comparison.
    if (!Number.isInteger(pgid) || pgid <= 1) return
    try { process.kill(-pgid, name) } catch { /* already gone */ }
  }

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

  /**
   * Terminate one session's shell, then everything that outlived it. See
   * close() for what this reaches and what it does not.
   */
  async function reap (session) {
    let tree = []
    try {
      const rows = await Promise.race([
        processTable().catch(() => []),
        wait(PROCESS_SCAN_MS).then(() => []),
      ])
      tree = descendantsOf(rows, session.pid)
    } catch (error) {
      // A teardown the user asked for happens whether or not ps answered.
      ctx.logger?.warn?.('terminal teardown scan: %s', error?.message ?? error)
    }
    try { session.handle.terminate() } catch { /* already gone */ }
    if (tree.length > 0) await sweep(tree, session.pid)
    // Always, not only when the scan found something: the child that can hold
    // the pipe open is exactly the one the scan cannot see.
    await releasePipes(session)
  }

  /**
   * Kill whatever the shell's own termination did not.
   *
   * Rows that were already outside the shell's group when the tree was read get
   * a SIGTERM of their own straight away: the seam's group signal is never
   * going to reach them, and a dev server should be asked to stop before it is
   * killed. Everything else is left to the group signal, which handles it.
   *
   * Then the whole tree is polled, and whatever is still alive when the grace
   * expires is looked up in the table again. Being there at all is the test.
   * Every process still inside the group has been SIGKILLed by the seam by
   * then, so anything that answers the second reading has left the group —
   * whenever it left, and however. That is one mechanism for all three shapes
   * (out before the scan, out during it, out while handling the group's
   * SIGTERM) and it over-reaches on none of them, because a process that never
   * left is simply not in the second reading.
   *
   * Polled rather than slept out, so an ordinary close does not pay for the
   * abnormal one. Measured on this machine: a session closed with a background
   * sleep still in the group leaves sweep on the first poll, 52-53 ms, against
   * the 3 s it would cost to sleep the window out. Close to dispose returning
   * is 85-94 ms, which is what it measured before any of this was here.
   */
  async function sweep (tree, shellPid) {
    // kill(pid, 0) is a liveness question with no signal attached and costs
    // nothing, which is what makes polling cheaper than waiting.
    const gone = (rows) => rows.every((row) => {
      try { process.kill(row.pid, 0); return false } catch { return true }
    })
    const quiet = async (rows) => {
      const stop = Date.now() + TERMINATE_GRACE_MS
      while (Date.now() < stop && !gone(rows)) await wait(50)
      return gone(rows)
    }
    // Read again rather than trusting the snapshot, for two separate reasons.
    // SIGKILL cannot be declined, so it only ever goes to a pid that is still
    // the same command it was — the one way a recycled pid could be mistaken
    // for a survivor. And the group to signal is the one the process is in NOW:
    // a child that called setsid() after the scan is recorded here under the
    // shell's group, which is empty by this point, so the snapshot's pgid would
    // signal nothing at all.
    const survivors = async (rows) => {
      const now = await processTable().catch(() => [])
      const live = new Map(now.map((row) => [row.pid, row]))
      const found = []
      for (const row of rows) {
        const current = live.get(row.pid)
        if (current && current.command === row.command) found.push(current)
      }
      return found
    }

    // Its own group, not just its pid: setsid() makes an escapee a group
    // leader, so anything it has already started is in there with it.
    const outside = new Set(tree.filter((row) => row.pgid !== shellPid).map((row) => row.pgid))
    for (const pgid of outside) signalGroup(pgid, 'SIGTERM')
    if (await quiet(tree)) return

    const left = await survivors(tree)
    if (left.length === 0) return
    for (const pgid of new Set(left.map((row) => row.pgid))) signalGroup(pgid, 'SIGTERM')
    // A second window, because one of these shapes has never been asked to stop
    // at all: a child that calls setsid() during the scan — 35-39 ms against
    // this machine's 870 rows, median 36 — is recorded as an ordinary group
    // member and is already out of the group when terminate() fires, so this is
    // the first signal it ever sees. It gets the same grace as everything else
    // here, and the window is polled, so it costs nothing unless the process
    // ignores this SIGTERM too.
    if (await quiet(left)) return
    for (const row of await survivors(left)) signalGroup(row.pgid, 'SIGKILL')
  }

  /**
   * Let go of the shell's pipes once the shell itself is gone.
   *
   * A child handle settles on process exit AND stdio EOF, and setsid() does not
   * close file descriptors — so a child that got away still holds the write end
   * of the shell's stdout and stderr, and the handle never settles even though
   * the shell is dead. Measured against 0.1.22 with such a child: dispose() sat
   * pending indefinitely (2m36s before the test runner was killed by hand) and
   * returned the instant the child was killed. The session would also have
   * stayed running:true in the registry for the lifetime of the app, with the
   * pane showing a live shell that had already exited.
   *
   * So when the pid is gone and the handle still has not settled, the read ends
   * are dropped. Nothing the SHELL wrote is lost by that. Measured across
   * transcripts up to 100 MB, including a consumer deliberately stalled 20 ms
   * per 16 KB event, its last byte arrives 38-46 ms BEFORE its pid disappears
   * — a child is reaped on the same loop turn that drains its pipe — and the
   * settle is a timer, so whatever delays the drain delays it by as much.
   * What does get dropped is whatever the escapee writes after the shell is
   * already gone: measured, all of it still arrives at a 240 ms delay and none
   * of it at 300 ms. That is the intent rather than a cost. Output from a
   * process that outlived the shell is not this session's transcript.
   */
  async function releasePipes (session) {
    const stop = Date.now() + 2 * TERMINATE_GRACE_MS
    for (;;) {
      if (!session.running) return
      if (Date.now() > stop) return
      let gone = false
      try { process.kill(session.pid, 0) } catch { gone = true }
      if (gone) break
      await wait(50)
    }
    // Not the instant it is gone: node emits what it has already buffered
    // before it ends the stream, and dropping the read end early would
    // truncate the shell's last line.
    await wait(PIPE_SETTLE_MS)
    if (!session.running) return
    session.handle.stdout?.destroy()
    session.handle.stderr?.destroy()
  }

  /**
   * Stop a session and everything it started.
   *
   * The seam's terminate() is process-GROUP scoped, and that covers every
   * ordinary descendant. Measured against this build: `sh -c`, a background
   * `&` job, `nohup`, `disown` and a real `npm run dev` are all reaped by it,
   * including after an intermediate process has already reparented to init.
   *
   * What a group signal cannot reach is a child that called setsid(). It left
   * the group deliberately, and no signal addressed to the group will ever find
   * it again — 0.1.22 left exactly that child running, verified with ps 5.5 s
   * after close with its pid reparented to 1. So the group is not the only
   * thing consulted. While the shell is still alive, and therefore while the
   * parent links still exist, the process table is read once and the WHOLE tree
   * is kept; once the shell is dead it is read again, and any pid from that tree
   * still answering under the same command has left the group and is signalled
   * in its own right.
   *
   * Reading twice rather than classifying once is what catches a child that
   * leaves DURING the teardown. 1d79ba8 recorded escapees at scan time only, so
   * a child that took the group's SIGTERM, handled it and called setsid() on
   * the way out was in neither path: the scan had filed it as an ordinary group
   * member, and the group SIGKILL that follows could no longer reach it.
   * Measured against 1d79ba8 with exactly that child, twice: the shell died,
   * dispose() returned at 341 and 343 ms reporting success, and the child was
   * still running — still running when a test gave up on it 15 s later. It is
   * the shape of a dev server that re-execs or daemonises on shutdown. It now
   * dies 6.09 s after the terminate, which is two polled grace windows and two
   * scans, with dispose() returning at 6.38 s.
   *
   * That bound is only paid by something that ignores two SIGTERMs. An ordinary
   * close measures the same either way: 85-94 ms at 1d79ba8 and 85-94 ms now,
   * for an idle session, a background sleep still in the group, and a child
   * that had already called setsid() before close was asked for.
   *
   * The limit, stated rather than papered over. This catches any descendant
   * that still has its parent link when the shell dies, whenever it leaves the
   * group and however. It does NOT catch a classic double-fork daemon: that
   * child is reparented to init before any scan could see it, measured at a
   * median of 23 us against the 36 ms one scan costs here. There is no window
   * to widen there. Closing it needs the kernel to hold the tree — a subreaper
   * or a cgroup on Linux, neither of which exists on macOS and neither of which
   * is reachable from Node without a native module.
   *
   * A session whose shell has already exited is dropped with no scan at all,
   * and there is nothing better available. The parent links died with the
   * shell, so there is no tree left to walk; anything still in the group went
   * when the shell went, and anything that had left the group is by then
   * indistinguishable from every other process on the machine. That case is not
   * handled here because it cannot be, not because it was overlooked.
   */
  function close (id) {
    const session = sessions.get(id)
    if (!session) return false
    session.closing = true
    if (!session.running) {
      destroy(session)
      return true
    }
    // Idempotent while a sweep is in flight. /close and a plugin unload both
    // reach here for the same session, and starting a second sweep would
    // replace the promise dispose() is waiting on with one that began later.
    // Measured: the second scan ran 73 ms behind the first and re-signalled a
    // group that was already dead.
    if (session.reaping) return true
    // Retained so dispose() can wait for the sweep it started; a failure here
    // is reported and dropped, because close must not be able to fail.
    session.reaping = reap(session).catch((error) => {
      ctx.logger?.warn?.('terminal teardown: %s', error?.message ?? error)
    })
    return true
  }

  /**
   * Attach a reader. The replay comes first and synchronously, so a client can
   * never observe a live event before the history that precedes it.
   */
  function subscribe (id, since, onEvent) {
    const session = lookup(id)
    const replay = session.ring.since(since)
    onEvent({ kind: 'session', session: summarize(session), seq: session.ring.seq, truncated: replay.truncated })
    for (const event of replay.events) onEvent(event)
    session.listeners.add(onEvent)
    return () => {
      session.listeners.delete(onEvent)
      session.lastActivity = Date.now()
    }
  }

  /**
   * Wait for one submitted command to finish. Used by the agent tool, which
   * needs a single command's output and status rather than a live stream.
   */
  function waitForRun (id, runId, waitOptions = {}) {
    const session = lookup(id)
    const timeoutMs = waitOptions.timeoutMs ?? 120_000
    const signal = waitOptions.signal
    const collector = createCollector()
    return new Promise((resolve) => {
      let settled = false
      const settle = (result) => {
        if (settled) return
        settled = true
        session.listeners.delete(listener)
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        resolve({ output: collector.text, truncated: collector.truncated, ...result })
      }
      const listener = (event) => {
        if (event.kind === 'chunk') collector.add(event.text)
        else if (event.kind === 'done' && event.runId === runId) settle({ exitCode: event.exitCode, timedOut: false })
        else if (event.kind === 'exit') settle({ exitCode: event.exitCode, timedOut: false, exited: true })
      }
      const onAbort = () => settle({ exitCode: null, timedOut: false, aborted: true })
      const timer = setTimeout(() => settle({ exitCode: null, timedOut: true }), timeoutMs)
      timer.unref?.()
      session.listeners.add(listener)
      // A run that finished before the waiter attached is answered from the
      // remembered result rather than waited out.
      if (session.lastDone && session.lastDone.runId === runId) settle({ exitCode: session.lastDone.exitCode, timedOut: false })
      else if (!session.running) settle({ exitCode: session.exitCode, timedOut: false, exited: true })
      else if (signal?.aborted) onAbort()
      else signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  /**
   * Reap shells nobody is watching.
   *
   * A reader — the pane's stream, or an awaited tool run — counts as activity,
   * so an open Terminal tab is never reaped mid-build. What this catches is the
   * session left behind when the tab closes or the agent finishes: without it,
   * every visit to the Terminal view would leak one shell for the lifetime of
   * the app.
   */
  const reaper = setInterval(() => {
    const now = Date.now()
    for (const session of [...sessions.values()]) {
      if (session.listeners.size > 0) { session.lastActivity = now; continue }
      if (now - session.lastActivity < idleGraceMs) continue
      close(session.id)
    }
  }, options.reapIntervalMs ?? REAP_INTERVAL_MS)
  reaper.unref?.()

  return {
    list: () => [...sessions.values()].map(summarize),
    roots: () => listRoots(ctx),
    get: (id) => { const session = sessions.get(id); return session ? summarize(session) : null },
    open,
    run,
    write,
    interrupt,
    resize,
    close,
    subscribe,
    waitForRun,
    /**
     * Terminate every shell and stop the reaper. Awaits real quiescence: both
     * the shells themselves and the sweep close() starts for anything that left
     * their process group.
     */
    async dispose () {
      disposed = true
      clearInterval(reaper)
      const live = [...sessions.values()]
      for (const session of live) close(session.id)
      await Promise.all(live.flatMap((session) => [
        session.handle.waitForExit?.().catch(() => {}) ?? Promise.resolve(),
        session.reaping ?? Promise.resolve(),
      ]))
      sessions.clear()
    },
  }
}

function clamp (value, low, high, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(high, Math.max(low, Math.round(number)))
}
