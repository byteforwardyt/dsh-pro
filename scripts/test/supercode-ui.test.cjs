const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadClient } = require('./helpers/client-harness.cjs');
const manifest = require('../../plugins/client-ui-supercode/package.json');
const MarkdownText = function MarkdownText() {};
const MarkdownDelegateProvider = function MarkdownDelegateProvider() {};
const plain = value => JSON.parse(JSON.stringify(value));
const catalog = [{ id: 'provider', label: 'Connected account', models: [
  { id: 'lead-model', name: 'Lead model' },
  { id: 'builder-model', name: 'Builder model' }, { id: 'hidden-model', name: 'Hidden model' },
] }];
const bootstrap = { rooms: [], workspaces: [{ id: 'workspace', cwd: '/project', name: 'Project' }], catalog, selections: { provider: ['lead-model', 'builder-model'] } };
const makeRoom = () => ({ id: 'room', title: 'Build feature', workspace: bootstrap.workspaces[0], goal: 'Build feature', revision: 1,
  members: [{ id: 'lead', name: 'Lead', role: 'Coordinator', provider: 'provider', model: 'lead-model' }, { id: 'builder', name: 'Builder', role: 'Implementation', provider: 'provider', model: 'builder-model' }],
  leadId: 'lead', status: 'draft', phase: 'planning', messages: [], tasks: [], memberStates: {}, usage: { calls: 0 }, limits: { calls: 200, minutes: 60 } });
const modelInfo = { id: 'lead-model', name: 'Lead model', reasoning: { efforts: [{ id: 'low', name: 'Quick' }, { id: 'high', name: 'Thorough' }] } };
function fixture(fetcher = async url => ({ ok: true, json: async () => url.includes('/model?') ? modelInfo : bootstrap })) {
  let api;
  const client = loadClient('client-ui-supercode', fetcher, { slot: 'main', onModule: value => { api = value; },
    modules: { '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText, MarkdownDelegateProvider }, './client.sessions.js': { createSessionIntegration: () => ({ install() {} }) } },
    globals: { crypto: { randomUUID: () => 'request-id' }, document: { baseURI: 'http://127.0.0.1:4321/', head: { appendChild() {} }, createElement: () => ({ remove() {} }), querySelector: () => null } } });
  return { ...client, api };
}
const button = (view, text) => view.find(node => node.type === 'button' && (node.props.children.includes(text) || node.props['aria-label'] === text));
const field = (view, name) => {
  const label = view.find(node => node.type === 'label' && node.props.children.includes(name));
  assert.ok(label, 'Missing label: ' + name);
  return label.props.htmlFor
    ? view.find(node => node.props.id === label.props.htmlFor)
    : label.props.children.find(node => typeof node === 'object');
};

test('new SuperCode requires an explicit model choice and exposes it directly in the composer', async () => {
  const requests = [], client = fixture(async url => { requests.push(url); return { ok: true, json: async () => modelInfo }; });
  let latest;
  const setup = await client.mount({ data: bootstrap, workspaceId: 'workspace', onDraft: value => { latest = value; } }, client.api.Setup).flush();
  const choice = setup.find(node => node.type === client.api.TeamModelSelect);
  assert(choice);
  assert(choice.props.members.every(member => !member.provider && !member.model));
  assert.equal(requests.length, 0);
  assert.equal(latest.ready, false);
  assert.equal(setup.find(node => node.type === 'textarea' || node.type === 'form'), undefined);
  const selectView = await client.mount(choice.props, client.api.TeamModelSelect).flush();
  const select = selectView.find(node => node.type === 'select');
  assert.equal(select.props.value, '');
  assert.equal(select.props['aria-label'], 'Team model');
  assert.equal(selectView.find(node => node.type === 'option' && node.props.value.includes('hidden-model')), undefined);
  select.props.onChange({ target: { value: JSON.stringify(['provider', 'builder-model']) } }); await setup.flush();
  assert(setup.find(node => node.type === client.api.TeamModelSelect).props.members.every(member => member.model === 'builder-model'));
  assert.equal(requests.length, 1);
  assert.equal(latest.ready, true);
  selectView.unmount(); setup.unmount();
});

test('idle-room model editor saves selected metadata only and never switches an active team', async () => {
  const client = fixture(), room = { ...makeRoom(), status: 'blocked' }, calls = [];
  const view = await client.mount({ room, nativePart: 'controls', data: bootstrap, command: async (action, payload) => { calls.push({ action, payload }); return true; } }, client.api.Room).flush();
  button(view, 'Models').props.onClick(); await view.flush();
  const editor = view.find(node => node.type === client.api.TeamEditor);
  assert(editor);
  const panel = await client.mount(editor.props, client.api.TeamEditor).flush();
  const choice = panel.find(node => node.type === client.api.TeamModelSelect);
  choice.props.onChange(choice.props.members.map(member => ({ ...member, model: 'builder-model', effort: undefined })));
  await panel.flush(); assert.deepEqual(calls, []);
  await button(panel, 'Save models').props.onClick(); await view.flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].action, 'team');
  assert(calls[0].payload.members.every(member => member.model === 'builder-model'));
  assert.equal(view.find(node => node.type === client.api.TeamEditor), undefined);
  view.setProps({ room: { ...room, status: 'running' }, nativePart: 'controls', data: bootstrap, command() {} }); await view.flush();
  assert.equal(button(view, 'Models').props.disabled, true);
  panel.unmount(); view.unmount();
});

