'use strict'

// Credential-free acceptance runner. The fixture replaces only the model HTTP
// endpoint; the DSH host, SuperCode runtime, tools, persistence, and UI are real.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { zstdDecompressSync, zstdCompressSync } = require('node:zlib')

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/test/supercode-smoke.cjs\nRuns real DSH + Python Playwright against a disposable local three-model fixture.\nOptional DSH_QA_HARNESS points to staged or installed Resources/harness; DSH_QA_NODE selects its Electron executable in Node mode.\nArtifacts remain in the printed /tmp/dsh-supercode-qa-* directory. No real app profile or provider credentials are used.')
  process.exit(0)
}

const source = process.env.DSH_QA_SOURCE || path.resolve(__dirname, '../..')
const installedHarness = process.env.DSH_QA_HARNESS && path.resolve(process.env.DSH_QA_HARNESS)
const pluginOverride = process.env.DSH_QA_PLUGIN_SOURCE && path.resolve(process.env.DSH_QA_PLUGIN_SOURCE)
const runtimeAnchor = installedHarness || path.join(source, 'shell')
if (!installedHarness) require('../native-conversation-delegate.cjs').prepareDevelopment(source)
const runtimeNode = process.env.DSH_QA_NODE || process.execPath
const startupTimeout = Number(process.env.DSH_QA_STARTUP_TIMEOUT_MS || 45000)
assert(Number.isInteger(startupTimeout) && startupTimeout >= 45000 && startupTimeout <= 180000, 'Startup timeout must be 45–180 seconds.')
const qaRoot = fs.mkdtempSync('/tmp/dsh-supercode-qa-')
const harnessHome = path.join(qaRoot, 'harness')
const workspace = path.join(qaRoot, 'deepseek-harness', 'default-workspace')
const modelIds = ['fixture-lead', 'fixture-builder', 'fixture-reviewer']
const expectedFile = 'SuperCode acceptance fixture: independently reviewed.\n'
const richPlan = [
  '### Implementation plan',
  '',
  '**Approval is required** before the builder writes `acceptance.txt`.',
  '',
  '- Builder creates the requested file.',
  '- Reviewer independently reads the result.',
  '- Lead accepts only a passing review.',
  '',
  '1. Investigate the workspace.',
  '2. Review this plan.',
  '3. Approve execution explicitly.',
  '',
  '```javascript',
  'console.log("supercode-copy-ok");',
  '```',
  '',
  '| Role | Verification |',
  '| --- | --- |',
  '| Builder | Native filesystem write |',
  '| Reviewer | Independent filesystem read |',
  '',
  '[Verification reference](https://example.com/verification) and [Workspace evidence](README.md).',
  '',
  '> Progress is public; private reasoning is not part of this conversation.',
  '',
  '<script>globalThis.__SUPERCODE_UNSAFE_EXECUTED__ = true</script>',
  '<img src="/supercode-unsafe-fixture" onerror="globalThis.__SUPERCODE_UNSAFE_EXECUTED__ = true">',
  '[Unsafe JavaScript](javascript:globalThis.__SUPERCODE_UNSAFE_EXECUTED__=true)',
  '[Unsafe data](data:text/html,unsafe-fixture)',
].join('\n')
const transcript = []
const fixtureErrors = []
let host, hostURL, probe, shuttingDown = false, serial = 0
let releaseProgress, progressReleased = false
const openResponses = new Set()

fs.mkdirSync(harnessHome, { recursive: true, mode: 0o700 })
fs.mkdirSync(workspace, { recursive: true })
execFileSync('git', ['init', '--quiet', workspace])
fs.writeFileSync(path.join(workspace, 'README.md'), '# SuperCode acceptance workspace\nCreate acceptance.txt with the requested exact content, then independently read and review it.\n')
console.log('SUPERCODE_QA_ROOT:', qaRoot)
fs.writeFileSync(path.join(qaRoot, 'runtime.json'), JSON.stringify({ source, installedHarness: installedHarness || null, pluginOverride: pluginOverride || null, runtimeAnchor, runtimeNode }, null, 2))

