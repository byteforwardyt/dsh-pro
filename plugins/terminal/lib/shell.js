/**
 * Which shell to run, and how to feed it.
 *
 * There is a real PTY available in this build — @deepseek-ai/dsh-subprocess-local
 * bundles node-pty and the seam exposes spawnTerminal. The interactive Shell
 * dock uses that primitive in pty-sessions.js. This agent-command path
 * deliberately stays piped. A PTY only pays for itself behind a terminal
 * emulator: it emits cursor addressing, alternate-screen switches and
 * bracketed-paste toggles that a transcript pane cannot honour, so the same
 * output that looks right in iTerm arrives here as noise. The Terminal view is
 * a line-oriented transcript with its own input box, so piped stdio is both the
 * honest match and the smaller attack surface: nothing the shell prints can
 * move a cursor, and nothing the user types is interpreted by a line editor
 * before we see it.
 *
 * The flags follow from that. A LOGIN shell (-l) reads the profile files that
 * set PATH, which is what makes node, pnpm and git resolvable the way they are
 * in the user's own terminal. An INTERACTIVE shell (-i) is deliberately not
 * requested: without a tty the shell disables its line editor and job control
 * anyway, so -i buys nothing but a prompt string full of escape sequences and,
 * on a themed .zshrc, a startup that expects a terminal it does not have.
 * -s makes the shell read commands from stdin, which is the whole protocol.
 *
 * The cost, stated plainly: aliases and functions defined in .zshrc/.bashrc are
 * NOT loaded, because those files are interactive-only. Commands on PATH all
 * work; a personal alias does not.
 */

import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { basename } from 'node:path'

/** Tried in order. $SHELL first, because it is the shell the user chose. */
const FALLBACKS = ['/bin/zsh', '/bin/bash', '/bin/sh']

/**
 * Argument vector for one shell, as an ARRAY — this never becomes a shell
 * string, so no path or flag can be reinterpreted as syntax.
 */
function argvFor (path) {
  const name = basename(path)
  if (name === 'zsh' || name === 'bash') return [path, '-l', '-s']
  // fish reads stdin when it is not a tty and has no -s; sh is POSIX -s only.
  if (name === 'fish') return [path, '-l']
  if (name === 'sh' || name === 'dash' || name === 'ash') return [path, '-s']
  // An unfamiliar shell gets no flags at all rather than a guess that might
  // mean something else entirely in its dialect.
  return [path]
}

async function executable (path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return false
  try { await access(path, constants.X_OK); return true } catch { return false }
}

/**
 * Resolve the shell to run for a new session.
 *
 * @returns `{ path, argv, name }` or null when this machine has none of them,
 *   which the route answers as a 503 rather than pretending a session started.
 */
export async function resolveShell (env = process.env) {
  const candidates = [env.SHELL, ...FALLBACKS]
  for (const candidate of candidates) {
    if (await executable(candidate)) {
      return { path: candidate, argv: argvFor(candidate), name: basename(candidate) }
    }
  }
  return null
}

/**
 * Environment for the child shell, layered over the seam's credential scrub.
 *
 * TERM is set because plenty of tools colour their output on TERM alone, and
 * the pane renders SGR colour properly. The pagers are pinned to cat because a
 * pager on a pipe either buffers everything or waits for a keypress that can
 * never arrive — a wedged session with no visible cause.
 */
export function shellEnv (cols, rows) {
  return {
    TERM: 'xterm-256color',
    COLUMNS: String(cols),
    LINES: String(rows),
    PAGER: 'cat',
    GIT_PAGER: 'cat',
  }
}