test('expired credentials have one friendly notice and collapsed technical details, never a duplicate header error', async () => {
  const client = fixture(), room = { ...makeRoom(), status: 'blocked', reason: 'OAuth refresh failed for openai-codex: 401 {"code":"refresh_token_expired","message":"Your session has expired. Please log in again."}' };
  const calls = [], view = await client.mount({ room, command: action => calls.push(action) }, client.api.Room).flush();
  const notice = view.find(node => node.props.className === 'sc-checkpoint');
  assert.ok(notice);
  const status = view.find(node => node.props.role === 'status');
  assert.equal(status.props.children[0], 'OpenAI Codex needs you to sign in again. Reconnect it in Settings → Accounts, then continue this chat.');
  assert.equal(view.find(node => node.props.className === 'sc-room-notice'), undefined);
  const details = view.find(node => node.type === 'details');
  assert.equal(details.props.open, undefined);
  assert.equal(view.find(node => node.type === 'pre').props.children[0], room.reason);
  assert.deepEqual(calls, [], 'Rendering an auth problem must not retry paid calls');
  view.unmount();
});

test('an idle conversation has no task-plan or Continue checkpoint', async () => {
  const client = fixture(), room = { ...makeRoom(), status: 'draft', chatOnly: true, messages: [{ id: 'greeting', kind: 'agent', memberId: 'lead', text: 'Hi!', createdAt: Date.now() }] };
  const view = await client.mount({ room, command() {} }, client.api.Room).flush();
  assert.equal(button(view, 'Continue'), undefined);
  assert.equal(button(view, 'Approve plan'), undefined);
  assert.equal(view.find(node => node.props.className === 'sc-checkpoint'), undefined);
  const transcript = await client.mount({ room }, client.api.Messages).flush();
  assert(transcript.find(node => node.type === 'button' && node.props.children.includes('Team conversation')));
  view.unmount(); transcript.unmount();
});
async function setupModels(view, goal = 'Implement scoped work') {
  const choice = view.find(node => node.props.members && node.props.onChange && node.props.data && node.type.name === 'TeamModelSelect');
  if (choice?.props.members.every(member => !member.model)) {
    choice.props.onChange(choice.props.members.map(member => ({ ...member, provider: 'provider', model: 'lead-model' })));
    await view.flush();
  }
  await view.flush(); button(view, 'Models and agents').props.onClick(); await view.flush();
}

test('packaged SuperCode declares the native Markdown renderer and root layout dependencies', () => {
  for (const dependency of ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-sidebar']) {
    assert.ok(manifest.dsh.client.inject.includes(dependency), 'Missing client dependency: ' + dependency);
  }
});

