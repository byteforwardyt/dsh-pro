/** SuperCode delegates content and sending; the native chat owns every surface. */
window.__ModuleLoader__.load({
  id: '@dsh-desktop/client-ui-supercode', chunk: 'client.sessions.js',
  factory: require => {
    const React = require('react'), h = React.createElement;
    const { useEffect, useSyncExternalStore } = React;
    function createSessionIntegration(ctx, views) {
      const { request, Setup, Room, RoomHeader, Icon } = views;
      let snapshot = { data: null, drafts: {}, presentations: {}, errors: {}, busy: {}, error: '', pending: false }, stopped = false, timer;
      const listeners = new Set(), operations = new Set();
      const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
      const getSnapshot = () => snapshot;
      const update = patch => { snapshot = { ...snapshot, ...patch }; listeners.forEach(fn => fn()); };
      const roomFor = id => snapshot.data?.rooms.find(room => room.chatSessionId === id);
      const native = id => ctx.sessions.list.getSnapshot().byId[id];
      const present = (id, patch) => update({ presentations: { ...snapshot.presentations, [id]: { ...snapshot.presentations[id], ...patch } } });
      const draftUpdate = (id, patch) => update({ drafts: { ...snapshot.drafts, [id]: { ...snapshot.drafts[id], ...patch } } });
      function accept(room) {
        const data = snapshot.data;
        if (!data || data.rooms.some(old => old.id === room.id && old.revision > room.revision)) return;
        update({ data: { ...data, rooms: [room, ...data.rooms.filter(old => old.id !== room.id)] } });
      }
      function setDraft(id, value) {
        const drafts = { ...snapshot.drafts };
        if (value) drafts[id] = { ...value, enabled: true }; else delete drafts[id];
        update({ drafts, pending: false });
      }
      function followNavigation() {
        const sessions = Object.values(ctx.sessions.list.getSnapshot().byId);
        const selected = sessions.find(session => session.blank && session.retainedBy?.mainView > 0);
        const drafts = { ...snapshot.drafts };
        let changed = false;
        for (const [id, draft] of Object.entries(drafts)) {
          const session = native(id);
          if (draft.enabled && !roomFor(id) && session?.blank && session.retainedBy && !(session.retainedBy.mainView > 0)) {
            // Native workspace selection already carries the editor draft. Carry
            // only team choices when the destination is a different workspace.
            if (selected && selected.cwd !== session.cwd) drafts[selected.id] = { ...draft };
            drafts[id] = { ...draft, enabled: false }; changed = true;
          }
        }
        if (snapshot.pending && selected) { drafts[selected.id] = { ...drafts[selected.id], enabled: true, requestId: crypto.randomUUID() }; changed = true; }
        if (changed) update({ drafts, pending: false });
      }
      async function refresh() {
        try {
          const data = await request('/bootstrap');
          if (stopped) return;
          data.rooms = data.rooms.map(room => {
            const previous = snapshot.data?.rooms.find(old => old.id === room.id);
            return previous?.revision > room.revision ? previous : room;
          });
          update({ data, error: '' });
        } catch (error) { if (!stopped) update({ error: error.message }); }
      }
      async function mutate(id, fn) {
        if (operations.has(id)) throw Error('Wait for the current team action to finish.');
        operations.add(id); update({ busy: { ...snapshot.busy, [id]: true }, errors: { ...snapshot.errors, [id]: '' } });
        try { await fn(); return true; }
        catch (error) { update({ errors: { ...snapshot.errors, [id]: error.message } }); await refresh(); throw error; }
        finally { operations.delete(id); update({ busy: { ...snapshot.busy, [id]: false } }); }
      }
      const command = (id, action, payload = {}) => mutate(id, async () => {
        let current = roomFor(id);
        if (!current) throw Error('This team is not available. Reopen its chat.');
        if (action === 'replan-team' || (action === 'new-goal' && ['completed', 'stopped'].includes(current.status))) {
          if (action === 'replan-team') {
            if (!current.nextTeam || ['planning', 'running', 'discussing', 'pausing'].includes(current.status)) throw Error('Save your models and wait for the active response before replanning.');
            if (!['completed', 'stopped'].includes(current.status)) {
              current = await request('/rooms/' + current.id + '/command', { action: 'stop', revision: current.revision, requestId: crypto.randomUUID() }); accept(current);
            }
          }
          current = await request('/rooms/' + current.id + '/command', { action: 'new-run', goal: action === 'replan-team' ? current.goal : payload.text, revision: current.revision, requestId: crypto.randomUUID() }); accept(current);
          accept(await request('/rooms/' + current.id + '/command', { action: 'start', revision: current.revision, requestId: crypto.randomUUID() }));
          await ctx.sessions.refresh();
        } else accept(await request('/rooms/' + current.id + '/command', { ...payload, action, revision: current.revision, requestId: crypto.randomUUID() }));
      });
      async function submit(id, text, { session } = {}) {
        if (!text.trim()) throw Error('Enter a message for your team.');
        const room = roomFor(id), draft = snapshot.drafts[id] || {};
        if (room) {
          await command(id, draft.newGoal && ['completed', 'stopped'].includes(room.status) ? 'new-goal' : 'message', { text, recipient: draft.recipient || 'lead' });
          draftUpdate(id, { newGoal: false }); return;
        }
        await mutate(id, async () => {
          if (!draft.ready) throw Error('Choose a model for every agent before sending.');
          const workspace = snapshot.data?.workspaces.find(item => item.cwd === native(id)?.cwd);
          if (!workspace) throw Error('Choose a workspace for this chat.');
          const navigation = ctx.layout.beginNavigation();
          const permission = session?.projections?.faceOf('permissions').getSnapshot()?.currentValue;
          const next = await request('/rooms', { goal: text, workspaceId: workspace.id, members: draft.members, leadId: draft.leadId,
            limits: { minutes: Number(draft.minutes), calls: Number(draft.calls) }, permissionPreset: permission || 'workspace-write', requestId: draft.requestId || crypto.randomUUID() });
          accept(next); await ctx.sessions.refresh();
          if (!navigation.aborted) await ctx.uiWorkspace.openSession(next.chatSessionId);
          setDraft(id, null);
          accept(await request('/rooms/' + next.id + '/command', { action: 'start', revision: next.revision, requestId: crypto.randomUUID() }));
        });
      }
      function Launch() {
        useEffect(() => { update({ pending: true }); ctx.uiWorkspace.startSession(); followNavigation(); }, []);
        return h('div', { role: 'status' }, 'Choose a workspace for your SuperCode chat…');
      }
      function Mode({ sessionId, useSessions, useInput }) {
        const state = useSyncExternalStore(subscribe, getSnapshot), session = useSessions(value => value.byId[sessionId]);
        const input = useInput(value => value), changing = input && input.phase !== 'plain';
        const room = roomFor(sessionId), enabled = !!state.drafts[sessionId]?.enabled;
        if (room) return h('div', { className: 'sc-native-tools' }, h(RoomHeader, { room, showTasks: state.presentations[sessionId]?.showTasks,
          onTasks: () => present(sessionId, { showTasks: !state.presentations[sessionId]?.showTasks }),
          onMember: selectedMember => present(sessionId, { selectedMember }) }));
        if (!session?.blank) return null;
        return h('button', { type: 'button', className: 'sc-mode-button', 'aria-pressed': enabled, disabled: changing,
          title: changing ? 'Finish or clear the current command before changing chat type.' : 'Chat type',
          onClick: () => { if (changing) return; enabled ? setDraft(sessionId, null) : setDraft(sessionId, state.drafts[sessionId] || { requestId: crypto.randomUUID() }); } }, h(Icon, { size: 16 }), 'SuperCode');
      }
      function Mark({ sessionId }) {
        useSyncExternalStore(subscribe, getSnapshot);
        return roomFor(sessionId) ? h('span', { title: 'SuperCode chat', 'aria-label': 'SuperCode chat' }, h(Icon, { size: 16 })) : null;
      }
      function Surface({ sessionId, part }) {
        const state = useSyncExternalStore(subscribe, getSnapshot), room = roomFor(sessionId), busy = !!state.busy[sessionId];
        if (!state.data) return h('span', { role: 'status' }, 'Loading models…');
        const props = { room, data: state.data, busy, draft: state.drafts[sessionId], onDraft: values => draftUpdate(sessionId, values),
          presentation: state.presentations[sessionId], onPresentation: patch => present(sessionId, patch),
          command: (...args) => command(sessionId, ...args).catch(() => false), nativePart: part };
        return h('div', { className: 'dsh-supercode sc-native-' + part, 'aria-label': part === 'transcript' ? 'SuperCode chat' : 'Team settings' },
          part === 'transcript' && (state.errors[sessionId] || state.error) ? h('p', { className: 'sc-banner', role: 'alert' }, state.errors[sessionId] || state.error) : null,
          part === 'transcript' ? state.data.recoveryErrors?.filter(item => item.roomId === room?.id).map(item => h('p', { key: item.roomId, className: 'sc-banner', role: 'alert' }, item.message)) : null,
          room ? h(Room, props) : h(Setup, { ...props, workspaceId: state.data.workspaces.find(item => item.cwd === native(sessionId)?.cwd)?.id || '', onCancel: () => setDraft(sessionId, null) }));
      }
      function resolve(id) {
        const room = roomFor(id), draft = snapshot.drafts[id];
        if (!room && !draft?.enabled && !(snapshot.pending && native(id)?.blank)) return;
        return { active: !!room, running: room && ['planning', 'running', 'discussing'].includes(room.status),
          blocked: snapshot.busy[id] ? 'Saving team changes…' : !snapshot.data ? 'Loading team models…' : !room && !draft?.ready ? 'Choose a team model before sending.' : room?.nextTeam && !draft?.newGoal ? 'Replan with your saved models, or choose New goal.' : undefined,
          content: h(Surface, { sessionId: id, part: 'transcript' }), modelControl: h(Surface, { sessionId: id, part: 'controls' }),
          openOptions: () => draftUpdate(id, { showAgents: true }), submit: (text, options) => submit(id, text, options), cancel: () => command(id, 'stop') };
      }
      function install() {
        if (!ctx.conversation?.delegates) throw Error('SuperCode requires the native conversation delegate. Rebuild the desktop runtime.');
        ctx.effect(() => ctx.conversation.delegates.register({ resolve, subscribe }));
        ctx.effect(() => {
          const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(poll, 2000); }; void poll();
          const off = ctx.sessions.list.subscribe(followNavigation);
          return () => { stopped = true; off(); clearTimeout(timer); listeners.clear(); };
        });
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'supercode' }, Launch));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'supercode', order: -100, label: () => 'New SuperCode' }, Icon));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'supercode-mode', order: 20 }, Mode));
        ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'supercode-mark', order: 10 }, Mark));
      }
      return { install, Launch, Mode, Mark, Surface, resolve, submit, command, roomFor, accept, refresh, setDraft, getSnapshot };
    }
    return { createSessionIntegration };
  },
});
