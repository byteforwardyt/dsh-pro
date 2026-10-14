import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createComputerUse } = require('../src/computer-use.cjs')

function fixture() {
  let permissions = { accessibility: true, screenRecording: true }
  const calls = [], results = []
  const runtime = {
    async listToolsJson() { return JSON.stringify({ tools: ['click', 'get_desktop_state', 'set_config', 'install_ffmpeg'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {session:{type:'string'}} } })) }) },
    async callTool(name, args, options) { calls.push({ name, args: JSON.parse(args), options }); return { text: 'done', images: [], isError: false } },
    async shutdown() { calls.push('shutdown') },
    uniffiDestroy() { calls.push('destroy') },
  }
  let config
  const manager = createComputerUse({ platform: 'darwin', loadSDK: async () => ({
    currentMacOsPermissionStatus: () => permissions,
    SessionPermissionMode: { Standard: 0 },
    CuaDriver: { createConfigured(options) { config = options; return runtime } },
  }) })
  const child = { connected: true, send(message, callback) { results.push(message); callback?.() } }
  return { manager, child, calls, results, runtime, config: () => config, permissions: value => { permissions = value } }
}

test('computer use starts disabled, requires OS grants, and has a Standard-only ceiling', async () => {
  const f = fixture()
  assert.equal((await f.manager.control('status')).enabled, false)
  await f.manager.receive({ channel: 'dsh-computer', id: 'one', op: 'call', tool: 'click', args: {}, session: 'task' }, f.child)
  assert.match(f.results.at(-1).error, /off/)
  assert.equal(f.calls.length, 0)
  f.permissions({ accessibility: false, screenRecording: false })
  assert.match((await f.manager.control('enable')).error, /Allow Accessibility/)
  f.permissions({ accessibility: true, screenRecording: true })
  assert.equal((await f.manager.control('enable')).enabled, true)
  assert.deepEqual(f.config().authorization.allowedModes, [0])
  assert.equal(f.config().authorization.unrestrictedAcknowledged, false)
  await f.manager.receive({ channel: 'dsh-computer', id: 'two', op: 'catalog' }, f.child)
  assert.deepEqual(f.results.at(-1).result.tools.map(t => t.name), ['click', 'get_desktop_state'])
  await f.manager.receive({ channel: 'dsh-computer', id: 'three', op: 'call', tool: 'set_config', args: {}, session: 'task' }, f.child)
  assert.match(f.results.at(-1).error, /not enabled/)
  await f.manager.receive({ channel: 'dsh-computer', id: 'four', op: 'call', tool: 'click', args: { session: 'other', pid: 9 }, session: 'task' }, f.child)
  assert.equal(f.calls[0].args.session, 'dsh-task')
  await f.manager.control('disable')
  assert.deepEqual(f.calls.slice(-2), ['shutdown', 'destroy'])
})

test('stop aborts an admitted action and no action is replayed', async () => {
  const f = fixture()
  await f.manager.control('enable')
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  f.runtime.callTool = (_, __, { signal }) => new Promise((resolve, reject) => {
    entered()
    signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
  })
  const action = f.manager.receive({ channel: 'dsh-computer', id: 'active', op: 'call', tool: 'click', args: {}, session: 'task' }, f.child)
  await ready
  await f.manager.receive({ channel: 'dsh-computer', id: 'second', op: 'call', tool: 'click', args: {}, session: 'task' }, f.child)
  assert.match(f.results.at(-1).error, /Another computer action/)
  await f.manager.control('disable')
  await action
  assert.match(f.results.at(-1).error, /outcome may be unknown/)
  assert.equal((await f.manager.control('status')).enabled, false)
})

test('late SDK load cannot re-enable after disable; unsupported systems are honest', async () => {
  let resolve
  const loading = new Promise(r => { resolve = r })
  let created = false
  const m = createComputerUse({ platform: 'darwin', loadSDK: () => loading })
  const enabling = m.control('enable')
  await m.control('disable')
  resolve({ currentMacOsPermissionStatus: () => ({ accessibility: true, screenRecording: true }), CuaDriver: { createConfigured() { created = true } } })
  assert.equal((await enabling).enabled, false)
  assert.equal(created, false)
  assert.equal((await createComputerUse({ platform: 'linux' }).control('enable')).supported, false)
})

test('real catalog schemas control session injection and prohibit file output', async () => {
  const f=fixture()
  f.runtime.listToolsJson=async()=>JSON.stringify({tools:[
    {name:'list_windows',description:'List',inputSchema:{type:'object',properties:{pid:{type:'number'}},additionalProperties:false}},
    {name:'get_window_state',description:'Read',inputSchema:{type:'object',properties:{session:{type:'string'},screenshot_out_file:{type:'string'}}}},
  ]})
  await f.manager.control('enable')
  await f.manager.receive({channel:'dsh-computer',id:'catalog',op:'catalog',tool:'get_window_state'},f.child)
  assert.equal(f.results.at(-1).result.tools[0].inputSchema.properties.screenshot_out_file,undefined)
  await f.manager.receive({channel:'dsh-computer',id:'list',op:'call',tool:'list_windows',args:{pid:9,session:'foreign'},session:'task'},f.child)
  assert.deepEqual(f.calls[0].args,{pid:9})
  await f.manager.receive({channel:'dsh-computer',id:'write',op:'call',tool:'get_window_state',args:{screenshot_out_file:'/tmp/no'},session:'task'},f.child)
  assert.match(f.results.at(-1).error,/file output/)
  assert.equal(f.calls.length,1)
})

test('driver load failure and disconnected bridge are distinct from OS permissions',async()=>{
  const broken=createComputerUse({platform:'darwin',loadSDK:async()=>{throw new Error('missing native library')}})
  assert.equal((await broken.control('status')).state,'driver-error')
  assert.match((await broken.control('enable')).error,/missing native library/)
  const disconnected=createComputerUse({platform:'darwin',isConnected:()=>false,loadSDK:async()=>({currentMacOsPermissionStatus:()=>({accessibility:true,screenRecording:true})})})
  assert.equal((await disconnected.control('status')).state,'disconnected')
  assert.equal((await disconnected.control('enable')).enabled,false)
})

test('expired sessions can be explicitly reopened through the same approved session boundary',async()=>{
 const f=fixture();
 f.runtime.listToolsJson=async()=>JSON.stringify({tools:[{name:'start_session',description:'Start or resume',inputSchema:{type:'object',properties:{session:{type:'string'}}}}]});
 await f.manager.control('enable');
 await f.manager.receive({channel:'dsh-computer',id:'restart',op:'call',tool:'start_session',args:{session:'foreign'},session:'task'},f.child);
 assert.equal(f.calls[0].name,'start_session');
 assert.equal(f.calls[0].args.session,'dsh-task');
});
