const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadClient } = require('./helpers/client-harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(initial = {}, globals = {}) {
  let integration, context, data = { rooms: [], workspaces: [{ id: 'workspace', cwd: '/project', name: 'Project' }], catalog: [], ...initial };
  const calls = [], navigations = [], effects = [], nativeListeners = new Set();
  const native = { byId: { draft: { blank: true, cwd: '/project' }, chat: { blank: false, cwd: '/project' } } };
  const ctx = {
    conversation: { delegates: { register: () => () => {} } },
    sessions: { list: { getSnapshot: () => native, subscribe: fn => { nativeListeners.add(fn); return () => nativeListeners.delete(fn); } }, refresh: async () => {} },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace', path: '/project', title: 'Project' }] }), subscribe: () => () => {} }, create: async ({ path }) => { navigations.push(['create-workspace', path]); return { workspaceId: 'added' }; } },
    uiWorkspace: { startSession: () => navigations.push(['new']), openSession: id => navigations.push(['open', id]),
      openWorkspace: async (id, beforeOpen) => { navigations.push(['workspace', id]); beforeOpen?.('draft'); }, pickDirectory: async () => '/another-project' },
    layout: { selectPanel: value => navigations.push(['panel', value]), beginNavigation: () => new AbortController().signal },
    effect: fn => { const dispose = fn(); if (dispose) effects.push(dispose); },
  };
  const request = async (route, body) => {
    calls.push({ route, body: body && plain(body) });
    if (route === '/bootstrap') return plain(data);
    return response(route, body);
  };
  let response = () => { throw Error('Unexpected command'); };
  const Setup = () => {}, Room = () => {}, RoomHeader = () => {}, Icon = () => {};
  const client = loadClient('client-ui-supercode', async () => {}, {
    entryFile: path.resolve(__dirname, '../../plugins/client-ui-supercode/lib/client.sessions.js'), context: ctx,
    globals: { crypto: { randomUUID: () => 'request-id' }, ...globals },
    apply(api, host) { context = host; integration = api.createSessionIntegration(host, { request, Setup, Room, RoomHeader, Icon }); integration.install(); },
  });
  return { ...client, integration, ctx: context, Setup, Room, calls, navigations, native,
    setData: value => { data = value; }, nativeChanged: () => nativeListeners.forEach(fn => fn()), setResponse: fn => { response = fn; }, close: () => effects.forEach(fn => fn()) };
}

test('leaving an unsent SuperCode session restores regular blank mode without losing team choices', async () => {
  const f = fixture(); await f.integration.refresh();
  f.native.byId.draft.retainedBy = { mainView: 1 };
  f.integration.setDraft('draft', { goal: 'Keep my team goal', members: [{ name: 'Lead', model: 'chosen' }] });
  let chain = () => ({ meta: { select: owner => f.integration.resolve(owner.sessionId) || null } });
  assert(chain().meta.select({ sessionId: 'draft' }));
  f.native.byId.draft.retainedBy.mainView = 0; f.nativeChanged();
  assert.equal(chain().meta.select({ sessionId: 'draft' }), null);
  assert.equal(f.integration.getSnapshot().drafts.draft.goal, 'Keep my team goal');
  f.integration.setDraft('draft', f.integration.getSnapshot().drafts.draft);
  assert(chain().meta.select({ sessionId: 'draft' }));
  assert.equal(f.integration.getSnapshot().drafts.draft.members[0].model, 'chosen');
  f.close();
});

test('New SuperCode is a native New Session action; only session-scoped chat and ambient row slots are registered', async () => {
  const f = fixture(); await f.integration.refresh();
  assert.deepEqual([...new Set(f.registrations.map(entry => entry.meta.name))], ['main', 'sidebar.panellist', 'conversation.input.left', 'sidebar.session.row.leading']);
  const view = await f.mount({}, f.integration.Launch).flush();
  assert.deepEqual(f.navigations, [['new']]);
  assert(f.calls.every(call => call.route === '/bootstrap'));
  assert(f.integration.resolve('draft'));
  assert.equal(f.integration.resolve('chat'), undefined);
  assert.equal(f.registrations.some(entry => entry.meta.name === 'conversation.composer'), false);
  view.unmount(); f.close();
});

test('native session identity routes reopening; stale responses cannot replace newer room revisions', async () => {
  const room = { id: 'room', chatSessionId: 'chat', revision: 10, status: 'completed' };
  const f = fixture({ rooms: [room] }); await f.integration.refresh();
  assert.equal(f.integration.roomFor('chat').id, 'room');
  assert.equal(f.integration.roomFor('draft'), undefined);
  f.integration.accept({ ...room, revision: 9, status: 'running' });
  assert.equal(f.integration.roomFor('chat').status, 'completed');
  f.setData({ rooms: [{ ...room, revision: 8 }], workspaces: [], catalog: [] }); await f.integration.refresh();
  assert.equal(f.integration.roomFor('chat').revision, 10);
  f.close();
});

test('only the addressed room contributes transcript content; no custom header or composer is registered', async () => {
  const room = { id: 'room', chatSessionId: 'chat', revision: 1, status: 'running' };
  const f = fixture({ rooms: [room] }); await f.integration.refresh();
  assert.equal(f.integration.resolve('draft'), undefined);
  const delegate = f.integration.resolve('chat');
  assert.equal(delegate.active, true); assert.equal(delegate.running, true);
  assert.equal(delegate.content.props.part, 'transcript');
  assert.equal(delegate.modelControl.props.part, 'controls');
  assert.equal(f.registrations.some(entry => /header|composer/.test(entry.meta.name)), false);
  f.close();
});

