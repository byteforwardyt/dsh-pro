'use strict'

// A narrowly scoped extension to our pinned upstream bundle. All layout and
// editor code stays native; plugins can supply a transcript and a send sink.
const fs = require('node:fs')
const path = require('node:path')
const MARKER = '/* DSH native conversation delegates v1 */'

function transform(source) {
  if (source.includes(MARKER)) return source
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw Error('Native conversation compatibility anchor changed: ' + from.slice(0, 100))
    source = source.replace(from, to)
  }
  replace('var exports = module.exports;', `var exports = module.exports;
    ${MARKER}
    const dshDelegateSources = new Set(), dshDelegateListeners = new Set();
    let dshDelegateRevision = 0;
    const dshDelegateChanged = () => { dshDelegateRevision++; dshDelegateListeners.forEach(fn => fn()); };
    const dshDelegateFor = id => { if (!id) return; for (const source of dshDelegateSources) { const value = source.resolve(id); if (value) return value; } };
    const dshDelegateSubscribe = fn => { dshDelegateListeners.add(fn); return () => dshDelegateListeners.delete(fn); };
    const dshDelegateSnapshot = () => dshDelegateRevision;
    function useDshDelegate(id) { react.useSyncExternalStore(dshDelegateSubscribe, dshDelegateSnapshot); return dshDelegateFor(id); }
    const dshDelegates = { register(source) {
      dshDelegateSources.add(source); const off = source.subscribe(dshDelegateChanged); dshDelegateChanged();
      return () => { off(); dshDelegateSources.delete(source); dshDelegateChanged(); };
    } };
  `)
  replace('this.input = config.input;', 'this.input = config.input;\n                this.delegates = dshDelegates;')
  replace('async sendSession(session, text, attachmentIds, mode, signal) {', `async sendSession(session, text, attachmentIds, mode, signal) {
        const delegate = dshDelegateFor(session.sessionId);
        if (delegate) {
          if (delegate.blocked) throw Error(delegate.blocked);
          if (attachmentIds.length) throw Error('SuperCode currently accepts workspace file references. Remove uploaded attachments and reference their workspace paths instead.');
          await delegate.submit(text, { session, signal });
          return { kind: 'success' };
        }`)
  replace('async cancel() {\n\t\t\t\tconst result', 'async cancel() {\n                const delegate = dshDelegateFor(this.scopeId("cancel"));\n                if (delegate) { await delegate.cancel?.(); return; }\n\t\t\t\tconst result')
  replace('return conversation.activeTargets.size > 0 ||', 'return dshDelegateFor(session.sessionId)?.active || conversation.activeTargets.size > 0 ||')
  replace('const { sessionId, useSession, useSessions, useConversation, renderSlot, renderFactorySlot } = props;', 'const { sessionId, useSession, useSessions, useConversation, renderSlot, renderFactorySlot } = props;\n            useDshDelegate(sessionId);')
  replace('function ConversationHeader({ sessionId, useSession, useConversation, renderSlot }) {', 'function ConversationHeader({ sessionId, useSession, useConversation, renderSlot }) {\n            useDshDelegate(sessionId);')
  replace('function DefaultConversationViews({ view,', 'function DefaultConversationViews({ sessionId, view,')
  replace('function DefaultConversationViews({ sessionId, view, useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions, renderSlot, bindDraftMirror, openView, useInspectCall }) {', 'function DefaultConversationViews({ sessionId, view, useSession, useConversation, useConversationViews, useInput, inputActions, useStore, actions, renderSlot, bindDraftMirror, openView, useInspectCall }) {\n            const delegate = useDshDelegate(sessionId);')
  replace('const viewId = view ?? active?.id;', 'const viewId = view ?? active?.id;\n            if (viewId === "chat" && delegate?.active) return (0, react_jsx_runtime.jsx)("div", { className: ConversationRoot_module_css_default.viewArea, children: delegate.content });')
  replace('const input = useInput((s) => s);\n\t\t\tconst notice', 'const delegate = useDshDelegate(sessionId);\n            if (delegate?.blocked) blocked = { reason: delegate.blocked };\n            const input = useInput((s) => s);\n\t\t\tconst notice')
  replace('const running = useSession((s) => s.running) ?? false;', 'const nativeRunning = useSession((s) => s.running) ?? false;\n            const running = delegate ? !!delegate.running : nativeRunning;')
  replace('sessionId === void 0 ? null : renderSlot("conversation.input.model", { locked: modelSeatLocked })', 'sessionId === void 0 ? null : delegate ? delegate.modelControl : renderSlot("conversation.input.model", { locked: modelSeatLocked })')
  replace('renderSlot("conversation.input.permission", { locked })', 'renderSlot("conversation.input.permission", { locked: locked || !!delegate?.active })')
  replace('renderSlot("conversation.input.plan", { locked })', 'delegate ? null : renderSlot("conversation.input.plan", { locked })')
  // Draft submission stays in the native state machine; only command discovery
  // is disabled in team mode so a slash command cannot bypass its scheduler.
  replace('const onToggleCommandMenu = () => {', 'const onToggleCommandMenu = () => {\n                if (delegate) { delegate.openOptions?.(); return; }')
  replace('inputTriggers: () => this.controller(actx),', 'inputTriggers: () => dshDelegateFor(session.sessionId) ? undefined : this.controller(actx),')
  return source
}

function apply(harness) {
  const pkg = path.join(harness, 'node_modules/@deepseek-ai/dsh-client-ui-conversation')
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version
  if (version !== '0.2.0-rc.2') throw Error('Review native conversation delegate for upstream ' + version)
  const file = path.join(pkg, 'lib/client.js'), before = fs.readFileSync(file, 'utf8'), after = transform(before)
  if (after !== before) { fs.writeFileSync(file + '.dsh-stage', after); fs.renameSync(file + '.dsh-stage', file) }
}
module.exports = { apply, transform, MARKER }
function prepareDevelopment(root = path.resolve(__dirname, '..')) {
  require('./native-supercode-compat.cjs').prepareDevelopment(root)
  const store = path.join(root, 'node_modules/.pnpm')
  const directory = fs.readdirSync(store).find(name => name.startsWith('@deepseek-ai+dsh-client-ui-conversation@0.2.0-rc.2'))
  if (!directory) throw Error('Install the pinned native conversation package first.')
  const file = path.join(store, directory, 'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js')
  const cache = path.join(root, 'node_modules/.cache/dsh-conversation-upstream-0.2.0-rc.2.js')
  const current = fs.readFileSync(file, 'utf8')
  if (!current.includes(MARKER)) { fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.writeFileSync(cache, current) }
  const source = fs.readFileSync(cache, 'utf8'), output = transform(source)
  // Atomic replacement detaches pnpm's content-addressed hardlink before edits.
  if (output !== current) { fs.writeFileSync(file + '.dsh-stage', output); fs.renameSync(file + '.dsh-stage', file) }
}
module.exports.prepareDevelopment = prepareDevelopment
if (require.main === module) {
  if (process.argv[2] === '--development') prepareDevelopment()
  else apply(path.resolve(process.argv[2]))
}
