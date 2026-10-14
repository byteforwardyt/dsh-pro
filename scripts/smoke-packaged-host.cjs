'use strict'
// Exercise the shipped runtime, not the development dependency graph. The URL
// is printed before patch watchers start, so readiness alone is insufficient.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { ensureProfile, PROFILE_NAME } = require('../shell/src/profile.cjs')
const { inheritedEnv } = require('../shell/src/host-process.cjs')

async function smokePackagedHost (runtime, harness) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-packaged-smoke-'))
  const modules = path.join(harness, 'node_modules')
  const plugins = Object.fromEntries(fs.readdirSync(path.join(modules, '@dsh-desktop'))
    .map(name => [`@dsh-desktop/${name}`, path.join(modules, '@dsh-desktop', name)]))
  let child
  try {
    ensureProfile(home, harness, plugins)
    await new Promise((resolve, reject) => {
      let output = ''
      let launchUrl
      let stableTimer
      let checking = false
      let finished = false
      const finish = error => {
        if (finished) return
        finished = true
        clearTimeout(deadline)
        clearTimeout(stableTimer)
        error ? reject(error) : resolve()
      }
      const deadline = setTimeout(() => finish(new Error(`Host startup timed out\n${output}`)), 90000)
      child = spawn(runtime, ['--expose-internals', path.join(modules, '@deepseek-ai/dsh/lib/bin.js'),
        '--profile', PROFILE_NAME, '--port', '0', '--no-open'], {
        cwd: home,
        env: { ...inheritedEnv(), ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home, DSH_WEB_MODE: 'desktop' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const consume = bytes => {
        // Keep the bootstrap secret private while exercising real authentication.
        const ready = bytes.toString().match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)
        if (ready) launchUrl = ready[1]
        output = (output + bytes.toString().replace(/([?&]token=)[^\s&]+/g, '$1[redacted]')).slice(-16000)
        const match = output.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)/)
        if (!match || checking) return
        checking = true
        stableTimer = setTimeout(async () => {
          try {
            if (!launchUrl) throw new Error('Packaged host did not emit an authenticated launch URL')
            const bootstrap = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
            const cookie = bootstrap.headers.getSetCookie().find(value => value.startsWith('dsh-auth-'))?.split(';')[0]
            if (!cookie) throw new Error('Packaged host did not issue its bootstrap authentication cookie')
            const response = await fetch(match[1], { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) })
            if (!response.ok || !(await response.text()).includes('<html')) {
              throw new Error(`Packaged host did not serve the app: HTTP ${response.status}`)
            }
            finish()
          } catch (error) { finish(error) }
        }, 10000)
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('error', finish)
      child.once('exit', (code, signal) => finish(new Error(`Packaged host exited (${code ?? signal})\n${output}`)))
    })
    console.log('Packaged host smoke PASS: survived startup + 10s; authenticated app HTTP 200')
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
        child.kill('SIGTERM')
      })
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}

module.exports = { smokePackagedHost }
if (require.main === module) {
  const [runtime, harness] = process.argv.slice(2)
  if (!runtime || !harness) throw new Error('Usage: node scripts/smoke-packaged-host.cjs <runtime> <harness-directory>')
  smokePackagedHost(path.resolve(runtime), path.resolve(harness)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
