import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { previewTool } from '../lib/preview-tool.js'
import { createPreviewIntents } from '../lib/preview-intents.js'

async function fixture (t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-preview-tool-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  const outside = join(base, 'elsewhere')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(root, 'index.html'), '<!doctype html>')
  await writeFile(join(root, 'notes.txt'), 'not a page')
  await writeFile(join(outside, 'secret.html'), '<!doctype html>')
  const ctx = { workspaceRegistry: { list: () => [{ path: root }] } }
  const intents = createPreviewIntents()
  t.after(() => intents.dispose())
  return { root, outside, tool: previewTool(ctx, intents), intents }
}

test('an http address is published as the preview target', async t => {
  const { tool, intents } = await fixture(t)
  const seen = []
  const reader = { write: (chunk) => { seen.push(chunk); return true }, writeHead: () => {}, end: () => {} }
  intents.subscribe({ on: () => {} }, reader)

  const result = await tool.execute({ url: 'http://localhost:5173/' })
  assert.equal(result.ok, true)
  assert.equal(result.target, 'http://localhost:5173/')
  // A listening pane is the difference between "the user can see this" and
  // "this is queued", and the agent is told which one happened.
  assert.equal(result.visible, true)
  assert.ok(seen.some(chunk => chunk.includes('localhost:5173')))
})

test('agent previews are delivered and replayed only to their own chat', async t => {
  const { tool, intents } = await fixture(t)
  const listen = sessionId => {
    const chunks = []
    intents.subscribe({ url: '/preview/events?sessionId=' + sessionId, on () {} },
      { write: chunk => { chunks.push(chunk); return true }, writeHead () {}, end () {} })
    return chunks
  }
  const one = listen('one'), two = listen('two')
  const execute = (id, port) => tool.execute({ url: `http://localhost:${port}` }, { agent: { session: { header: { id } } } })
  assert.equal((await execute('one', 4173)).visible, true)
  assert.equal((await execute('two', 4179)).visible, true)
  assert.ok(one.some(chunk => chunk.includes('4173')))
  assert.ok(!one.some(chunk => chunk.includes('4179')))
  assert.ok(!two.some(chunk => chunk.includes('4173')))
  const replay = listen('one')
  assert.ok(replay.some(chunk => chunk.includes('4173')))
  assert.ok(!replay.some(chunk => chunk.includes('4179')))
  assert.equal((await execute('unopened', 5173)).visible, false)
})

test('a target published with no pane open is queued, and says so', async t => {
  const { tool } = await fixture(t)
  const result = await tool.execute({ url: 'https://example.com/' })
  assert.equal(result.ok, true)
  assert.equal(result.visible, false)
})

test('only http and https can reach the preview surface', async t => {
  const { tool, root } = await fixture(t)
  for (const url of ['file:///etc/passwd', 'data:text/html,<script>1</script>', 'javascript:alert(1)', `file://${root}/index.html`]) {
    const result = await tool.execute({ url })
    assert.equal(result.ok, false, `${url} must be refused`)
    assert.match(result.error, /http|valid address/)
  }
})

test('a workspace page is admitted and a path outside every workspace is not', async t => {
  const { tool, root, outside } = await fixture(t)

  const inside = await tool.execute({ path: join(root, 'index.html') })
  assert.equal(inside.ok, true)
  assert.equal(inside.kind, 'file')

  const escaped = await tool.execute({ path: join(outside, 'secret.html') })
  assert.equal(escaped.ok, false)
  assert.match(escaped.error, /outside every open workspace/)

  const traversal = await tool.execute({ path: join(root, '..', 'elsewhere', 'secret.html') })
  assert.equal(traversal.ok, false)
})

test('a symlink pointing out of the workspace cannot be previewed', async t => {
  const { tool, root, outside } = await fixture(t)
  const link = join(root, 'escape.html')
  await symlink(join(outside, 'secret.html'), link)
  const result = await tool.execute({ path: link })
  assert.equal(result.ok, false, 'containment is realpath-based, so the link has to land back inside')
})

test('a non-HTML workspace file is refused with an actionable reason', async t => {
  const { tool, root } = await fixture(t)
  const result = await tool.execute({ path: join(root, 'notes.txt') })
  assert.equal(result.ok, false)
  assert.match(result.error, /dev server/)
})

test('a package game entry requires a dev-server URL, not raw source HTML', async t => {
  const { tool, root } = await fixture(t)
  await writeFile(join(root, 'package.json'), '{"scripts":{"dev":"vite"}}')
  const result = await tool.execute({ path: join(root, 'index.html') })
  assert.equal(result.ok, false)
  assert.match(result.error, /dev server/)
})

test('an empty call is refused rather than opening something arbitrary', async t => {
  const { tool } = await fixture(t)
  for (const args of [{}, { url: '   ' }, { path: '' }, { url: 'not a url' }]) {
    assert.equal((await tool.execute(args)).ok, false)
  }
})

test('the retained intent is replayed to a pane that connects later', async t => {
  const { tool, intents } = await fixture(t)
  await tool.execute({ url: 'http://localhost:3000/' })

  const seen = []
  intents.subscribe({ on: () => {} }, { write: (chunk) => { seen.push(chunk); return true }, writeHead: () => {}, end: () => {} })
  assert.ok(seen.some(chunk => chunk.includes('localhost:3000')),
    'a pane opened after the tool ran still learns where it should be')
})

test('disposal closes readers and refuses further publication', async t => {
  const { tool, intents } = await fixture(t)
  let ended = 0
  intents.subscribe({ on: () => {} }, { write: () => true, writeHead: () => {}, end: () => { ended += 1 } })
  intents.dispose()
  assert.equal(ended, 1)
  const result = await tool.execute({ url: 'http://localhost:3000/' })
  assert.equal(result.ok, false)
})
