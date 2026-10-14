window.__ModuleLoader__.load({
  id: '@dsh-desktop/client-ui-model-visibility',
  factory: (require) => {
    const React = require('react'), h = React.createElement;
    const { useEffect, useState, useSyncExternalStore } = React;

    function visible(selections, provider, model) {
      return !Object.hasOwn(selections, provider) || selections[provider].includes(model);
    }
    function project(state, selections) {
      return { ...state, groups: state.groups.map(group => ({ ...group,
        models: group.models.filter(model => visible(selections, group.id, model.id)
          || (state.current?.provider === group.id && state.current.model === model.id)),
      })).filter(group => group.models.length) };
    }
    async function request(path = '', body) {
      const response = await fetch('/dsh-model-visibility' + path, { credentials: 'same-origin',
        signal: AbortSignal.timeout(15000),
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(response.status === 409
        ? 'Preferences changed in another window. Refresh, then try again.'
        : 'Could not load or save model preferences. Please retry.');
      return response.json();
    }
    function createPreferences() {
      let state = { selections: {}, revision: 0, ready: false, error: '', busy: false };
      let generation = 0, disposed = false;
      const listeners = new Set();
      const publish = change => { if (!disposed) { state = { ...state, ...change }; listeners.forEach(fn => fn()); } };
      return {
        getSnapshot: () => state,
        subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
        async refresh() {
          if (state.busy) return;
          const serial = ++generation;
          try { const data = await request(); if (serial === generation) publish({ ...data, ready: true, error: '' }); }
          catch (error) { if (serial === generation) publish({ error: error.message }); }
        },
        async save(provider, models) {
          if (!state.ready || state.busy) return;
          ++generation; publish({ busy: true, error: '' });
          try { publish({ ...await request('', { provider, models, revision: state.revision }), ready: true }); }
          catch (error) { publish({ error: error.message }); }
          finally { publish({ busy: false }); }
        },
        dispose() { disposed = true; ++generation; listeners.clear(); },
      };
    }

    /** Adapt the shared picker directory, never the host catalog or selected model.
     * Both the composer and /model call this resolver in the pinned upstream API.
     * Its original stores remain intact for routing, settings and session lifetime.
     */
    function installProjection(resolver, preferences) {
      const original = resolver.directoryFor, cache = new WeakMap();
      function directoryFor(id) {
        const source = original.call(this, id);
        if (cache.has(source)) return cache.get(source);
        let lastSource, lastPreferences, lastSnapshot;
        const store = {
          getSnapshot() {
            const raw = source.store.getSnapshot(), prefs = preferences.getSnapshot().selections;
            if (raw !== lastSource || prefs !== lastPreferences) {
              lastSource = raw; lastPreferences = prefs; lastSnapshot = project(raw, prefs);
            }
            return lastSnapshot;
          },
          subscribe(fn) { const a = source.store.subscribe(fn), b = preferences.subscribe(fn); return () => { a(); b(); }; },
        };
        const face = { store, load: async () => project(await source.load(), preferences.getSnapshot().selections),
          select: selection => source.select(selection) };
        cache.set(source, face);
        return face;
      }
      resolver.directoryFor = directoryFor;
      return () => { if (resolver.directoryFor === directoryFor) resolver.directoryFor = original; };
    }

    const CSS = `.dsh-model-visibility{max-width:760px;color:var(--dsw-alias-label-primary);display:grid;gap:16px}.dsh-model-visibility h2,.dsh-model-visibility h3,.dsh-model-visibility p{margin:0}.dsh-model-visibility p,.dsh-model-visibility small{color:var(--dsw-alias-label-tertiary);line-height:1.5}.dsh-model-visibility input[type=search]{width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit}.dsh-model-visibility section{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;display:grid;gap:12px}.dsh-model-visibility header,.dsh-model-visibility .actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-model-visibility header small{margin-left:auto}.dsh-model-visibility button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;cursor:pointer}.dsh-model-visibility button:disabled{opacity:.45;cursor:default}.dsh-model-visibility .models{max-height:320px;overflow:auto;display:grid;gap:2px}.dsh-model-visibility label{display:flex;align-items:center;gap:10px;padding:8px;border-radius:6px;cursor:pointer}.dsh-model-visibility label:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-model-visibility label span{display:grid;min-width:0;overflow-wrap:anywhere}.dsh-model-visibility input[type=checkbox]{width:16px;height:16px;flex:none;accent-color:var(--dsw-alias-brand-primary)}.dsh-model-visibility [role=alert]{color:var(--dsw-alias-state-error-primary)}`;
    const SWITCH_CSS = `.dsh-model-visibility input[role=switch]{appearance:none;width:36px;height:22px;border-radius:11px;background:#666;border:1px solid #888;position:relative;cursor:pointer;margin-left:auto;order:2}.dsh-model-visibility input[role=switch]:before{content:'';position:absolute;width:16px;height:16px;border-radius:50%;background:white;left:2px;top:2px;transition:transform .15s}.dsh-model-visibility input[role=switch]:checked{background:#3478f6;border-color:#3478f6}.dsh-model-visibility input[role=switch]:checked:before{transform:translateX(14px)}.dsh-model-visibility input[role=switch]:focus-visible{outline:2px solid #8cb8ff;outline-offset:3px}.dsh-model-visibility input[role=switch]:disabled{opacity:.45;cursor:default}`;
    function Settings({ preferences }) {
      const state = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
      const [groups, setGroups] = useState([]), [query, setQuery] = useState('');
      const [error, setError] = useState(''), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
      useEffect(() => {
        let live = true; setLoading(true); setError('');
        request('/catalog').then(data => { if (live) setGroups(data.groups); }, err => { if (live) setError(err.message); })
          .finally(() => { if (live) setLoading(false); });
        void preferences.refresh();
        return () => { live = false; };
      }, [attempt, preferences]);
      const disabled = !state.ready || state.busy;
      const search = query.trim().toLowerCase();
      return h('div', { className: 'dsh-model-visibility' },
        h('h2', null, 'Models'),
        h('p', null, 'Turn models on or off in the chat selector. Turning a model off never deletes it or its connection. A model already selected in a chat remains available there until you switch.'),
        h('p', null, 'All models are shown by default. Once you choose a subset, newly discovered models stay hidden until you select them. “Show all” restores automatic inclusion.'),
        h('input', { type: 'search', 'aria-label': 'Search chat models', placeholder: 'Search models or connections…', value: query, onChange: event => setQuery(event.target.value) }),
        h('div', { className: 'actions' }, h('button', { disabled: loading || state.busy, onClick: () => setAttempt(x => x + 1) }, 'Refresh'),
          h('small', { role: 'status' }, state.busy ? 'Saving…' : state.error ? 'Preferences need attention' : state.ready ? 'Preferences saved on this device' : 'Loading preferences…')),
        error || state.error ? h('p', { role: 'alert' }, error || state.error) : null,
        loading ? h('p', null, 'Loading model catalog…') : null,
        !loading && !error && !groups.length ? h('p', null, 'No models are connected yet. Add a connection in Accounts or Model connections (advanced), then refresh.') : null,
        !loading && groups.length > 0 && !groups.some(group => [group.name, group.id, ...group.models.flatMap(model => [model.name, model.id])].join(' ').toLowerCase().includes(search)) ? h('p', null, 'No matching models.') : null,
        groups.map(group => {
          const providerMatch = `${group.name} ${group.id}`.toLowerCase().includes(search);
          const rows = group.models.filter(model => providerMatch || `${model.name} ${model.id}`.toLowerCase().includes(search));
          if (!rows.length && !providerMatch) return null;
          const selected = Object.hasOwn(state.selections, group.id) ? state.selections[group.id] : group.models.map(model => model.id);
          const change = (ids, checked) => preferences.save(group.id, checked ? [...new Set([...selected, ...ids])] : selected.filter(id => !ids.includes(id)));
          return h('section', { key: group.id, 'aria-label': group.name || group.id },
            h('header', null, h('h3', null, group.name || group.id), h('small', null, `${group.models.filter(model => visible(state.selections, group.id, model.id)).length} of ${group.models.length} shown`)),
            group.error ? h('p', { role: 'alert' }, group.error) : null,
            h('div', { className: 'actions' },
              h('button', { disabled, onClick: () => preferences.save(group.id, null) }, 'Show all'),
              h('button', { disabled, onClick: () => preferences.save(group.id, []) }, 'Hide all'),
              search && rows.length ? h('button', { disabled, onClick: () => change(rows.map(model => model.id), true) }, 'Show matching') : null,
              search && rows.length ? h('button', { disabled, onClick: () => change(rows.map(model => model.id), false) }, 'Hide matching') : null),
            h('div', { className: 'models' }, rows.map(model => h('label', { key: model.id },
              h('input', { type: 'checkbox', role: 'switch', disabled, checked: visible(state.selections, group.id, model.id),
                onChange: event => change([model.id], event.target.checked) }),
              h('span', null, model.name || model.id, h('small', null, model.id))))));
        }));
    }
    function apply(ctx) {
      const preferences = createPreferences();
      ctx.effect(() => {
        const tag = document.createElement('style'); tag.textContent = CSS + SWITCH_CSS; document.head.appendChild(tag);
        const restore = installProjection(ctx.modelDirectories, preferences);
        void preferences.refresh();
        return () => { restore(); preferences.dispose(); tag.remove(); };
      });
      ctx.remote.$on('settings/document-updated', () => { void preferences.refresh(); });
      ctx.on('connection/reset', () => { void preferences.refresh(); });
      ctx.slots.inject('settings.section', () => {
        // The provider editor must retain its original registration: that entry
        // owns its child slots and the renderer's renderSlot capability.
        const catalog = ctx.slots.entries('settings.section').find(entry => entry.options.id === 'models');
        if (!catalog) throw new Error('Models settings section is unavailable');
        const models = ctx.slots.register({ name: 'settings.section', id: 'model-visibility', order: 10,
          label: () => 'Models', inject: () => ({ preferences }) }, Settings);
        // rc.2 navigation reads this public ledger; the outlet uses the core's
        // original registration. Change only its menu label/order, never its ID
        // or component, so all native form and credential operations stay wired.
        const originalEntries = ctx.slots.entries;
        const advanced = { ...catalog, options: { ...catalog.options, order: 11, label: () => 'Model connections (advanced)' } };
        function entries(key) {
          const rows = originalEntries.call(this, key);
          return key === 'settings.section' ? rows.map(entry => entry === catalog ? advanced : entry) : rows;
        }
        ctx.slots.entries = entries;
        return () => { if (ctx.slots.entries === entries) ctx.slots.entries = originalEntries; models(); };
      });
    }
    return { apply, inject: ['slots', 'modelDirectories', 'remote'], project, visible, createPreferences, installProjection, Settings };
  },
});
