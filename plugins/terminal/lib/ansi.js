/**
 * Escape-sequence removal for the two consumers that want plain text: the
 * agent tool, whose result goes into a model's context, and any log line.
 *
 * The pane does NOT use this — it translates SGR colour into spans instead, so
 * a coloured build log still reads as a coloured build log. That translator
 * lives in client.js because the browser half is one self-contained module the
 * loader serves; this file is the host's much smaller half of the same job.
 *
 * Stripping is deliberately whole-sequence rather than a naive \x1b\[[0-9;]*m:
 * a terminal emits cursor moves, erases, OSC title writes and bracketed-paste
 * toggles too, and leaving those in produces text like "?2004h" in the middle
 * of a sentence.
 */

/**
 * CSI: ESC [ , parameter bytes 0x30-0x3f, intermediates 0x20-0x2f, one final
 * byte 0x40-0x7e. OSC: ESC ] ... terminated by BEL or ST (ESC \). Then the
 * two-character escapes, and finally the C1 controls a UTF-8 stream can carry.
 */
const SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]|[\u0080-\u009f]/g

/** Backspace runs, and a carriage return that is not part of a CRLF. */
const OVERWRITES = /\r(?!\n)/g

/**
 * Plain text for a transcript that has no terminal to interpret it.
 *
 * \r is turned into \n rather than dropped: a progress bar that redraws its
 * line with \r would otherwise collapse into one run-on line of every frame it
 * ever drew, which is harder to read than the frames on separate lines.
 */
export function stripAnsi (text) {
  if (typeof text !== 'string' || text === '') return ''
  return text.replace(SEQUENCES, '').replace(OVERWRITES, '\n')
}

/**
 * Keep a bounded excerpt of command output: the head, which usually holds the
 * command that failed and the first error, and the tail, which holds the
 * summary. Dropping only the middle is the difference between a useful tool
 * result and a truncated one that starts mid-stack-trace.
 *
 * @returns `{ text, truncated }` — `text` carries an explicit elision note so a
 *   model never reads the join as contiguous output.
 */
export function excerpt (text, { head = 24_000, tail = 8_000 } = {}) {
  if (typeof text !== 'string') return { text: '', truncated: false }
  if (text.length <= head + tail) return { text, truncated: false }
  const dropped = text.length - head - tail
  return {
    text: text.slice(0, head)
      + `\n[... ${dropped} characters of output omitted ...]\n`
      + text.slice(text.length - tail),
    truncated: true,
  }
}