test('rich messages wire native Markdown with workspace-scoped file and image delegates', async () => {
  const client = fixture(), opened = [], text = '### Heading\n\n**Important**\n\n| A | B |\n|---|---|\n| 1 | 2 |';
  client.document.baseURI = 'http://127.0.0.1:4321/';
  const view = await client.mount({ text, workspace: { cwd: '/project' }, onOpen: target => opened.push(target) }, client.api.RichMessage).flush();
  assert.equal(view.tree.props.className, 'sc-rich');
  const renderer = view.find(node => node.type === MarkdownText);
  assert.equal(renderer.props.text, text); assert.equal(renderer.props.variant, 'body');
  assert.equal(renderer.props.labels.code.copyLabel, 'Copy');
  assert.equal(view.find(node => node.props.dangerouslySetInnerHTML), undefined);
  const delegate = view.find(node => node.type === MarkdownDelegateProvider);
  delegate.props.openFile('src/app.js', { line: 42 });
  for (const value of ['../../private/key.txt', '/project-other/file.md', 'javascript:alert(1)', 'https://example.com/file.md']) delegate.props.openFile(value);
  assert.deepEqual(plain(opened), [{ type: 'file', path: '/project/src/app.js', line: 42 }]);
  assert.equal(renderer.props.pathImages.resolve('images/result.png'), 'http://127.0.0.1:4321/dsh-files/raw?path=%2Fproject%2Fimages%2Fresult.png');
  for (const value of ['../../private/image.png', 'https://example.com/image.png', 'script.svg', 'README.md']) assert.equal(renderer.props.pathImages.resolve(value), undefined);
  view.unmount();
});

test('room body has no duplicate header; native header controls open the task board', async () => {
  const client = fixture(), room = { ...makeRoom(), status: 'running', phase: 'execution' };
  let presentation = {};
  const props = () => ({ room, busy: false, command() {}, presentation });
  const view = await client.mount(props(), client.api.Room).flush();
  const head = await client.mount({ room, onTasks: () => { presentation = { showTasks: !presentation.showTasks }; view.setProps(props()); } }, client.api.RoomHeader).flush();
  assert.equal(view.find(node => node.type === 'header'), undefined);
  assert.equal(head.tree.props['aria-label'], 'SuperCode team controls');
  assert.equal(button(view, 'Pause'), undefined); assert.equal(button(view, 'Stop'), undefined);
  assert.equal(button(view, 'Cancel response'), undefined, 'Native InputBar owns cancellation');
  assert.ok(view.find(node => node.type === client.api.Messages));
  assert.equal(view.find(node => node.type === client.api.Board), undefined, 'Tasks must not crowd the group conversation');
  button(head, 'Tasks').props.onClick(); await view.flush();
  assert.ok(view.find(node => node.type === client.api.Board));
  button(head, 'Tasks').props.onClick(); await view.flush();
  assert.equal(view.find(node => node.type === client.api.Board), undefined);
  view.unmount(); head.unmount();
});

test('message avatars retain roster accents and checkpoint usage resets without hiding total calls', async () => {
  const client = fixture(), room = makeRoom();
  room.status = 'paused'; room.usage = { calls: 203, activeMs: 3660000 };
  room.checkpoint = { calls: 200, activeMs: 3600000 };
  room.messages = [{ id: 'message', kind: 'agent', memberId: 'builder', text: 'Ready for review.', createdAt: Date.now() }];
  const messages = await client.mount({ room }, client.api.Messages).flush();
  const article = messages.find(node => node.type === 'article');
  assert.ok(article.props.style['--sc-color']);
  assert.equal(messages.find(node => node.props.className === 'sc-avatar').props.children[0], 'B');
  const view = await client.mount({ room }, client.api.RoomHeader).flush();
  const usage = view.find(node => node.props.className === 'sc-usage');
  assert.match(usage.props.children[1].props.children[0], /^3\/200 calls · 1\/60 min/);
  assert.match(usage.props.title, /^203 total model calls/);
  messages.unmount(); view.unmount();
});

