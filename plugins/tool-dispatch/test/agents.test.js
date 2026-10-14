import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ADAPTERS, adapterFor, parseLine } from '../lib/agents.js'

const claude = adapterFor('claude')
const codex = adapterFor('codex')

test('every adapter builds argv as an array, never a shell string', () => {
  for (const adapter of ADAPTERS) {
    const argv = adapter.argv({ prompt: 'hello', cwd: '/tmp/x' })
    assert.ok(Array.isArray(argv), `${adapter.id} argv must be an array`)
    assert.equal(argv[0], adapter.bin)
    assert.ok(argv.every((a) => typeof a === 'string'))
  }
})

test('a prompt with shell metacharacters stays one argument', () => {
  // The whole reason argv is an array: this must be a prompt, not a command.
  const nasty = '`rm -rf /`; echo $(whoami) && cat /etc/passwd'
  for (const adapter of ADAPTERS) {
    const argv = adapter.argv({ prompt: nasty, cwd: '/tmp/x' })
    assert.ok(argv.includes(nasty), `${adapter.id} must pass the prompt as one argv entry`)
  }
})

test('codex is dispatched read-only, so it cannot edit the workspace unasked', () => {
  const argv = codex.argv({ prompt: 'hi', cwd: '/tmp/x' })
  const at = argv.indexOf('--sandbox')
  assert.ok(at !== -1, 'codex must pass --sandbox')
  assert.equal(argv[at + 1], 'read-only')
})

test('codex skips the git-repo check, which blocked every non-repo workspace', () => {
  // Observed live: codex refuses with "Not inside a trusted directory" in a
  // plain folder. Opening a workspace is the trust decision; the sandbox flag
  // is what keeps it read-only.
  assert.ok(codex.argv({ prompt: 'hi', cwd: '/tmp/x' }).includes('--skip-git-repo-check'))
})

test('codex output is parsed from its REAL shape, captured from codex-cli 0.149.0', () => {
  // Verbatim lines from a live run. The first parser guessed a different shape
  // and produced an empty transcript on a successful run.
  const message = '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"dispatch works"}}'
  assert.deepEqual(parseLine(codex, message), { kind: 'text', text: 'dispatch works' })

  const done = '{"type":"turn.completed","usage":{"input_tokens":19557,"output_tokens":6}}'
  const event = parseLine(codex, done)
  assert.equal(event.kind, 'result')
  assert.deepEqual(event.usage, { input: 19557, output: 6, cost: null })

  // Chatter that must not become a message.
  for (const noise of ['{"type":"thread.started","thread_id":"x"}', '{"type":"turn.started"}']) {
    assert.equal(parseLine(codex, noise), null)
  }
})

test('claude assistant text becomes a text event', () => {
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } })
  assert.deepEqual(parseLine(claude, line), { kind: 'text', text: 'Hello' })
})

test('claude tool use becomes a one-line tool event', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }] },
  })
  assert.deepEqual(parseLine(claude, line), { kind: 'tool', name: 'Read', detail: '/a/b.ts' })
})

test('claude result carries usage and success', () => {
  const line = JSON.stringify({
    type: 'result', subtype: 'success', result: 'done',
    usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.002,
  })
  const event = parseLine(claude, line)
  assert.equal(event.kind, 'result')
  assert.equal(event.ok, true)
  assert.deepEqual(event.usage, { input: 10, output: 3, cost: 0.002 })
})

test('an unreadable line is dropped, never thrown — a vendor can change its format', () => {
  // These formats carry no compatibility promise; one bad progress frame must
  // not kill a run that is otherwise about to produce a result.
  for (const bad of ['not json', '{"unterminated', '', '   ', 'null', '{"type":"unknown"}']) {
    assert.doesNotThrow(() => parseLine(claude, bad))
    assert.equal(parseLine(claude, bad), null)
  }
})

test('adapter ids are unique and stable', () => {
  const ids = ADAPTERS.map((a) => a.id)
  assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort())
  assert.deepEqual(ids.slice().sort(), ['claude', 'codex', 'cursor-agent', 'kimi'])
})
