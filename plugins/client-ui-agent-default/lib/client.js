window.__ModuleLoader__.load({
  id: '@dsh-desktop/client-ui-agent-default',
  factory: require => {
    const React = require('react'), h = React.createElement;
    const Empty = () => null;
    function apply(ctx) {
      // Override presentation only: preset selection/persistence stay upstream.
      for (const [name, id] of [
        ['conversation.hero.agentPreset'],
        ['conversation.session.header.actions', 'agent-preset'],
        ['settings.general.item', 'agent-preset'],
      ]) ctx.slots.inject(name, () => ctx.slots.register({ name, ...(id ? { id } : {}), priority: -100 }, Empty));

      ctx.effect(() => {
        // Metadata-backed settings register asynchronously. Use the public
        // registry subscription and a real overriding entry; rewriting the
        // inspection-only entries() view changes labels but not rendering.
        let source, dispose;
        const wrappers = new WeakSet();
        const sync = () => {
          const entry = ctx.slots.entries('settings.section').find(row => row.options.id === 'agent-presets' && !wrappers.has(row.component));
          if (entry === source) return;
          dispose?.(); dispose = undefined; source = entry;
          if (!entry) return;
          function Advanced(props) {
            return h('section', { style: { maxWidth: 820, display: 'grid', gap: 16 } },
              h('h2', { style: { margin: 0 } }, 'Advanced'),
              h('p', null, 'DSH Agent includes the full coding toolset, verification guidance, and per-chat preview tools. Model, effort, and access are separate controls. Existing chats keep their original presets.'),
              h('details', null,
                h('summary', { style: { cursor: 'pointer', padding: '12px 0' } }, 'Manage agent presets'),
                h('p', null, 'For custom workflows only. Changing the default affects new chats. DSH Agent is managed by the app; duplicate it to customize. Connected MCP tools still require a configured connection.'),
                h(entry.component, props)));
          }
          wrappers.add(Advanced);
          dispose = ctx.slots.register({ ...entry.options, name: 'settings.section', id: 'agent-presets',
            priority: (entry.options.priority || 0) - 100, order: 90, label: () => 'Advanced',
            inject: entry.inject, locale: entry.locale }, Advanced);
        };
        const stop = ctx.slots.subscribe('settings.section', sync);
        sync();
        return () => { stop(); dispose?.(); };
      });
    }
    return { apply, inject: ['slots'] };
  },
});