test('an already claimed ordinary slash command cannot change into team mode and bypass its sender', async () => {
  const f = fixture(); await f.integration.refresh();
  const view = await f.mount({ sessionId: 'draft', useSessions: select => select(f.native), useInput: select => select({ phase: 'claimed' }) }, f.integration.Mode).flush();
  assert.equal(view.tree.props.disabled, true);
  view.tree.props.onClick();
  assert.equal(f.integration.resolve('draft'), undefined);
  view.unmount(); f.close();
});

test('workspace switching carries team choices without a second workspace picker', async () => {
  const f = fixture(); await f.integration.refresh();
  f.native.byId.draft.retainedBy = { mainView: 1 };
  f.integration.setDraft('draft', { members: [{ model: 'chosen' }] });
  f.native.byId.draft.retainedBy.mainView = 0;
  f.native.byId.other = { id: 'other', blank: true, cwd: '/other-project', retainedBy: { mainView: 1 } };
  f.nativeChanged();
  assert.equal(f.integration.getSnapshot().drafts.other.members[0].model, 'chosen');
  assert(f.integration.resolve('other'));
  assert.equal(f.integration.resolve('draft'), undefined);
  f.close();
});

test('unrelated recovery warnings never enter this chat transcript', async () => {
  const room = { id: 'room', chatSessionId: 'chat', revision: 1, status: 'completed' };
  const f = fixture({ rooms: [room], recoveryErrors: [{ roomId: 'other', message: 'Other history preserved' }] }); await f.integration.refresh();
  const view = await f.mount({ sessionId: 'chat', part: 'transcript' }, f.integration.Surface).flush();
  assert.equal(view.find(node => node.props.role === 'alert'), undefined);
  view.unmount(); f.close();
});

test('failed commands preserve the message draft and expose the actual conflict without replaying', async () => {
  const room = { id: 'room', chatSessionId: 'chat', revision: 1, status: 'running' };
  const f = fixture({ rooms: [room] }); await f.integration.refresh();
  f.setResponse(async () => { throw Error('Room changed. Review and retry.'); });
  const surface = await f.mount({ sessionId: 'chat', part: 'transcript' }, f.integration.Surface).flush();
  const props = surface.find(node => node.type === f.Room).props;
  assert.equal(await props.command('message', { text: 'Keep this draft' }), false);
  await surface.flush();
  assert(surface.find(node => node.props.role === 'alert').props.children.includes('Room changed. Review and retry.'));
  assert.equal(f.calls.filter(call => call.body?.action === 'message').length, 1);
  surface.unmount(); f.close();
});

test('explicit new goal keeps the canonical native chat without a separate new-run screen', async () => {
  let room = { id: 'room', chatSessionId: 'chat', revision: 1, status: 'completed' };
  const f = fixture({ rooms: [room] }); await f.integration.refresh();
  f.setResponse(async (route, body) => { room = { ...room, revision: room.revision + 1, status: body.action === 'new-run' ? 'draft' : 'planning' }; return room; });
  const surface = await f.mount({ sessionId: 'chat', part: 'transcript' }, f.integration.Surface).flush();
  assert.equal(await surface.find(node => node.type === f.Room).props.command('new-goal', { text: 'Next goal', recipient: 'team' }), true);
  assert.deepEqual(f.calls.filter(call => call.body?.action).map(call => call.body.action), ['new-run', 'start']);
  assert.equal(f.integration.roomFor('chat').chatSessionId, 'chat');
  assert.deepEqual(f.navigations, []);
  surface.unmount(); f.close();
});

test('ordinary completed-chat questions preserve recipient and never call new-run or plan', async () => {
  const room = { id: 'room', chatSessionId: 'chat', revision: 1, status: 'completed' };
  const f = fixture({ rooms: [room] }); await f.integration.refresh();
  f.setResponse(async () => ({ ...room, revision: 2, status: 'discussing' }));
  const surface = await f.mount({ sessionId: 'chat', part: 'transcript' }, f.integration.Surface).flush();
  assert.equal(await surface.find(node => node.type === f.Room).props.command('message', { text: 'What changed?', recipient: 'reviewer' }), true);
  const requests = f.calls.filter(call => call.body?.action);
  assert.deepEqual(requests.map(call => call.body.action), ['message']);
  assert.equal(requests[0].body.recipient, 'reviewer');
  surface.unmount(); f.close();
});

test('an idle chat explicitly replans with its saved models without moving chats or silently resuming the old team', async () => {
  let room = { id: 'room', chatSessionId: 'chat', revision: 1, status: 'blocked', goal: 'Keep the same goal', nextTeam: { members: [], leadId: 'lead' } };
  const f = fixture({ rooms: [room] }); await f.integration.refresh();
  f.setResponse(async (route, body) => { room = { ...room, revision: room.revision + 1, status: ({ stop: 'stopped', 'new-run': 'draft', start: 'discussing' })[body.action] }; return room; });
  const surface = await f.mount({ sessionId: 'chat', part: 'transcript' }, f.integration.Surface).flush();
  assert.equal(await surface.find(node => node.type === f.Room).props.command('replan-team'), true);
  const calls = f.calls.filter(call => call.body?.action);
  assert.deepEqual(calls.map(call => call.body.action), ['stop', 'new-run', 'start']);
  assert.equal(calls[1].body.goal, 'Keep the same goal');
  assert.equal(f.integration.roomFor('chat').chatSessionId, 'chat');
  assert.deepEqual(f.navigations, []);
  surface.unmount(); f.close();
});
