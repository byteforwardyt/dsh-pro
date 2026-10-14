'use strict'
const fs = require('node:fs')
const path = require('node:path')
const MARKER = '/* DSH legacy SuperCode user-role compatibility v1 */'

// Decode only the exact envelope written by our old lead followup. This does
// not edit the log, change a session identity, or accept a conflicting role.
function normalizeLegacySuperCodeEvent(event) {
  const data = event?.data, source = data?.source
  if (event?.type !== 'user/message' || data?.role !== undefined || source?.kind !== 'user' || source.origin !== 'supercode-host' ||
    typeof data.id !== 'string' || typeof source.roomId !== 'string' || typeof source.memberId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(source.roomId) || !/^[a-zA-Z0-9_-]{1,80}$/.test(source.memberId) ||
    typeof source.rpcId !== 'string' || !source.rpcId.startsWith(`supercode:${source.roomId}:`) || !source.rpcId.endsWith(`:${data.id}`) ||
    !Array.isArray(data.content) || !data.content.some(part => part?.type === 'text' && typeof part.text === 'string' &&
      part.text.startsWith(`[SuperCode host task]\nRoom: ${source.roomId}\n`))) return event
  return { ...event, data: { ...data, role: 'user' } }
}

function transform(source) {
  if (source.includes(MARKER)) return source
  const anchor = 'for (const [index, event] of events.entries()) events[index] = adoptSessionEvent(event);'
  if (source.split(anchor).length !== 2 || source.split('function validateStoredEvents(meta, events, location) {').length !== 2) throw Error('Review the pinned native session persistence compatibility anchor.')
  return source.replace('function validateStoredEvents(meta, events, location) {', `${MARKER}\n${normalizeLegacySuperCodeEvent.toString()}\nfunction validateStoredEvents(meta, events, location) {`)
    .replace(anchor, 'for (const [index, event] of events.entries()) events[index] = adoptSessionEvent(normalizeLegacySuperCodeEvent(event));')
}
function applyPackage(pkg) {
  if (JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version !== '0.2.0-rc.2') throw Error('Review SuperCode persistence compatibility for this upstream version.')
  const file = path.join(pkg, 'lib/index.js'), before = fs.readFileSync(file, 'utf8'), after = transform(before)
  if (before !== after) { fs.writeFileSync(file + '.dsh-stage', after); fs.renameSync(file + '.dsh-stage', file) }
}
function apply(harness) { applyPackage(path.join(harness, 'node_modules/@deepseek-ai/dsh-session-persistence')) }
function prepareDevelopment(root) {
  const store = path.join(root, 'node_modules/.pnpm')
  const entry = fs.readdirSync(store).find(name => name.startsWith('@deepseek-ai+dsh-session-persistence@0.2.0-rc.2'))
  if (!entry) throw Error('Install the pinned session persistence package first.')
  applyPackage(path.join(store, entry, 'node_modules/@deepseek-ai/dsh-session-persistence'))
}
module.exports = { normalizeLegacySuperCodeEvent, transform, apply, prepareDevelopment, MARKER }
if (require.main === module) apply(path.resolve(process.argv[2]))
