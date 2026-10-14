// Disposable, credential-free end-to-end migration fixture.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http')
const { spawn } = require('node:child_process')
const root = process.env.DSH_QA_SOURCE || path.resolve(__dirname, '../..')
const installedHarness = process.env.DSH_QA_HARNESS && path.resolve(process.env.DSH_QA_HARNESS)
const runtimeAnchor = installedHarness || path.join(root, 'shell')
const apiForms = process.env.DSH_QA_API_FORMS === '1'
require('../native-conversation-delegate.cjs').prepareDevelopment(root)
// Packaged shells deliberately ignore developer-only userData overrides.
// Refuse that mode before launch; verify installed UI manually and its runtime
// through supercode-smoke.cjs, which supplies an isolated harness home itself.
if (process.env.DSH_QA_ELECTRON_APP) throw new Error('Packaged native UI does not support disposable profiles; use manual installed-app checks.')
const qaData = fs.mkdtempSync('/tmp/dsh-upgrade-chat-native-')
const home = process.env.DSH_QA_HOME || (process.env.DSH_QA_ELECTRON ? path.join(qaData, 'harness') : fs.mkdtempSync('/tmp/dsh-upgrade-chat-'))
if (!home.startsWith('/tmp/dsh-upgrade-chat-')) throw new Error('Disposable QA home required')
console.log('QA_HOME:', home)
const fixtureRoot = path.join(qaData, 'deepseek-harness/default-workspace')
if (process.env.DSH_QA_ELECTRON) {
  fs.mkdirSync(fixtureRoot, {recursive:true})
  require('node:child_process').execFileSync('git', ['init','--quiet',fixtureRoot])
  fs.writeFileSync(path.join(fixtureRoot,'fixture.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64'))
}
const answer = 'Migration fixture completed.\n\n```text\ncopy-fixture-ok\n```' + (process.env.DSH_QA_ELECTRON ? `\n\n![Fixture](${fixtureRoot}/fixture.png)` : '')
const keyChecks = { a: 0, b: 0, rejected: 0 }
const mock = http.createServer(async (req, res) => {
  if (apiForms && req.url === '/__qa/key-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(keyChecks))
  }
  if (apiForms && /\/(a|b)\/v1\/models$/.test(req.url)) {
    const id = req.url.split('/')[1], accepted = req.headers.authorization === `Bearer local-test-key-${id}-not-a-secret`
    if (accepted) keyChecks[id]++; else keyChecks.rejected++
    res.writeHead(accepted ? 200 : 401, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(accepted ? { object: 'list', data: [{ id: `api-fixture-${id}`, object: 'model', owned_by: 'local-fixture' }] } : { error: { message: 'Fixture authentication failed' } }))
  }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end('<html><body><h1>Game ' + (req.url === '/two' ? 'Two' : 'One') + '</h1><button onclick="this.textContent=\'Played\'">Play</button></body></html>')
  }
  for await (const _ of req) {}
  const base = { id: 'fixture-answer', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: 'fixture' }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const item of [
    { choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } },
  ]) res.write('data: ' + JSON.stringify({ ...base, ...item }) + '\n\n')
  res.end('data: [DONE]\n\n')
})
mock.listen(0, '127.0.0.1', () => {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  // Use the OLD settings format, so this tests migration and a real chat together.
  const settings = {
    'llm-pi-ai': { providers: { fixture: { displayName: 'QA Fixture', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${mock.address().port}/v1`, apiKeyEnv: 'DSH_QA_FIXTURE_KEY',
      models: [{ id: 'fixture', name: 'Fixture', contextWindow: 32000, maxTokens: 2000, input: ['text'], reasoningEfforts: false }] } } },
    'agent-default-model': { provider: 'fixture', model: 'fixture' },
    'agent-presets': { default: 'dsh-agent' }, 'ui-theme': { preference: 'dark' },
    'desktop-model-visibility': { selections: { fixture: ['fixture'] } },
    ...(process.env.DSH_QA_ELECTRON ? { 'workspace-controller': { documentsDirectory: qaData } } : {}),
  }
  const patchFile = path.join(home, 'profiles/dsh-pro/cordis.patch.yml')
  if (fs.existsSync(path.join(home, 'profiles/dsh-pro/.settings-v2-migrated'))) {
    const yaml = require('../../shell/src/upstream-migration.cjs').parser(root + '/shell')
    const rows = yaml.load(fs.readFileSync(patchFile, 'utf8'))
    rows.find(row => row.id === 'llm-pi-ai').config.providers.fixture.baseURL = settings['llm-pi-ai'].providers.fixture.baseURL
    fs.writeFileSync(patchFile, yaml.dump(rows), {mode:0o600})
  } else fs.writeFileSync(path.join(home, 'settings.yaml'), JSON.stringify(settings), { mode: 0o600 })
  const native = Boolean(process.env.DSH_QA_ELECTRON)
  let profile
  if (!native) {
    const plugins = installedHarness ? path.join(installedHarness, 'node_modules/@dsh-desktop') : path.join(root, 'plugins')
    const pkgs = Object.fromEntries(fs.readdirSync(plugins).map(name => {
      const p = path.join(plugins, name); return [require(p + '/package.json').name, p]
    }))
    profile = require(path.join(runtimeAnchor, 'src/profile.cjs')).ensureProfile(home, runtimeAnchor, pkgs)
  }
  // Native runs must let the real shell create its own profile/link farm.
  // Pre-linking all plugins here would hide omissions in resolveDesktopPlugins.
  const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)))
  const child = spawn(native ? path.join(root, 'shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : process.env.DSH_QA_NODE || process.execPath, native ? [path.join(root, 'shell'), '--remote-debugging-port=9342'] : ['--expose-internals', path.join(runtimeAnchor, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', profile.name, '--port', '0', '--no-open'], {
    cwd: root, env: { ...fixtureEnv, ...(!native && process.env.DSH_QA_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}), DSH_HOME: home, DSH_DESKTOP_USER_DATA: qaData, DSHD_HOST_LOG: '1', DSH_QA_FIXTURE_KEY: 'local-fixture-only' }, stdio: ['ignore','pipe','pipe'],
  })
  let pending = '', probe
  const finish = code => { clearTimeout(timer); child.kill('SIGTERM'); mock.close(); process.exitCode = code }
  // The two-provider journey includes cold translated-runtime startup on Mac.
  const timer = setTimeout(() => { probe?.kill('SIGTERM'); finish(1) }, native || apiForms ? 240000 : 90000)
  child.stderr.on('data', data => process.stderr.write(String(data).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]')))
  child.stdout.on('data', data => {
    process.stdout.write(String(data).replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]'))
    pending += data
    const found = pending.match(native ? /window loaded (\S+)/ : /dsh web: (\S+)/)
    if (!found || probe) return
    probe = spawn('python3', ['-u', __dirname + (apiForms ? '/api-key-forms-smoke.py' : native ? '/upstream-native-smoke.py' : process.env.DSH_QA_RESTORE ? '/upstream-restore-smoke.py' : '/upstream-chat-smoke.py')], { env: { ...fixtureEnv, DSH_QA_URL: found[1], DSH_QA_GAME_URL: `http://127.0.0.1:${mock.address().port}`, DSH_QA_HOME: home, DSH_QA_ARTIFACTS: qaData }, stdio: 'inherit' })
    probe.once('exit', code => finish(code || 0))
  })
  child.once('exit', code => { if (!probe) finish(code || 1) })
})
