'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const {execFile, spawn} = require('node:child_process')
const {promisify} = require('node:util')
const {createHash} = require('node:crypto')
const runFile = promisify(execFile)

const TOOLS = ['node', 'npm', 'pnpm', 'yarn', 'python3', 'python', 'git']
const INSTALL_URLS = Object.freeze({
  node: 'https://nodejs.org/en/download', npm: 'https://nodejs.org/en/download',
  python3: 'https://www.python.org/downloads/', python: 'https://www.python.org/downloads/',
  git: 'https://git-scm.com/downloads',
  corepack: 'https://yarnpkg.com/corepack',
})
async function executable(name, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name)
    try { await fs.access(candidate, 1); if ((await fs.stat(candidate)).isFile()) return candidate } catch {}
  }
  return null
}
async function probe(name, env, run = runFile) {
  const command = await executable(name, env)
  if (!command) return {id:name, installed:false}
  try {
    // /usr/bin/git is a macOS installer stub when Command Line Tools are absent.
    if (process.platform === 'darwin' && command === '/usr/bin/git') await run('/usr/bin/xcode-select', ['-p'], {env, timeout:5000})
    const result = await run(command, ['--version'], {env, timeout:5000, maxBuffer:32768})
    return {id:name, installed:true, command, version:String(result.stdout || result.stderr).trim().split('\n')[0]}
  } catch (error) { return {id:name, installed:false, command, error:error.code === 'ETIMEDOUT' ? 'Version check timed out.' : 'Installed command could not run.'} }
}
async function readProject(root, name, content=true) {
  const target = path.join(root, name)
  try {
    const real = await fs.realpath(target)
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error(name + ' points outside this workspace.')
    if (!content) return true
    if ((await fs.stat(real)).size > 1024 * 1024) throw new Error(name + ' is too large to inspect.')
    return await fs.readFile(real, 'utf8')
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function exists(file) { try { await fs.access(file); return true } catch { return false } }
async function inspect(root, {env=process.env, run=runFile} = {}) {
  const tools = await Promise.all(TOOLS.map(name => probe(name, env, run)))
  const python = tools.find(t => t.id === 'python3' && t.installed) || tools.find(t => t.id === 'python' && t.installed && /Python 3\./.test(t.version))
  const result = {tools, pythonCommand:python?.command || null, project:null,
    bundled:['Electron and the harness runtime', 'DSH plugins and native app libraries', 'Computer driver on supported macOS builds']}
  if (!root) return result
  root = await fs.realpath(root)
  const raw = await readProject(root, 'package.json')
  let js = null
  if (raw !== null) {
    let pkg; try { pkg = JSON.parse(raw) } catch { throw new Error('package.json is not valid JSON.') }
    const locks = []
    for (const [file,manager] of [['package-lock.json','npm'],['npm-shrinkwrap.json','npm'],['pnpm-lock.yaml','pnpm'],['yarn.lock','yarn']]) {
      if (await readProject(root,file,false) !== null && !locks.includes(manager)) locks.push(manager)
    }
    const declared = typeof pkg.packageManager === 'string' ? /^(npm|pnpm|yarn)@(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\+sha\d+\.[a-fA-F0-9]+)?$/.exec(pkg.packageManager) : null
    const unsupported = Boolean(pkg.packageManager && !declared)
    const ambiguous = locks.length > 1 || Boolean(declared && locks.some(m => m !== declared[1]))
    const manager = declared?.[1] || (locks.length === 1 ? locks[0] : 'npm')
    const hasPackages = ['dependencies','devDependencies','optionalDependencies'].some(key=>Object.keys(pkg[key] || {}).length>0)
    js = {hasPackages,manager, requestedVersion:declared?.[2] || null, ambiguous, unsupported, choices:['npm','pnpm','yarn'],
      installed:await exists(path.join(root,'node_modules')), nodeRequirement:pkg.engines?.node || null}
  }
  const requirements = await readProject(root,'requirements.txt')
  const pyproject = await readProject(root,'pyproject.toml')
  const pythonProject = requirements !== null || pyproject !== null
  const venvPython = path.join(root,'.venv','bin','python')
  result.project = {root, js, python:pythonProject ? {kind:requirements !== null ? 'requirements' : 'pyproject', environment:await exists(venvPython), command:await exists(venvPython) ? venvPython : python?.command || null} : null}
  return result
}

async function plan(root, task, choice, options={}) {
  const state = await inspect(root, options)
  root = state.project?.root || root
  const tool = name => state.tools.find(t => t.id === name && t.installed)
  const steps = []
  if (task === 'javascript') {
    const js = state.project?.js
    if (!js) throw new Error('This workspace has no package.json.')
    if (js.unsupported) throw new Error('This packageManager declaration is not supported. Use the project’s documented setup.')
    if (js.ambiguous && !js.choices.includes(choice)) throw new Error('Choose a package manager for the conflicting project configuration.')
    const manager = js.ambiguous ? choice : js.manager
    const command = tool(manager)
    if (!command) throw new Error('Install ' + manager + ' first, then check again.')
    if (js.requestedVersion && manager === js.manager && (command.version.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/) || [])[0] !== js.requestedVersion) throw new Error('This project requests ' + manager + ' ' + js.requestedVersion + '. Install that version first.')
    steps.push({command:command.command, args:['install'], cwd:root})
  } else if (task === 'python-project') {
    if (!state.project?.python) throw new Error('No requirements.txt or pyproject.toml was found.')
    if (!state.pythonCommand) throw new Error('Install Python 3 first, then check again.')
    const venv = path.join(root,'.venv')
    if (await exists(venv)) {
      const real = await fs.realpath(venv)
      if (real !== venv) throw new Error('.venv must be a local project directory, not a link.')
      if (!(await exists(path.join(venv,'pyvenv.cfg')))) throw new Error('.venv already exists but is not a Python environment. Choose a clean environment manually.')
    } else steps.push({command:state.pythonCommand,args:['-m','venv','.venv'],cwd:root})
    steps.push({command:path.join(venv,'bin','python'),args:['-m','pip','install',...(state.project.python.kind === 'requirements' ? ['-r','requirements.txt'] : ['.'])],cwd:root})
    steps.push({command:path.join(venv,'bin','python'),args:['-m','pip','check'],cwd:root})
  } else if (task === 'pnpm' || task === 'yarn') {
    if (!options.toolsDir) throw new Error('Desktop tool installation is unavailable.')
    if (!tool('npm')) throw new Error('Install Node.js and npm first.')
    const requested = state.project?.js?.manager === task ? state.project.js.requestedVersion : null
    // Yarn 1 is the npm distribution; modern Yarn projects own their pinned CLI.
    if (task === 'yarn' && requested && Number(requested.split('.')[0]) > 1) throw new Error('This project uses modern Yarn. Follow its Corepack setup instructions, then check again.')
    steps.push({command:tool('npm').command,args:['install','--prefix',options.toolsDir,task + '@' + (requested || (task === 'yarn' ? '1' : 'latest'))],cwd:options.toolsDir})
  } else throw new Error('Unknown setup task.')
  const fingerprint = createHash('sha256')
  if (root) for (const name of ['package.json','requirements.txt','pyproject.toml']) fingerprint.update(name + ':' + (await readProject(root,name) || ''))
  return {task, root, steps, fingerprint:fingerprint.digest('hex'), summary:steps.map(s => [s.command,...s.args].map(x => JSON.stringify(x)).join(' ')).join('\n')}
}

function createRunner({spawnProcess=spawn}={}) {
  let job = null, child = null, active = false
  const status = () => job ? {...job} : {state:'idle',output:''}
  async function start(reviewed, env) {
    if (active) throw new Error('A setup task is already running.')
    active = true
    job = {state:'running', task:reviewed.task, root:reviewed.root, output:'', startedAt:Date.now()}
    const current = job
    const append = data => { current.output = (current.output + String(data)).slice(-48000) }
    void (async () => {
      try {
        for (const step of reviewed.steps) {
          if (current.state !== 'running') return
          if (['pnpm','yarn'].includes(reviewed.task)) await fs.mkdir(step.cwd,{recursive:true})
          else await fs.access(step.cwd)
          append('\n$ ' + [step.command,...step.args].join(' ') + '\n')
          await new Promise((resolve,reject) => {
            child = spawnProcess(step.command,step.args,{cwd:step.cwd,env:{...env,CI:'1',PIP_NO_INPUT:'1',PIP_DISABLE_PIP_VERSION_CHECK:'1',npm_config_yes:'true'},stdio:['ignore','pipe','pipe'],detached:process.platform !== 'win32'})
            child.stdout?.on('data',append); child.stderr?.on('data',append)
            child.on('error',reject)
            child.on('close',code => {child=null;code === 0 ? resolve() : reject(new Error('Installation exited with code ' + code + '.'))})
          })
        }
        if (current.state === 'running') current.state = 'complete'
      } catch (error) { if (current.state === 'running') {current.state='failed';current.error=error.message} } finally {active=false}
    })()
    return status()
  }
  function cancel() {
    if (job?.state === 'running') job.state='cancelled'
    const pid = child?.pid
    if (pid) {
      try { process.kill(process.platform === 'win32' ? pid : -pid,'SIGTERM') } catch {}
      const timer=setTimeout(() => { if(child?.pid===pid) {try {process.kill(process.platform === 'win32' ? pid : -pid,'SIGKILL')} catch {}} },2000)
      timer.unref?.()
    }
    return status()
  }
  return {start,status,cancel}
}
module.exports = {inspect, plan, createRunner, INSTALL_URLS, executable}
