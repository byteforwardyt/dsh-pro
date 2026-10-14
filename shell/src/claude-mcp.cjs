'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Locate the installed CLI without invoking a shell or touching its credentials. */
function findClaude(env = process.env, home = os.homedir()) {
  const dirs = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
    ...(env.PATH || '').split(path.delimiter).filter(path.isAbsolute)]
  for (const dir of dirs) {
    const file = path.join(dir, 'claude')
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file } } catch {}
  }
  return null
}

/** The existing MCP client owns discovery, tool registration, reconnect and teardown. */
function claudeMcpPatch(command = findClaude()) {
  if (!command) return ''
  return '\n# Installed Claude Code tools over stdio; no subscription tokens are imported.\n' +
    '- insert:\n' +
    '    - id: claude-code-mcp\n' +
    "      name: '@deepseek-ai/dsh-mcp-client'\n" +
    '      config:\n' +
    '        transport: stdio\n' +
    '        serverName: claude_code\n' +
    '        command: ' + JSON.stringify(command) + '\n' +
    '        args: [mcp, serve]\n' +
    '        failOnStartupError: false\n'
}
module.exports = { findClaude, claudeMcpPatch }