function json (res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

async function body (req) {
  const parts = []
  let size = 0
  for await (const part of req) {
    size += part.length
    if (size > 4 * 1024 * 1024) throw new Error('Fixture request exceeds 4 MiB')
    parts.push(part)
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
}

function messageText (message) {
  return typeof message.content === 'string' ? message.content : (message.content || []).map(item => item.text || '').join('\n')
}

function writeTranscript () {
  fs.writeFileSync(path.join(qaRoot, 'model-requests.json'), JSON.stringify({ transcript, fixtureErrors }, null, 2))
}

function sessionPolicies (ids) {
  const directory = path.join(harnessHome, 'sessions')
  assert(Array.isArray(ids) && ids.length <= 5 && ids.every(id => /^[a-zA-Z0-9_-]{1,80}$/.test(id)), 'Invalid fixture session identities')
  return ids.map(id => {
    const found = fs.readdirSync(directory).map(group => path.join(directory, group, id, 'session.v4.jsonl.zstd')).filter(file => fs.existsSync(file))
    assert.equal(found.length, 1, 'Expected one native log for fixture session ' + id)
    const data = fs.readFileSync(found[0]), chunks = []
    for (let offset = 0; offset < data.length;) {
      const decoded = zstdDecompressSync(data.subarray(offset), { info: true })
      assert(decoded.engine.bytesWritten > 0, 'Native session frame made no progress')
      chunks.push(decoded.buffer.toString('utf8'))
      offset += decoded.engine.bytesWritten
    }
    const events = chunks.join('').split('\n').filter(Boolean).map(JSON.parse)
    return { id, header: events.find(event => event.type === 'session'),
      presets: events.filter(event => event.type === 'permission/preset').map(event => event.data.preset),
      approvals: events.filter(event => event.type === 'approval/policy').map(event => event.data.policy),
      sandboxes: events.filter(event => event.type === 'sandbox/mode').map(event => event.data.mode) }
  })
}

// Reproduce the exact old app bug in this disposable profile, never user data.
function seedLegacyGreeting(roomId, sessionId) {
  assert([roomId, sessionId].every(id => /^[a-zA-Z0-9_-]{1,80}$/.test(id)))
  const sessions = path.join(harnessHome, 'sessions')
  const files = fs.readdirSync(sessions).map(group => path.join(sessions, group, sessionId, 'session.v4.jsonl.zstd')).filter(file => fs.existsSync(file))
  assert.equal(files.length, 1)
  const input = fs.readFileSync(files[0]), frames = []
  for (let offset = 0; offset < input.length;) { const frame = zstdDecompressSync(input.subarray(offset), { info: true }); frames.push(frame.buffer.toString().trim().split('\n').map(JSON.parse)); offset += frame.engine.bytesWritten }
  let changed = 0
  for (const event of frames.flat()) if (event.type === 'user/message' && event.data.source?.origin === 'supercode-host') { delete event.data.role; changed++ }
  assert(changed > 0)
  // The native format reserves its first compressed frame for the header.
  fs.writeFileSync(files[0], Buffer.concat(frames.map(events => zstdCompressSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n')))))
  const journal = path.join(harnessHome, 'supercode/rooms', roomId + '.jsonl')
  const last = JSON.parse(fs.readFileSync(journal, 'utf8').trim().split('\n').at(-1))
  fs.appendFileSync(journal, JSON.stringify({ version: 1, id: roomId, seq: last.seq + 1, kind: 'legacy-fixture', at: Date.now(),
    patch: { status: 'paused', reason: 'The lead did not submit a task plan.', queue: [], startedAt: null },
    unset: ['chatOnly', 'conversationEntry', 'discussionReturn', 'chatInFlight'] }) + '\n')
}

function stream (res, model, delta, finishReason) {
  const base = { id: 'supercode-fixture-' + (++serial), object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }) + '\n\n')
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }) + '\n\n')
  res.end('data: [DONE]\n\n')
}

function modelProgram (model, prompt) {
  // Filled against the public SuperCode tool contract below. All calls execute
  // through DSH's actual run_code transport and filesystem authorization.
  return fixtureProgram(model, prompt)
}

