'use strict'
const path = require('node:path')
const fs = require('node:fs/promises')

/** The renderer names a task, never a command. Only this main-process handler
 * can approve execution, and roots come from the host's workspace registry. */
function createSetupHandler({runtime, getRoots, getEnv, toolsDir, confirm, openExternal}) {
  const runner = runtime.createRunner()
  let reviewing = false
  async function rootFor(value) {
    if (value === undefined || value === null || value === '') return null
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Choose an open workspace.')
    const roots = await getRoots()
    const canonical = await fs.realpath(value)
    if (!roots.some(root => (root.canonicalPath || root.path) === canonical)) throw new Error('This folder is not an open workspace.')
    return canonical
  }
  async function handle(op, payload={}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid setup request.')
    if (op === 'status') return runner.status()
    if (op === 'cancel') return runner.cancel()
    const root = await rootFor(payload.root)
    if (op === 'check') {
      const roots = await getRoots()
      return {...await runtime.inspect(root,{env:getEnv()}), roots}
    }
    if (op === 'open-installer') {
      const url = runtime.INSTALL_URLS[payload.tool]
      if (!url) throw new Error('Unknown tool installer.')
      await openExternal(url)
      return {state:'guided',message:'Complete the official installation, then check again. Restart DSH PRO if the installer changes your shell PATH.'}
    }
    if (op !== 'install') throw new Error('Unknown setup operation.')
    if (reviewing || runner.status().state === 'running') throw new Error('Another setup task is already in progress.')
    if (!root && !['pnpm','yarn'].includes(payload.task)) throw new Error('Choose a workspace first.')
    reviewing = true
    try {
      const options = {env:getEnv(),toolsDir}
      const reviewed = await runtime.plan(root,payload.task,payload.choice,options)
      if (!(await confirm(reviewed))) return {state:'cancelled',output:''}
      await rootFor(root)
      const fresh = await runtime.plan(root,payload.task,payload.choice,options)
      if (JSON.stringify(fresh) !== JSON.stringify(reviewed)) throw new Error('Project setup changed during review. Check again before installing.')
      return await runner.start(fresh,options.env)
    } finally { reviewing = false }
  }
  return {handle, cancel:runner.cancel}
}
module.exports = {createSetupHandler}