test('member choices respect visibility and retain an unavailable saved selection without silently replacing it', async () => {
  const client = fixture(), { api } = client;
  assert.deepEqual(plain(api.availableModels(bootstrap).map(model => model.id)), ['lead-model', 'builder-model']);
  const member = { id: 'lead', name: 'Lead', role: 'Lead', provider: 'provider', model: 'hidden-model', effort: 'old-effort' };
  assert.deepEqual(plain(api.availableModels(bootstrap, member).map(model => model.id)), ['lead-model', 'builder-model', 'hidden-model']);
  let changed;
  const view = await client.mount({ member, index: 0, data: bootstrap, details: { status: 'ready', model: modelInfo }, onChange: value => { changed = value; }, onRemove() {}, removable: false }, api.MemberForm).flush();
  field(view, 'Reasoning effort').props.onChange({ target: { value: '' } });
  assert.equal(changed.effort, undefined);
  const missing = { ...member, model: 'gone' };
  view.setProps({ member: missing, index: 0, data: bootstrap, onChange() {}, onRemove() {}, removable: false }); await view.flush();
  assert.ok(view.find(node => node.type === 'option' && node.props.children[0].includes('gone · unavailable')));
  assert.deepEqual(plain(api.efforts({ reasoning: { efforts: ['medium', 'high'] } })), ['medium', 'high']);
  view.unmount();
});

test('group composer preserves independent agents without a setup wizard and sends only on submit', async () => {
  const client = fixture(); let saved;
  const setup = await client.mount({ data: bootstrap, busy: false, workspaceId: 'workspace', onDraft: value => { saved = value; } }, client.api.Setup).flush();
  assert.equal(saved.ready, false);
  assert.equal(button(setup, 'Continue'), undefined);
  assert.equal(setup.find(node => node.type === client.api.MemberForm), undefined);
  assert.equal(setup.find(node => node.type === 'textarea'), undefined);
  await setupModels(setup);
  assert.equal(saved.ready, true, 'Configuration only publishes composer readiness');
  const member = setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'builder');
  member.props.onChange({ ...member.props.member, model: 'builder-model' }); await setup.flush();
  const lead = setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'lead');
  lead.props.onChange({ ...lead.props.member, effort: 'high' }); await setup.flush();
  setup.find(node => node.type === client.api.AgentPicker).props.onClose(); await setup.flush();
  assert.equal(setup.find(node => node.type === client.api.MemberForm), undefined);
  button(setup, 'Models and agents').props.onClick(); await setup.flush();
  assert.equal(setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'builder').props.member.model, 'builder-model');
  assert.equal(setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'lead').props.member.effort, 'high');
  assert.equal(button(setup, 'Send'), undefined);
  assert.equal(saved.ready, true);
  assert.equal(saved.members.find(item => item.id === 'builder').model, 'builder-model');
  assert.equal(saved.members.find(item => item.id === 'lead').model, 'lead-model');
  assert.equal(saved.members.find(item => item.id === 'lead').effort, 'high');
  assert.equal(saved.action, undefined);
  setup.unmount();
});

test('task dependency editing keeps a trailing separator until submit and emits the full task', async () => {
  const client = fixture(); let saved;
  const view = await client.mount({ task: { id: 'task-3', title: 'Verify', dependencies: ['task-1'] }, room: makeRoom(), busy: false, onSave: task => { saved = task; }, onCancel() {} }, client.api.TaskEditor).flush();
  const name = 'Dependencies (task IDs, separated by commas)';
  field(view, name).props.onChange({ target: { value: 'task-1, ' } }); await view.flush();
  assert.equal(field(view, name).props.value, 'task-1, ');
  field(view, name).props.onChange({ target: { value: 'task-1, task-2' } }); await view.flush();
  view.tree.props.onSubmit({ preventDefault() {} });
  assert.deepEqual(plain(saved.dependencies), ['task-1', 'task-2']); assert.equal(saved.id, 'task-3');
  view.unmount();
});

