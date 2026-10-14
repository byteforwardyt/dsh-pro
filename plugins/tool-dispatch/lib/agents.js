/**
 * The agent adapters — the only file that knows any specific CLI exists.
 *
 * WHY SUBPROCESSES AND NOT ACP (the obvious candidate, and the one the owner
 * suggested):
 *
 * ACP is the right standard for this and almost certainly where this ends up.
 * It is the wrong FIRST build, for three reasons verified on this machine
 * rather than assumed:
 *
 *   1. It inverts the work. In ACP the app is the *Client*, which means
 *      implementing a JSON-RPC server: `session/request_permission` is
 *      mandatory, plus session/update, fs/read_text_file, fs/write_text_file,
 *      five terminal/* methods and cancellation in both directions — roughly a
 *      dozen inbound methods before a single prompt can be dispatched. The v1
 *      story is "type a prompt, read the answer", which exercises none of it.
 *   2. The agents that matter do not ship it. `claude` 2.1.241 has no --acp and
 *      `codex` 0.149.0 has no acp subcommand; both need a third-party npm
 *      adapter fetched with npx at runtime. That is a network dependency, a
 *      cold-start stall, an offline failure and a supply-chain surface inside a
 *      signed, notarized app.
 *   3. The spec is mid-churn: v2 removes session/load, fs/* and terminal/*
 *      outright and redesigns session/prompt.
 *
 * So v1 speaks each CLI's own headless JSON mode, behind this one interface.
 * ACP then arrives as one more adapter rather than a rewrite — which is the
 * point of putting the knowledge here and nowhere else.
 *
 * An adapter is:
 *   id        stable identifier used on the wire
 *   label     what a human calls it
 *   bin       the executable to look for on PATH
 *   argv      ({ prompt, cwd }) => string[]   — never shell-interpreted
 *   parse     (line) => event | null          — one NDJSON line to our shape
 *   installHint  what to tell a user who does not have it
 */

/** Our normalized event shape, so the client renders one thing for every agent. */
// { kind: 'text', text }            assistant prose
// { kind: 'tool', name, detail }    a tool call, one line
// { kind: 'usage', input, output, cost }
// { kind: 'result', ok, text }      terminal summary

const textOf = (content) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
}

export const ADAPTERS = [
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    installHint: 'npm i -g @anthropic-ai/claude-code',
    argv: ({ prompt }) => ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose'],
    parse (line) {
      const event = JSON.parse(line)
      if (event.type === 'assistant') {
        const text = textOf(event.message?.content)
        const tools = (event.message?.content ?? []).filter?.((p) => p?.type === 'tool_use') ?? []
        if (tools.length) {
          return { kind: 'tool', name: tools[0].name, detail: shortInput(tools[0].input) }
        }
        return text ? { kind: 'text', text } : null
      }
      if (event.type === 'result') {
        const usage = event.usage ?? {}
        return {
          kind: 'result',
          ok: event.subtype === 'success',
          text: typeof event.result === 'string' ? event.result : '',
          usage: {
            input: usage.input_tokens ?? null,
            output: usage.output_tokens ?? null,
            cost: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
          },
        }
      }
      return null
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    bin: 'codex',
    installHint: 'npm i -g @openai/codex',
    // read-only by default: a dispatched agent must not edit the workspace
    // without the user having said so. See the note in index.js.
    // --skip-git-repo-check: codex refuses a directory that is not a git repo
    // ("Not inside a trusted directory"), and a workspace the user opened is
    // already the trust decision as far as this app is concerned. Safety here
    // comes from --sandbox read-only, not from the presence of a .git folder.
    argv: ({ prompt, cwd }) => [
      'codex', 'exec', '--json', '--cd', cwd,
      '--sandbox', 'read-only', '--skip-git-repo-check', prompt,
    ],
    // Shape captured from codex-cli 0.149.0 rather than assumed:
    //   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    //   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N}}
    // An earlier version guessed `{type:'agent_message', message}` and parsed
    // nothing at all — the run succeeded with an empty transcript, which is a
    // worse failure than an error because it looks like the agent said nothing.
    parse (line) {
      const event = JSON.parse(line)

      if (event.type === 'item.completed' || event.type === 'item.started') {
        const item = event.item ?? {}
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          return event.type === 'item.completed' ? { kind: 'text', text: item.text } : null
        }
        if (item.type === 'command_execution' || item.type === 'local_shell_call') {
          return { kind: 'tool', name: 'command', detail: shortInput(item.command ?? item.action) }
        }
        if (item.type === 'file_change' || item.type === 'patch_apply') {
          return { kind: 'tool', name: 'edit', detail: shortInput(item.path ?? item.changes) }
        }
        if (item.type === 'error' && typeof item.message === 'string') {
          return { kind: 'tool', name: 'note', detail: item.message.slice(0, 120) }
        }
        return null
      }

      if (event.type === 'turn.completed') {
        const usage = event.usage ?? {}
        return {
          kind: 'result',
          ok: true,
          text: '',
          usage: {
            input: usage.input_tokens ?? null,
            output: usage.output_tokens ?? null,
            cost: null,
          },
        }
      }
      if (event.type === 'turn.failed') {
        return { kind: 'result', ok: false, text: String(event.error?.message ?? 'turn failed') }
      }
      return null
    },
  },
  {
    id: 'cursor-agent',
    label: 'Cursor Agent',
    bin: 'cursor-agent',
    installHint: 'See cursor.com/cli',
    argv: ({ prompt }) => ['cursor-agent', '-p', prompt, '--output-format', 'stream-json'],
    parse (line) {
      const event = JSON.parse(line)
      if (event.type === 'assistant') {
        const text = textOf(event.message?.content)
        return text ? { kind: 'text', text } : null
      }
      if (event.type === 'result') {
        return { kind: 'result', ok: !event.is_error, text: typeof event.result === 'string' ? event.result : '' }
      }
      return null
    },
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    bin: 'kimi',
    installHint: 'See kimi.ai for the CLI',
    argv: ({ prompt }) => ['kimi', '-p', prompt, '--output-format', 'stream-json'],
    parse (line) {
      const event = JSON.parse(line)
      if (event.type === 'assistant') {
        const text = textOf(event.message?.content)
        return text ? { kind: 'text', text } : null
      }
      if (event.type === 'result') {
        return { kind: 'result', ok: !event.is_error, text: typeof event.result === 'string' ? event.result : '' }
      }
      return null
    },
  },
]

/** A tool's input, flattened to one short line. */
function shortInput (input) {
  if (typeof input === 'string') return input.slice(0, 120)
  if (!input || typeof input !== 'object') return ''
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
    if (typeof input[key] === 'string') return input[key].slice(0, 120)
  }
  try { return JSON.stringify(input).slice(0, 120) } catch { return '' }
}

export const adapterFor = (id) => ADAPTERS.find((a) => a.id === id)

/**
 * Turn one NDJSON line into an event, never throwing.
 *
 * Every one of these formats is a vendor's own dialect with no compatibility
 * promise, and a CLI update can change a field name without warning. A line we
 * cannot read is dropped rather than failing the run: a dispatch that still
 * shows the final result is far better than one that dies on an unrecognised
 * progress frame.
 */
export function parseLine (adapter, line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== '{') return null
  try {
    return adapter.parse(trimmed)
  } catch {
    return null
  }
}