function nativeAction (request, promptIndex, row) {
  const recent = request.messages.slice(promptIndex + 1)
  const calls = recent.flatMap(message => (message.tool_calls || []).map(call => ({
    id: call.id, name: call.function.name, args: JSON.parse(call.function.arguments),
  })))
  const outcomes = calls.map(call => ({ ...call, text: messageText(recent.find(message => message.role === 'tool' && message.tool_call_id === call.id) || {}) }))
  const teamResults = outcomes.filter(item => item.name.startsWith('supercode_') && item.text).map(item => {
    assert(item.text.startsWith('{'), item.name + ' returned a native error: ' + item.text)
    const result = JSON.parse(item.text)
    assert.equal(result.ok, true, 'A real SuperCode tool rejected the fixture action: ' + item.text)
    return result
  })
  const prompt = messageText(request.messages[promptIndex])
  const snapshotText = prompt.split('Current shared room:\n')[1]?.split('\n\n[Host delivery ')[0]
  const snapshot = snapshotText ? JSON.parse(snapshotText) : null
  if (prompt.includes('Mode: chat\n')) {
    assert(['supercode_post', 'supercode_room_read', 'supercode_start_plan'].every(name => row.availableTools.includes(name)), 'Conversation tools must be wired into the actual runtime')
    const user = snapshot.messages.findLast(message => message.kind === 'user')
    if (user.text.includes('QA_CHAT_GUARD_PROBE')) {
      const attempt = outcomes.find(call => call.name === 'read')
      if (!attempt) return { name: 'read', args: { file_path: path.join(workspace, 'README.md') } }
      assert(attempt.text.includes('conversation-only'), 'Native runtime must deny workspace reads during conversation')
      assert(!attempt.text.includes('SuperCode acceptance workspace'), 'A denied read must not disclose workspace contents')
      row.finalText = 'Workspace access stayed blocked.'
      return null
    }
    if (user.text.includes('acceptance.txt') || user.text.includes('SUPERCODE_PAUSE_FIXTURE')) {
      if (!outcomes.some(call => call.name === 'supercode_start_plan')) return { name: 'supercode_start_plan', args: { messageId: user.id } }
      row.finalText = 'I’ll investigate that request and propose a plan before any edits.'
    } else row.finalText = user.text === 'can you help?' ? 'Of course. What would you like help with?' : user.text === 'thanks' ? 'You’re welcome!' : 'Hi! Good to see you.'
    return null
  }
  const room = teamResults.at(-1)?.room
  if (!room) return { name: 'supercode_room_read', args: {} }
  const called = name => outcomes.some(item => item.name === name)
  const model = request.model
  const file = name => path.join(workspace, name)
  if (room.status === 'discussing') {
    if (!called('write')) return { name: 'write', args: { file_path: file('discussion-must-not-write.txt'), content: 'Forbidden discussion write' } }
    assert(!fs.existsSync(file('discussion-must-not-write.txt')), 'A discussion turn obtained write permission')
    row.finalText = room.phase === 'planning' ? 'Discussion answer: the builder will write only after you approve the plan.' : 'Discussion answer: the builder wrote acceptance.txt and the reviewer independently checked it.'
    return null
  }
  // Terminal tool intent still needs a genuine native turn settlement. The
  // host may keep its workspace lease until this final assistant response.
  if (called('supercode_plan_ready') || called('supercode_finish')) return null
  if (room.phase === 'planning') {
    if (messageText(request.messages[promptIndex]).includes('Answer the addressed')) {
      if (!called('supercode_post')) return { name: 'supercode_post', args: model === 'fixture-builder'
        ? { text: 'Peer reply: I will preserve the exact single-line acceptance content.', recipient: 'reviewer' }
        : { text: 'Peer agreement: the exact content is now clear before plan approval.' } }
      return null
    }
    if (model === 'fixture-lead') {
      if (!room.tasks.length) {
        const owner = room.members.find(member => member.model === 'fixture-builder')
        assert(owner, 'Builder model identity missing from the real room')
        return { name: 'supercode_task', args: { operation: 'propose', title: 'Create and independently verify acceptance.txt', ownerId: owner.id, dependencies: [], criteria: 'acceptance.txt contains exactly the requested single line and an independent reviewer verifies its contents.' } }
      }
      if (!called('supercode_post')) return { name: 'supercode_post', args: { text: richPlan } }
      return { name: 'supercode_plan_ready', args: {} }
    }
    if (!called('read')) return { name: 'read', args: { file_path: file('README.md') } }
    assert(outcomes.find(item => item.name === 'read').text.includes('acceptance.txt'), 'Native investigation did not return README.md contents')
    if (!called('supercode_post')) return { name: 'supercode_post', args: model === 'fixture-builder'
      ? { text: 'I inspected README.md. I can create acceptance.txt after plan approval.' }
      : { text: 'Builder, will you preserve the exact single-line acceptance content?', recipient: 'builder' } }
    return null
  }
  if (model === 'fixture-builder') {
    const task = room.tasks.find(task => task.ownerId === room.members.find(member => member.model === model)?.id)
    assert(task, 'The real board has no task assigned to the builder')
    if (!called('write')) {
      assert.equal(task.status, 'working')
      return { name: 'write', args: { file_path: file('acceptance.txt'), content: expectedFile } }
    }
    const written = outcomes.find(item => item.name === 'write').text
    assert(written.includes('acceptance.txt') && /Created file|Updated file/.test(written), 'Native filesystem write did not report success: ' + written)
    row.verifiedResults = ['SUPERCODE_WRITE_OK']
    if (!called('supercode_task')) return { name: 'supercode_task', args: { operation: 'submit', taskId: task.id, revision: task.revision, evidence: ['Created acceptance.txt through the native filesystem write tool with the exact requested content.'] } }
    return null
  }
  if (model === 'fixture-reviewer') {
    const reviewer = room.members.find(member => member.model === model)
    const task = room.tasks.find(task => task.status === 'review' && task.reviewerId === reviewer?.id)
    assert(task, 'The real board has no task assigned to the independent reviewer')
    if (!called('read')) return { name: 'read', args: { file_path: file('acceptance.txt') } }
    const actual = outcomes.find(item => item.name === 'read').text
    assert(actual.includes('1: ' + expectedFile.trim()) && actual.includes('total 1 lines'), 'Independent native read returned incorrect file contents: ' + actual)
    row.verifiedResults = ['SUPERCODE_READ_OK']
    if (!called('supercode_review')) return { name: 'supercode_review', args: { taskId: task.id, revision: task.revision, verdict: 'pass', evidence: ['Read acceptance.txt independently using the native filesystem read tool.', 'Verified the exact requested single-line content.'] } }
    return null
  }
  assert.equal(model, 'fixture-lead')
  const ready = room.tasks.find(task => task.status === 'review' && task.review?.verdict === 'pass')
  if (ready) return { name: 'supercode_task', args: { operation: 'accept', taskId: ready.id, revision: ready.revision } }
  assert(room.tasks.length && room.tasks.every(task => ['done', 'cancelled'].includes(task.status)), 'Lead cannot finish without accepted independent reviews')
  return { name: 'supercode_finish', args: { summary: 'The builder created acceptance.txt, the reviewer independently read its exact content, and the lead accepted the passing review.' } }
}

