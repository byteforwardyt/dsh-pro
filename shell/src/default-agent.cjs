'use strict'
const fs = require('node:fs')
const path = require('node:path')
const MARKER = '# Managed by DSH PRO: default coding agent v1\n'
const GUIDANCE = `You are DSH Agent, a coding agent powered by {{model}}. Your working directory is {{cwd}}.
Inspect the project and its instructions before editing. Complete the requested task end to end using the available coding, terminal, search, skills, and connected MCP tools. Stay within the user's requested scope and current access policy; tool availability is not permission to delete data, publish, expose credentials, or expand access.
For implementation work, run the relevant build and tests, inspect actual failures, fix their causes, and rerun the affected checks. For visual work, inspect the running result with available browser tools. If verification is unavailable, report that limitation rather than claiming success. A passing HTTP response or preview navigation is not proof of a working game.
Use preview_server to start and track this chat's own foreground development server, inspect its reported URL and output, and open the correct preview. Do not borrow another chat's server or assume a shared port. Use preview_open for an existing URL or workspace page when appropriate. Do not claim to have seen a page unless it was actually inspected.
Use subagents only when a separable task justifies the cost and coordination. Preserve user changes, keep useful progress updates concise, and finish with what changed, what was actually tested, and any remaining limitations.`

/** Derive from the shipped composition; never maintain a second tool catalog. */
function ensureDefaultAgent (dshHome, harnessDir, bundleDir) {
  const legacy = path.join(dshHome, '.agent-presets', 'dsh-agent', 'agent.cordis.yml')
  if (fs.existsSync(legacy) && !fs.readFileSync(legacy, 'utf8').startsWith(MARKER))
    throw new Error('Default agent: dsh-agent is already a custom preset; it has been left untouched.')
  const pkg = require.resolve('@deepseek-ai/dsh/package.json', { paths: [harnessDir] })
  const sourcePath = require.resolve('@deepseek-ai/dsh-web-app/presets/standard.patch.yml', { paths: [path.dirname(pkg)] })
  const source = fs.readFileSync(sourcePath, 'utf8')
  const persona = /prefix: You are a coding agent powered by the {{model}} model\./
  if (!persona.test(source)) throw new Error('Default agent: upstream persona changed; review composition before updating.')
  const result = source.replace('id: preset-standard', 'id: preset-dsh-agent')
    .replace('id: standard', 'id: dsh-agent\n        name: DSH Agent\n        description: Full coding tools with verification and per-chat preview.').replace('order: 1', 'order: 0')
    .replace(persona, 'prefix: ' + JSON.stringify(GUIDANCE))
  fs.writeFileSync(path.join(bundleDir, 'agent.patch.yml'), MARKER + result, { mode: 0o600 })
  const dispatch = source.replace('id: preset-standard', 'id: preset-dispatch')
    .replace('id: standard', 'id: dispatch\n        name: Dispatch').replace('order: 1', 'order: 5')
  fs.writeFileSync(path.join(bundleDir, 'dispatch.patch.yml'), dispatch.trimEnd()
    + '\n          - id: dispatch-tool\n            name: "@dsh-desktop/tool-dispatch"\n', { mode: 0o600 })
  return bundleDir
}

module.exports = { ensureDefaultAgent, GUIDANCE }
