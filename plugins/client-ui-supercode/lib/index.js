import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { isTrustedRequest } from '@dsh-desktop/host-files-api/trust'
import { RoomStore } from './room-store.js'
import { RoomService } from './room-service.js'
import { createNativeRuntime } from './native-runtime.js'
import { registerTeamTools } from './tools.js'
import { check, RoomError } from './room-state.js'
import { createChatSessions } from './chat-sessions.js'

export const inject = ['webServer', 'workspaceRegistry', 'settings', 'tools', 'agents', 'subagents', 'agentPresets',
  'systemPrompt', 'permissionPresets', 'sessionPersistence', 'sessions', 'sessionTitle', 'jobs', 'llm']

export function apply(ctx) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const store = new RoomStore(path.join(home, 'supercode', 'rooms'))
  const catalog = async () => Promise.all(ctx.llm.listProviders().map(async provider => {
    try { return { id: provider.id, name: provider.name || provider.id, label: provider.name || provider.id, models: await ctx.llm.listModels(provider.id) } }
    catch { return { id: provider.id, name: provider.name || provider.id, models: [], error: 'Model catalog unavailable. Check this connection.' } }
  }))
  const service = new RoomService({ store, validateModels: async members => {
    const groups = await catalog()
    for (const member of members) {
      const model = groups.find(group => group.id === member.provider)?.models.find(model => model.id === member.model)
      check(model, `${member.name}’s selected model is unavailable. Update the team or restore its connection.`, 409)
      if (member.effort) {
        const resolved = await ctx.llm.resolveModelInfo(member.provider, member.model, AbortSignal.timeout(15000))
        const efforts = resolved?.reasoning?.efforts || []
        check(Array.isArray(efforts) && efforts.some(value => (typeof value === 'string' ? value : value.id || value.value) === member.effort),
          `${member.name}’s effort level is not supported by that model.`)
      }
    }
  } })
  const runtime = createNativeRuntime({ ctx, getRoom: id => service.get(id),
    persistMemberSession: (...args) => service.persistMemberSession(...args), emit: (...args) => service.emit(...args),
    reserveCall: (...args) => service.reserveCall(...args), admission: (...args) => service.admission(...args) })
  service.attach(runtime)
  const chats = createChatSessions({ ctx, service, runtime })
  const recovery = chats.recover()
  const removeTools = registerTeamTools(ctx, service)
  const streams = new Set()
  const workspaces = () => ctx.workspaceRegistry.list().map(item => ({ id: String(item.id), cwd: item.path, name: item.title || path.basename(item.path) }))
  const json = (res, status, payload) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const disposer = ctx.webServer.register({ kind: 'prefix', path: '/dsh-supercode', handler: async (req, res) => {
    if (!isTrustedRequest(req)) return json(res, 403, { error: 'Unauthorized SuperCode request.' })
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), route = url.pathname.slice('/dsh-supercode'.length)
      if (req.method === 'GET' && route === '/model') {
        const provider = url.searchParams.get('provider'), model = url.searchParams.get('model')
        check(provider && model && provider.length <= 512 && model.length <= 512, 'Select a provider and model.')
        const info = await ctx.llm.resolveModelInfo(provider, model, AbortSignal.timeout(15000))
        check(info, 'Model information is unavailable. Check this connection.', 409)
        return json(res, 200, info)
      }
      if (req.method === 'GET' && route === '/bootstrap') {
        let selections = {}
        try {
          const setting = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === 'desktop-model-visibility')
          selections = setting?.config?.selections || setting?.value?.selections || {}
        } catch {}
        return json(res, 200, { rooms: store.list(), workspaces: workspaces(), catalog: await catalog(), selections, errors: store.errors, recoveryErrors: await recovery })
      }
      const found = route.match(/^\/rooms\/([a-zA-Z0-9_-]{1,80})(\/command|\/events)?$/)
      if (req.method === 'GET' && found && !found[2]) return json(res, 200, service.view(found[1]))
      if (req.method === 'GET' && found?.[2] === '/events') {
        service.get(found[1])
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        const send = room => { if (room.id === found[1] && !res.destroyed) res.write(`id: ${room.revision}\ndata: ${JSON.stringify({ room })}\n\n`) }
        send(service.view(found[1])); store.on('change', send); streams.add(res)
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n') }, 15000); heartbeat.unref?.()
        res.once('close', () => { clearInterval(heartbeat); store.off('change', send); streams.delete(res) })
        return
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' })
      check(String(req.headers['content-type'] || '').startsWith('application/json'), 'JSON body required.', 415)
      const chunks = []; let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; check(bytes <= 100000, 'Request too large.', 413); chunks.push(chunk) }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RoomError('Invalid JSON.') }
      if (route === '/rooms') {
        const workspace = workspaces().find(item => item.id === body.workspaceId)
        check(workspace, 'Choose an open workspace.')
        const cwd = fs.realpathSync(workspace.cwd)
        check(fs.statSync(cwd).isDirectory() && cwd !== path.parse(cwd).root && cwd !== os.homedir(), 'Choose a project folder, not the entire home or filesystem.')
        const room = await service.create(body, { ...workspace, cwd })
        return json(res, 201, await chats.prepare(room.id))
      }
      if (found?.[2] === '/command') return json(res, 200, await service.command(found[1], body))
      return json(res, 404, { error: 'Not found.' })
    } catch (error) { json(res, error.status || 503, { error: error.status ? error.message : 'SuperCode could not complete this operation. Existing work is preserved.' }) }
  } })
  ctx.effect(() => async () => { disposer(); streams.forEach(res => res.end()); await service.dispose(); removeTools() })
}