const server = http.createServer(async (req, res) => {
  openResponses.add(res)
  res.once('close', () => openResponses.delete(res))
  try {
    if (req.method === 'GET' && req.url === '/__qa/state') return json(res, 200, { hostURL, workspace, harnessHome, modelIds, expectedFile, transcript, fixtureErrors })
    if (req.method === 'POST' && req.url === '/__qa/release-progress') {
      await body(req)
      assert(releaseProgress, 'No actual model response is waiting at the public-progress gate')
      progressReleased = true
      releaseProgress()
      releaseProgress = null
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && req.url === '/__qa/policies') return json(res, 200, sessionPolicies((await body(req)).sessionIds))
    if (req.method === 'POST' && req.url === '/__qa/restart') {
      const options = await body(req)
      await stopHost(options.crash ? 'SIGKILL' : 'SIGTERM')
      await startHost()
      return json(res, 200, { hostURL })
    }
    if (req.method === 'POST' && req.url === '/__qa/legacy-restart') {
      const options = await body(req)
      await stopHost(); seedLegacyGreeting(options.roomId, options.sessionId); await startHost()
      return json(res, 200, { hostURL })
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return json(res, 404, { error: 'Unknown local fixture endpoint' })
    const request = await body(req)
    assert(modelIds.includes(request.model), 'Unexpected model requested: ' + request.model)
    const messages = request.messages || []
    const promptIndex = messages.findLastIndex(message => messageText(message).includes('[SuperCode host task]'))
    const prompt = promptIndex < 0 ? '' : messageText(messages[promptIndex])
    const results = messages.slice(promptIndex + 1).filter(message => message.role === 'tool').map(message => messageText(message))
    const row = { index: transcript.length + 1, model: request.model, reasoningEffort: request.reasoning_effort, prompt, availableTools: (request.tools || []).map(tool => tool.function?.name), receivedToolResults: results, response: null }
    if (!prompt) row.unexpectedMessages = messages.filter(message => message.role !== 'system').map(message => ({ role: message.role, text: messageText(message).slice(-4000) }))
    transcript.push(row)
    if (transcript.length > 80) throw new Error('Fixture exceeded its 80-request safety bound')
    assert(prompt && !messages.some(message => messageText(message).startsWith('REVIEW_POLICY')), 'Unexpected auxiliary model request outside the scheduled SuperCode team')
    if (prompt.includes('SUPERCODE_PAUSE_FIXTURE') && !prompt.includes('Mode: chat\n')) {
      row.response = 'held-for-user-pause'
      writeTranscript()
      // Remain pending until the real Pause command aborts the runtime request.
      return
    }
    if (!row.availableTools.includes('run_code')) {
      const action = nativeAction(request, promptIndex, row)
      row.response = action ? 'native-tool' : 'final'
      if (action) {
        assert(row.availableTools.includes(action.name), 'Native tool was not advertised: ' + action.name)
        row.issuedTool = action
        if (action.name === 'write' && request.model === 'fixture-builder' && action.args.file_path.endsWith('/acceptance.txt')) row.publicText = 'Builder is writing acceptance.txt through the native filesystem tool.'
        else if (action.name === 'read' && action.args.file_path.endsWith('/acceptance.txt')) row.publicText = 'Reviewer is independently reading acceptance.txt before issuing a verdict.'
        else if (action.name === 'supercode_task' && action.args.operation === 'propose') row.publicText = 'Lead is converting the investigation into a task for approval.'
      }
      writeTranscript()
      if (!progressReleased && request.model === 'fixture-builder' && action?.name === 'supercode_task' && action.args.operation === 'submit') {
        row.response = 'held-after-public-progress'
        writeTranscript()
        // Keep a genuine provider request pending so the browser can verify the
        // prior assistant text is already public while the native task is active.
        await new Promise(resolve => { releaseProgress = resolve })
        row.response = 'native-tool'
        writeTranscript()
      }
      return stream(res, request.model, action ? { ...(row.publicText ? { content: row.publicText } : {}), tool_calls: [{ index: 0, id: 'call-fixture-' + (serial + 1), type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : { content: row.finalText || 'SuperCode fixture step completed.' }, action ? 'tool_calls' : 'stop')
    }
    if (results.length) {
      row.response = 'final'
      writeTranscript()
      return stream(res, request.model, { content: 'SuperCode fixture step completed.' }, 'stop')
    }
    assert(row.availableTools.includes('run_code'), 'The native SuperCode agent must expose its run_code transport')
    const code = modelProgram(request.model, prompt)
    row.response = 'run_code'
    row.program = code
    writeTranscript()
    return stream(res, request.model, { tool_calls: [{ index: 0, id: 'call-fixture-' + (serial + 1), type: 'function', function: { name: 'run_code', arguments: JSON.stringify({ code, description: 'Perform the SuperCode acceptance step using real tools' }) } }] }, 'tool_calls')
  } catch (error) {
    fixtureErrors.push(error.stack || String(error))
    writeTranscript()
    if (!res.headersSent) json(res, 400, { error: { message: error.message, type: 'fixture_error' } })
    else res.destroy(error)
  }
})

function fixtureProgram (model) {
  const readme = JSON.stringify(path.join(workspace, 'README.md'))
  const target = JSON.stringify(path.join(workspace, 'acceptance.txt'))
  const content = JSON.stringify(expectedFile)
  const shared = `
const checked = value => { if (value?.ok === false) throw new Error(JSON.stringify(value)); return value; };
const snapshot = checked(await tools.supercode_room_read({}));
const room = snapshot.room;
if (!room) throw new Error('Missing real room snapshot');
`
  if (model === 'fixture-lead') return shared + `
if (room.phase === 'planning') {
  const owner = room.members.find(member => member.model === 'fixture-builder');
  if (!owner) throw new Error('Builder model identity is missing');
  checked(await tools.supercode_task({ operation: 'propose', title: 'Create and independently verify acceptance.txt', ownerId: owner.id, dependencies: [], criteria: 'acceptance.txt contains exactly the requested single line and an independent reviewer verifies its contents.' }));
  checked(await tools.supercode_post({ text: 'The builder will create acceptance.txt after approval. The reviewer will independently read it, and I will accept only a passing review.' }));
  return checked(await tools.supercode_plan_ready({}));
}
for (const task of room.tasks.filter(task => task.status === 'review' && task.review?.verdict === 'pass')) {
  checked(await tools.supercode_task({ operation: 'accept', taskId: task.id, revision: task.revision }));
}
const current = checked(await tools.supercode_room_read({})).room;
if (current.tasks.length && current.tasks.every(task => ['done', 'cancelled'].includes(task.status))) {
  return checked(await tools.supercode_finish({ summary: 'The builder created acceptance.txt, the reviewer independently read its exact content, and the lead accepted the passing review.' }));
}
return checked(await tools.supercode_post({ text: 'Waiting for the assigned work and independent review.', recipient: 'team' }));
`
  if (model === 'fixture-builder') return shared + `
if (room.phase === 'planning') {
  const read = await tools.read({ file_path: ${readme} });
  if (!JSON.stringify(read).includes('acceptance.txt')) throw new Error('Workspace investigation did not read README.md');
  return checked(await tools.supercode_post({ text: 'I inspected README.md. I can create the requested acceptance.txt after plan approval.' }));
}
const owner = room.members.find(member => member.model === 'fixture-builder');
const task = room.tasks.find(task => task.ownerId === owner?.id && task.status === 'working');
if (!task) throw new Error('No working task belongs to this builder');
const written = await tools.write({ file_path: ${target}, content: ${content} });
if (written.after !== ${content}) throw new Error('Native filesystem write did not return the requested content');
console.log('SUPERCODE_WRITE_OK: ' + written.path);
return checked(await tools.supercode_task({ operation: 'submit', taskId: task.id, revision: task.revision, evidence: ['Created acceptance.txt through the native filesystem write tool with the exact requested content.'] }));
`
  assert.equal(model, 'fixture-reviewer')
  return shared + `
if (room.phase === 'planning') {
  const read = await tools.read({ file_path: ${readme} });
  if (!JSON.stringify(read).includes('acceptance.txt')) throw new Error('Reviewer investigation did not read README.md');
  return checked(await tools.supercode_post({ text: 'I inspected README.md. I will read the completed file independently and verify its exact content before passing the task.' }));
}
const reviewer = room.members.find(member => member.model === 'fixture-reviewer');
const task = room.tasks.find(task => task.status === 'review' && task.reviewerId === reviewer?.id);
if (!task) throw new Error('No review task is assigned to this independent reviewer');
const read = await tools.read({ file_path: ${target} });
const actual = (read.lines || []).map(line => line.text).join('\\n') + '\\n';
if (actual !== ${content}) throw new Error('Independent reviewer found incorrect file contents: ' + JSON.stringify(read));
console.log('SUPERCODE_READ_OK: ' + read.path);
return checked(await tools.supercode_review({ taskId: task.id, revision: task.revision, verdict: 'pass', evidence: ['Read acceptance.txt independently using the native filesystem read tool.', 'Verified the exact requested single-line content.'] }));
`
}

function childEnvironment () {
  // Do not give the disposable host credentials from the invoking shell.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)))
  return { ...env, DSH_HOME: harnessHome, DSH_DESKTOP_USER_DATA: qaRoot, DSHD_HOST_LOG: '1', DSH_QA_FIXTURE_KEY: 'local-fixture-only' }
}

async function startHost () {
  const pluginRoot = installedHarness ? path.join(installedHarness, 'node_modules', '@dsh-desktop') : path.join(source, 'plugins')
  const pkgs = Object.fromEntries(fs.readdirSync(pluginRoot).filter(name => fs.existsSync(path.join(pluginRoot, name, 'package.json'))).map(name => {
    const dir = path.join(pluginRoot, name)
    return [require(path.join(dir, 'package.json')).name, dir]
  }))
  assert(pkgs['@dsh-desktop/client-ui-supercode'], 'SuperCode plugin is not present')
  if (pluginOverride) {
    assert.equal(require(path.join(pluginOverride, 'package.json')).name, '@dsh-desktop/client-ui-supercode')
    pkgs['@dsh-desktop/client-ui-supercode'] = pluginOverride
    pkgs['@dsh-desktop/client-ui-theme-holo'] = path.join(path.dirname(pluginOverride), 'client-ui-theme-holo')
  }
  const profile = require(path.join(runtimeAnchor, 'src/profile.cjs')).ensureProfile(harnessHome, runtimeAnchor, pkgs)
  hostURL = null
  host = spawn(runtimeNode, ['--expose-internals', path.join(runtimeAnchor, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', profile.name, '--port', '0', '--no-open'], { cwd: installedHarness || source, env: { ...childEnvironment(), ...(process.env.DSH_QA_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  const startingHost = host
  return new Promise((resolve, reject) => {
    let pending = ''
    const timer = setTimeout(() => reject(new Error(`DSH host did not announce its URL within ${startupTimeout / 1000} seconds`)), startupTimeout)
    const output = data => {
      const text = String(data)
      fs.appendFileSync(path.join(qaRoot, 'host.log'), text.replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]'))
      pending = (pending + text).slice(-50000)
      if (/desktop-supercode [^\n]*: \w*Error:/.test(pending)) {
        clearTimeout(timer)
        reject(new Error('SuperCode failed to activate. See ' + path.join(qaRoot, 'host.log')))
        return
      }
      const found = pending.match(/dsh web: (\S+)/)
      if (found && !hostURL) { hostURL = found[1]; clearTimeout(timer); resolve(hostURL) }
    }
    startingHost.stdout.on('data', output)
    startingHost.stderr.on('data', output)
    startingHost.once('error', error => { clearTimeout(timer); reject(error) })
    startingHost.once('exit', code => {
      clearTimeout(timer)
      if (!hostURL) reject(new Error('DSH host exited before startup: ' + code))
    })
  })
}

async function stopHost (signal = 'SIGTERM') {
  const old = host
  host = null
  if (!old || old.exitCode !== null || old.signalCode !== null) return
  old.kill(signal)
  const force = setTimeout(() => old.kill('SIGKILL'), 5000)
  await once(old, 'exit')
  clearTimeout(force)
  // A worker inherited these pipes before a deliberately crashed host exited.
  // They are diagnostic streams, not evidence that the host is still running.
  old.stdout.destroy()
  old.stderr.destroy()
}

async function finish (code) {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(deadline)
  probe?.kill('SIGTERM')
  await stopHost()
  for (const res of openResponses) res.destroy()
  server.close()
  // The deliberate pending model replies can leave aborted keep-alive sockets
  // behind after a crash test. Close this fixture's connections, never the app.
  server.closeAllConnections()
  writeTranscript()
  process.exitCode = code
}

const deadline = setTimeout(() => { console.error('SuperCode acceptance exceeded five minutes'); finish(1) }, 300000)
process.once('SIGINT', () => finish(130))
process.once('SIGTERM', () => finish(143))
server.once('error', error => { console.error(error.message); finish(1) })

server.listen(0, '127.0.0.1', async () => {
  try {
    const localURL = `http://127.0.0.1:${server.address().port}`
    fs.writeFileSync(path.join(harnessHome, 'settings.yaml'), JSON.stringify({
      'llm-pi-ai': { providers: { fixture: { displayName: 'SuperCode Local Fixture', api: 'openai-completions', baseURL: localURL + '/v1', apiKeyEnv: 'DSH_QA_FIXTURE_KEY', models: modelIds.map(id => ({ id, name: id, contextWindow: 64000, maxTokens: 4000, input: ['text'], reasoningEfforts: id === 'fixture-lead' ? { low: 'low', high: 'high' } : false })) } } },
      'agent-default-model': { provider: 'fixture', model: modelIds[0] },
      'agent-presets': { default: 'dsh-agent' },
      'ui-theme': { preference: 'dark' },
      'desktop-model-visibility': { selections: { fixture: modelIds } },
      'workspace-controller': { documentsDirectory: qaRoot },
    }), { mode: 0o600 })
    await startHost()
    probe = spawn('python3', ['-u', path.join(__dirname, 'supercode-smoke.py')], { env: { ...childEnvironment(), DSH_QA_URL: hostURL, DSH_SUPERCODE_QA_CONTROL: localURL, DSH_SUPERCODE_QA_ROOT: qaRoot, DSH_SUPERCODE_QA_WORKSPACE: workspace }, stdio: ['ignore', 'pipe', 'pipe'] })
    const redact = data => String(data).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]')
    probe.stdout.on('data', data => process.stdout.write(redact(data)))
    probe.stderr.on('data', data => process.stderr.write(redact(data)))
    probe.once('error', error => { console.error(error.message); finish(1) })
    probe.once('exit', code => finish(code ?? 1))
  } catch (error) {
    console.error(error.stack || String(error))
    await finish(1)
  }
})