test('running controls require explicit approval and completed rooms offer a new run', async () => {
  const client = fixture(), room = makeRoom(), commands = [];
  const view = await client.mount({ room, busy: false, command: (...args) => { commands.push(args); }, onNewRun() {} }, client.api.Room).flush();
  assert.ok(button(view, 'Continue')); assert.equal(button(view, 'Approve plan'), undefined);
  view.setProps({ room: { ...room, status: 'awaiting-approval', tasks: [{ id: 'a', status: 'ready' }] }, busy: false, command: (...args) => { commands.push(args); }, onNewRun() {} }); await view.flush();
  button(view, 'Approve plan').props.onClick(); assert.equal(commands[0][0], 'approve');
  view.setProps({ room: { ...room, status: 'completed' }, busy: false, command() {}, onNewRun() {} }); await view.flush();
  assert.equal(button(view, 'Continue chat'), undefined); assert.equal(view.find(node => node.type === 'textarea'), undefined, 'Native editor stays outside the transcript');
  view.unmount();
});

test('blocked rooms can receive guidance, edit blocked tasks, resume or stop without starting a new run', async () => {
  const client = fixture(), room = { ...makeRoom(), status: 'blocked', tasks: [{ id: 'a', title: 'Retry task', status: 'blocked', dependencies: [], criteria: 'Verified result', evidence: [] }] };
  const view = await client.mount({ room, busy: false, command() {}, onNewRun() {} }, client.api.Room).flush();
  assert.ok(button(view, 'Continue')); assert.equal(button(view, 'Stop'), undefined); assert.equal(button(view, 'New run'), undefined);
  assert.equal(view.find(node => node.type === 'textarea'), undefined, 'Native editor stays outside the transcript');
  const header = await client.mount({ room }, client.api.RoomHeader).flush();
  assert.ok(header.find(node => node.props.className === 'sc-usage').props.children[1].props.children.includes(' · Cost unavailable'));
  const board = await client.mount({ room, busy: false, command() {} }, client.api.Board).flush();
  assert.ok(button(board, 'Add task'));
  assert.ok(board.find(node => node.props.task?.id === 'a').props.editable);
  const editor = await client.mount({ task: room.tasks[0], room, busy: false, workspaceId: 'workspace', onDraft() {}, onCancel() {} }, client.api.TaskEditor).flush();
  assert.deepEqual(plain(field(editor, 'Status').props.children.map(option => option.props.value)), ['backlog', 'ready', 'blocked', 'cancelled']);
  [view, header, board, editor].forEach(instance => instance.unmount());
});

test('past run messages retain the original member identity after the roster changes', async () => {
  const client = fixture(), room = makeRoom();
  room.runId = 'new'; room.members[0].name = 'New lead';
  room.history = [{ runId: 'old', members: [{ id: 'lead', name: 'Original lead' }] }];
  room.messages = [{ id: 'm1', runId: 'old', memberId: 'lead', kind: 'agent', text: 'Original evidence', createdAt: 1 }];
  const view = await client.mount({ room }, client.api.Messages).flush();
  assert.ok(view.find(node => node.type === 'strong' && node.props.children.includes('Original lead')));
  assert.equal(view.find(node => node.type === 'strong' && node.props.children.includes('New lead')), undefined);
  view.unmount();
});

test('exact model metadata supplies effort ids and display names, and stale lookup results cannot replace it', async () => {
  const pending = []; let saved;
  const client = fixture((url, init) => new Promise(resolve => pending.push({ url, signal: init.signal, resolve })));
  const setup = await client.mount({ data: bootstrap, busy: false, workspaceId: 'workspace', onDraft: value => { saved = value; } }, client.api.Setup).flush();
  assert.equal(pending.length, 0, 'opening a new chat must not choose a model');
  await setupModels(setup);
  assert.equal(pending.length, 1, 'three members explicitly sharing a model use one lookup');
  assert.equal(pending[0].url, '/dsh-supercode/model?provider=provider&model=lead-model');
  assert.equal(saved.ready, false);
  const builder = setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'builder');
  builder.props.onChange({ ...builder.props.member, model: 'builder-model' }); await setup.flush();
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve({ ok: true, json: async () => ({ reasoning: { efforts: [{ id: 'stale', name: 'Wrong' }] } }) }); await setup.flush();
  assert.equal(setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'lead').props.details.status, 'loading');
  for (const item of pending.slice(1)) item.resolve({ ok: true, json: async () => item.url.endsWith('lead-model') ? modelInfo : { id: 'builder-model' } });
  await setup.flush();
  const lead = setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'lead');
  const view = await client.mount(lead.props, client.api.MemberForm).flush();
  const choices = field(view, 'Reasoning effort').props.children;
  assert.deepEqual(plain(choices.filter(Boolean).map(choice => [choice.props.value, choice.props.children[0]])), [['', 'Model default'], ['low', 'Quick'], ['high', 'Thorough']]);
  assert.equal(view.find(node => node.type === 'option' && node.props.value === 'stale'), undefined);
  [view, setup].forEach(instance => instance.unmount());
});

