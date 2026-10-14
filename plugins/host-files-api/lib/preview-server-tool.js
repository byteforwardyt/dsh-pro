import { defineTool } from '@deepseek-ai/dsh-tools'

export function previewServerTool (projects) {
  return defineTool({
    name: 'preview_server',
    description: 'Manage this chat’s own preview server. Start a foreground dev command in a project folder inside the chat workspace. The command must print its local HTTP URL. Use status to inspect readiness/output; ready automatically opens this chat’s Preview. Never use a fixed shared port when running several projects. Stop/restart only affect the process started by this tool or the Preview panel.',
    parameters: {
      action: { type: 'string', enum: ['status', 'start', 'stop', 'restart'], required: true },
      cwd: { type: 'string', description: 'Absolute project directory, required for start/restart.' },
      command: { type: 'string', description: 'Foreground launch command, required for start/restart. No background & or daemon mode.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, state: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value.ok ? value.state : value.error }],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => false,
    async execute (args, exec) {
      const sessionId = exec?.agent?.session?.header?.id
      try {
        const state = args.action === 'status' ? await projects.read(sessionId) : await projects.change({ ...args, sessionId })
        return { ok: true, state: JSON.stringify(state) }
      } catch (error) { return { ok: false, error: error.message } }
    },
  })
}