test('model lookup failures are visible and retryable; unsupported saved effort blocks creation until explicitly changed', async () => {
  let fail = true, saved;
  const room = makeRoom(); room.members[0].effort = 'removed';
  const client = fixture(async () => ({ ok: !fail, status: fail ? 503 : 200, json: async () => fail ? { error: 'Credentials unavailable. Reconnect this account.' } : modelInfo }));
  const setup = await client.mount({ data: bootstrap, room, busy: false, workspaceId: 'workspace', onDraft: value => { saved = value; } }, client.api.Setup).flush();
  await setupModels(setup, 'Continue safely');
  let lead = setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'lead');
  const view = await client.mount(lead.props, client.api.MemberForm).flush();
  assert.ok(view.find(node => node.props.role === 'alert').props.children[0].includes('Credentials unavailable'));
  assert.equal(lead.props.member.model, 'lead-model'); assert.equal(lead.props.member.effort, 'removed');
  assert.equal(saved.ready, false);
  fail = false; button(view, 'Retry model details').props.onClick(); await setup.flush();
  lead = setup.find(node => node.type === client.api.MemberForm && node.props.member.id === 'lead');
  view.setProps(lead.props); await view.flush();
  assert.ok(view.find(node => node.props.role === 'alert').props.children[0].includes('saved effort'));
  assert.equal(saved.ready, false);
  field(view, 'Reasoning effort').props.onChange({ target: { value: '' } }); await setup.flush();
  assert.equal(saved.ready, true);
  assert.equal(saved.members[0].effort, undefined);
  [view, setup].forEach(instance => instance.unmount());
});

test('non-revision 409 errors retain the actual provider or workspace explanation', async () => {
  const reason = 'Another SuperCode run is active in this workspace. Pause it first.';
  const client = fixture(async () => ({ ok: false, status: 409, json: async () => ({ error: reason }) }));
  await assert.rejects(client.api.request('/rooms/room/command', { action: 'approve' }), error => {
    assert.equal(error.message, reason); assert.equal(error.revisionConflict, false); return true;
  });
});

test('interleaved tools stay under their agent in expandable activity without losing any evidence', async () => {
  const client = fixture(), room = makeRoom();
  room.messages = [
    { id: 't1', runId: 'run', memberId: 'lead', taskId: 'plan', kind: 'tool', name: 'read', text: 'Tool completed.' },
    { id: 't2', runId: 'run', memberId: 'builder', taskId: 'build', kind: 'tool', name: 'write', text: 'Tool completed.' },
    { id: 't3', runId: 'run', memberId: 'lead', taskId: 'plan', kind: 'tool', name: 'glob', text: 'Tool completed.' },
    { id: 't4', runId: 'run', memberId: 'lead', taskId: 'plan', kind: 'tool', name: 'rg', text: 'Tool completed.' },
    { id: 'm1', runId: 'run', memberId: 'lead', taskId: 'plan', kind: 'agent', text: 'Found the relevant files.' },
    { id: 'm2', runId: 'run', memberId: 'builder', taskId: 'build', kind: 'agent', text: 'Implementation submitted.' },
  ];
  const groups = client.api.groupMessages(room.messages);
  assert.deepEqual(plain(groups.map(group => [group.message.id, group.activity.map(item => item.id)])), [['m1', ['t1', 't3', 't4']], ['m2', ['t2']]]);
  const view = await client.mount({ room, onOpen() {} }, client.api.Messages).flush();
  const activity = view.find(node => node.props.className === 'sc-activity');
  assert.equal(activity.type, 'div'); assert.equal(activity.props['aria-label'], 'Tool activity');
  const details = activity.props.children[0];
  assert.equal(details.type, 'details'); assert.equal(details.props.open, undefined);
  assert.ok(details.props.children[0].props.children.includes('3 tool actions'));
  assert.deepEqual(plain(details.props.children[1].props.children.map(node => node.props.children[0].props.children[0])), ['read', 'glob', 'rg']);
  view.unmount();
});

test('discussion preserves actual public messages and shows a separate lead result only for confirmed completion', async () => {
  const client = fixture(), room = { ...makeRoom(), runId: 'current', status: 'running', messages: [
    { id: 'user', runId: 'current', kind: 'user', text: 'Build it.' },
    { id: 'finding', runId: 'current', kind: 'agent', memberId: 'builder', text: 'I found the issue.' },
    { id: 'summary', runId: 'current', kind: 'agent', memberId: 'lead', text: 'Verified output.' },
  ] };
  const view = await client.mount({ room, onOpen() {} }, client.api.Messages).flush();
  const toggle = () => view.find(node => node.props.className === 'sc-discussion-toggle');
  assert.equal(toggle().props['aria-expanded'], true);
  assert.equal(view.find(node => node.props.className === 'sc-message is-result'), undefined);
  toggle().props.onClick(); await view.flush();
  assert.equal(view.find(node => node.props.className === 'sc-discussion-body').props.hidden, true);
  toggle().props.onClick(); await view.flush();
  view.tree.props.onScroll({ currentTarget: { scrollHeight: 2000, scrollTop: 0, clientHeight: 500 } });
  view.setProps({ room: { ...room, status: 'completed' }, onOpen() {} }); await view.flush();
  assert.equal(toggle().props['aria-expanded'], true, 'Completion must not collapse content someone is reading');
  assert.ok(view.find(node => node.props.className === 'sc-message is-result'));
  assert.equal(client.api.conversationGroups({ ...room, status: 'blocked' })[0].final, undefined);
  view.unmount();
  const reopened = await client.mount({ room: { ...room, status: 'completed' }, onOpen() {} }, client.api.Messages).flush();
  assert.equal(reopened.find(node => node.props.className === 'sc-discussion-toggle').props['aria-expanded'], false);
  assert.ok(reopened.find(node => node.props.className === 'sc-message is-result'));
  reopened.unmount();
});

test('avatar interaction selects a real member and changes only the addressed composer target', async () => {
  const calls = [], client = fixture(async url => { calls.push(url); return { ok: true, json: async () => bootstrap }; }), room = { ...makeRoom(), status: 'running' };
  let selected;
  const stack = await client.mount({ members: room.members, states: { builder: 'Working' }, onSelect: member => { selected = member; } }, client.api.AvatarStack).flush();
  button(stack, 'About Builder').props.onClick(); assert.equal(selected.id, 'builder');
  assert.equal(button(stack, 'About Builder').props['data-active'], true);
  assert.equal(button(stack, 'About Lead').props['data-active'], false);
  let presentation = {}, draft = { text: 'Please review this.' };
  const props = () => ({ room, command() {}, draft, onDraft: patch => { draft = { ...draft, ...patch }; view.setProps(props()); }, presentation, onPresentation: patch => { presentation = { ...presentation, ...patch }; view.setProps(props()); } });
  const view = await client.mount(props(), client.api.Room).flush();

  view.find(node => node.type === client.api.Messages).props.onMember(selected); await view.flush();
  view.find(node => node.type === client.api.MemberCard).props.onMessage('builder'); await view.flush();
  assert.equal(draft.recipient, 'builder');
  assert.equal(draft.text, 'Please review this.');
  assert.equal(calls.length, 0, 'Inspecting an avatar must not invoke models or commands');
  stack.unmount(); view.unmount();
});

test('team controls leave the native hero, workspace picker and editor untouched', async () => {
  const client = fixture(), view = await client.mount({ data: bootstrap, workspaceId: 'workspace', onDraft() {} }, client.api.Setup).flush();
  assert.equal(view.find(node => ['textarea', 'form', 'h2'].includes(node.type)), undefined);
  assert.equal(view.find(node => node.props.className === 'sc-welcome'), undefined);
  view.unmount();
});

test('evidence references open only normalized workspace paths through UI actions', async () => {
  const client = fixture(), workspace = { cwd: '/project' }, opened = [];
  for (const input of ['file:///etc/passwd', 'javascript:alert(1)', '../../private/key.txt', '/project-other/file.md', 'https://example.com/file.md']) {
    assert.equal(client.api.evidenceTarget(input, workspace), null);
  }
  assert.deepEqual(plain(client.api.evidenceTarget('./src/../src/app.js:42', workspace)), { type: 'file', path: '/project/src/app.js', line: 42 });
  const view = await client.mount({ workspace, text: 'See [test results](artifacts/test results.log) and `src/app.js:42`. https://example.com/file.md file:///etc/passwd', onOpen: value => opened.push(value) }, client.api.EvidenceText).flush();
  const links = view.tree.props.children.filter(node => node?.type === 'button');
  assert.equal(links.length, 2); assert.equal(links[0].props.children[0], 'test results');
  links.forEach(link => link.props.onClick());
  assert.deepEqual(plain(opened), [{ type: 'file', path: '/project/artifacts/test results.log' }, { type: 'file', path: '/project/src/app.js', line: 42 }]);
  view.unmount();
});

test('evidence viewer uses existing safe file and Git GET APIs and renders HTML as text', async () => {
  const calls = []; let closed = 0;
  const client = fixture(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.includes('/git?') ? { workingDiff: '+verified', stagedDiff: '', files: [] } : { kind: 'text', text: '<script>neverExecute()</script>\nResult: passed' } };
  });
  const view = await client.mount({ target: { type: 'file', path: '/project/artifact.html', line: 2 }, workspace: { cwd: '/project' }, onClose: () => { closed++; }, onOpen() {} }, client.api.EvidencePanel).flush();
  assert.equal(calls[0].url, '/dsh-files/read?path=%2Fproject%2Fartifact.html');
  assert.equal(calls[0].options.credentials, 'same-origin'); assert.equal(calls[0].options.method, undefined);
  assert.equal(view.find(node => node.type === 'script'), undefined);
  assert.ok(view.find(node => node.type === 'span' && node.props.children[0].includes('<script>neverExecute()')));
  assert.ok(view.find(node => node.props.className === 'sc-highlight').props.children[0].includes('Result: passed'));
  view.setProps({ target: { type: 'diff' }, workspace: { cwd: '/project' }, onClose: () => { closed++; }, onOpen() {} }); await view.flush();
  assert.equal(calls[1].url, '/dsh-files/git?root=%2Fproject');
  button(view, 'Close evidence').props.onClick({ type: 'click' }); assert.equal(closed, 1);
  view.unmount();
});

test('previous runs retain a collapsed, read-only task board and original roster for evidence', async () => {
  const client = fixture(), room = makeRoom();
  room.history = [{ runId: 'past-run', goal: 'Original goal', status: 'completed', members: [{ id: 'lead', name: 'Original lead', provider: 'provider', model: 'old-model' }],
    tasks: [{ id: 'past-task', title: 'Completed task', ownerId: 'lead', status: 'done', criteria: 'See README.md', evidence: ['artifacts/results.log'], dependencies: [], review: { memberId: 'reviewer', verdict: 'pass', evidence: ['Read src/app.js'] } }] }];
  const view = await client.mount({ room, onOpen() {} }, client.api.PreviousRuns).flush();
  assert.equal(view.tree.type, 'details'); assert.equal(view.tree.props.open, undefined);
  const card = view.find(node => node.type === client.api.TaskCard);
  assert.equal(card.props.editable, false); assert.equal(card.props.onSave, undefined);
  assert.equal(card.props.room.members[0].name, 'Original lead');
  assert.deepEqual(plain(card.props.task.evidence), ['artifacts/results.log']);
  assert.ok(view.find(node => node.type === 'p').props.children[0].includes('old-model'));
  view.unmount();
});
