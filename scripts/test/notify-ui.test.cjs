const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {loadClient} = require('./helpers/client-harness.cjs');

// The renderer half of the notifications feature.
//
// It makes exactly one decision - whether a change in the session list is worth
// interrupting someone for - and every rule asserted below exists because the
// obvious diff gets that wrong in a way nothing else would catch: a banner on
// launch for a turn that finished yesterday, two banners for one event, or a
// reconnect read as every running session finishing at once. None of those
// throw. The page keeps rendering and the user just loses trust in the banners.
//
// The main process owns the wording (shell/src/notify.cjs); this file only
// asserts what the page decides to send, and the guards around sending it.

const REPO = path.join(__dirname, '..', '..');

/**
 * The shipped client-runtime type declarations.
 *
 * Measured: staging/ is gitignored (.gitignore:6), so the staged copy only
 * exists after scripts/stage-harness.cjs has run. The pnpm store holds the same
 * published package, so this falls back to it the way
 * helpers/theme-css.cjs locates the conversation bundle - otherwise these pins
 * would pass or fail depending on whether someone had built recently.
 */
function runtimeTypes (rel, pkg = 'dsh-api-session-controller', base = 'client') {
  const suffix = path.join('node_modules/@deepseek-ai', pkg, 'lib/types', base, rel);
  const staged = path.join(REPO, 'staging/darwin-arm64', suffix);
  if (fs.existsSync(staged)) return fs.readFileSync(staged, 'utf8');
  const store = path.join(REPO, 'node_modules', '.pnpm');
  for (const dir of fs.readdirSync(store)) {
    if (!dir.startsWith('@deepseek-ai+' + pkg + '@')) continue;
    const file = path.join(store, dir, suffix);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw new Error('dsh-client-runtime types are not installed - run an install or a stage first');
}

/**
 * A double for ctx.sessions.
 *
 * Measured against the shipped contract (contract/sessions.d.ts:22): list is an
 * ObservableSnapshot, whose subscribe listener takes no arguments
 * (contract/store.d.ts: "subscribe(fn: () => void)"). So push() notifies with
 * nothing and the subscriber has to re-read getSnapshot, exactly as upstream
 * behaves - handing the snapshot to the callback here would let a broken
 * implementation pass.
 */
function store (initial) {
  let snapshot = initial === undefined ? null : initial;
  const listeners = new Set();
  const statusListeners = new Set();
  let statusOverride;
  const opened = [];
  return {
    opened,
    subscribers: () => listeners.size,
    push (next) { snapshot = next; for (const fn of [...listeners]) fn(); },
    pushStatus(next) { statusOverride = next; for (const fn of [...statusListeners]) fn(); },
    uiSession: { sessionStatus: {
      getSnapshot: () => statusOverride || new Map(Object.entries(snapshot?.byId || {}).map(([id, row]) => [id, {
        running: row.running, pendingInteraction: row.pendingInteraction ? {kind: row.pendingInteraction} : undefined,
      }])),
      subscribe: fn => {statusListeners.add(fn);return () => statusListeners.delete(fn);},
    } },
    uiWorkspace: { openSession(id) { opened.push(id); } },
    api: {
      list: {
        getSnapshot: () => snapshot,
        subscribe (fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
      },
      open (id) { opened.push(id); },
    },
  };
}

/** A double for window.__DSH_DESKTOP__, recording every call in order. */
function bridge () {
  const state = {posts: [], badges: [], enabled: [], click: null, openDisposed: false, feeds: []};
  state.api = {
    notify (payload) { state.posts.push(payload); },
    setNotifyBadge (count) { state.badges.push(count); },
    setNotifyEnabled (value) { state.enabled.push(value); },
    onOpenSession (cb) { state.click = cb; return () => { state.openDisposed = true; }; },
    publishSessions (payload) { state.feeds.push(payload); },
  };
  return state;
}

/** A session row. Only the four fields the watcher reads are ever set. */
const row = (over) => ({displayTitle: 'A session', running: false, ...over});
/** A usable list snapshot. ids carries the order; byId carries the rows. */
const ready = (byId) => ({phase: 'ready', ids: Object.keys(byId), byId});

/**
 * The recorded payloads as plain host objects.
 *
 * Measured: helpers/client-harness.cjs evaluates the plugin with
 * vm.runInNewContext, so every object it builds carries that context's
 * Object.prototype, and node:assert/strict compares prototypes - a
 * field-for-field match still fails. Re-spreading keeps the assertions whole
 * objects rather than weakening them to a field at a time.
 */
const sent = (desk) => desk.posts.map((payload) => ({...payload}));

/**
 * Load the plugin with a live store already in place.
 *
 * The watcher starts during apply(), synchronously, so whatever the store holds
 * at this moment IS the seed - which is the point of every seeding assertion.
 */
function start (options = {}) {
  const desk = bridge();
  const sessions = store(options.initial);
  const client = loadClient('client-ui-notify', () => {}, {
    context: {sessions: sessions.api, uiSession: sessions.uiSession, uiWorkspace: sessions.uiWorkspace},
    desktopBridge: desk.api,
    storage: options.storage,
  });
  return {desk, sessions, client};
}

test('pending interactions update from the independent UI status store without a list mutation', () => {
  const {desk,sessions}=start({initial:ready({s1:row()})});
  sessions.pushStatus(new Map([['s1',{running:false,pendingInteraction:{kind:'approval'}}]]));
  assert.equal(desk.posts.length,1);
  assert.equal(desk.posts[0].reason,'approval');
  sessions.pushStatus(new Map([['s1',{running:false,pendingInteraction:{kind:'unknown-domain'}}]]));
  assert.equal(desk.posts.length,1);
  assert.equal(desk.badges.at(-1),0);
});

test('the first snapshot seeds silently, including work already running and already waiting', () => {
  const {desk, sessions} = start({initial: ready({
    building: row({running: true}),
    asking: row({pendingInteraction: 'approval'}),
  })});
  // Sessions are restored from durable logs at launch. Posting on the seed
  // would greet every start with banners for work that ended yesterday.
  assert.deepEqual(desk.posts, []);
  // The badge is state rather than an interruption, so it does reflect the seed.
  assert.deepEqual(desk.badges, [1]);
  assert.deepEqual(desk.enabled, [true]);
  // And the seed is a real baseline, not a dead first pass: the next change posts.
  sessions.push(ready({building: row({running: false}), asking: row({pendingInteraction: 'approval'})}));
  assert.deepEqual(desk.posts.map((p) => p.kind), ['turn-complete']);
});

test('a new pending interaction posts once, verbatim, and reposts only when the value changes', () => {
  const {desk, sessions} = start({initial: ready({s1: row({displayTitle: 'Ship the release'})})});
  const push = (pendingInteraction) =>
    sessions.push(ready({s1: row({displayTitle: 'Ship the release', pendingInteraction})}));

  push('question');
  // reason is passed through untouched: the main process keys its banner title
  // off these exact strings, so a normalisation here would silently mistitle it.
  assert.deepEqual(sent(desk), [
    {kind: 'needs-input', reason: 'question', sessionId: 's1', sessionTitle: 'Ship the release'},
  ]);

  // The store fires on every list mutation, most of which change nothing this
  // cares about. A repeat of the same wait is not a new wait.
  push('question');
  assert.equal(desk.posts.length, 1, 'an unchanged pending value posted a second banner');

  // A session can move from one wait to another without ever clearing, and the
  // second wait is a genuinely different ask.
  push('approval');
  assert.equal(desk.posts.length, 2);
  assert.equal(desk.posts[1].reason, 'approval');
  push('plan-review');
  assert.equal(desk.posts[2].reason, 'plan-review');

  // Answered, then blocked again on the same thing: that is two interruptions -
  // but only because the session did something in between, and updatedAt is
  // what says so. The reconnect test below is this exact shape without it.
  push(undefined);
  assert.equal(desk.posts.length, 3, 'clearing a wait posted something');
  sessions.push(ready({s1: row({displayTitle: 'Ship the release', pendingInteraction: 'plan-review', updatedAt: 2})}));
  assert.equal(desk.posts.length, 4);
});

test('a reconnect does not re-announce a wait the user has already seen', () => {
  // Measured, dsh-client-runtime/lib/client.js:8434-8438: losing the connection
  // clears every pending interaction, and mux-open replay re-adds the same
  // requests once it is back. So one unanswered approval publishes three
  // snapshots - present, absent, present - and the obvious diff reads the third
  // as a new ask. updatedAt is the separator: it advances only on logged
  // activity (:8615 takes a mutation only when strictly greater, and a replayed
  // frame carries its original event time at :8300), and a session blocked on a
  // person logs nothing, so the row comes back byte-identical.
  const idle = () => ready({s1: row({displayTitle: 'Ship the release', updatedAt: 7})});
  const waiting = () => ready({s1: row({displayTitle: 'Ship the release', pendingInteraction: 'approval', updatedAt: 7})});
  const {desk, sessions} = start({initial: idle()});
  sessions.push(waiting());
  assert.equal(desk.posts.length, 1);
  sessions.push(idle());
  sessions.push(waiting());
  assert.equal(desk.posts.length, 1, 'a reconnect re-announced a wait the user already knows about');
  // The badge still follows the truth through the gap rather than sticking.
  assert.deepEqual(desk.badges, [0, 1, 0, 1]);
});

test('a finished turn posts once', () => {
  const {desk, sessions} = start({initial: ready({s1: row({running: true, displayTitle: 'Long build'})})});
  sessions.push(ready({s1: row({running: false, displayTitle: 'Long build'})}));
  assert.deepEqual(sent(desk), [
    {kind: 'turn-complete', reason: 'done', sessionId: 's1', sessionTitle: 'Long build'},
  ]);
  // Every later mutation of an idle session is still an idle session.
  sessions.push(ready({s1: row({running: false, displayTitle: 'Renamed'})}));
  assert.equal(desk.posts.length, 1, 'an idle session posted a second completion');
});

test('a turn that stops to ask reports the question rather than a completion', () => {
  const {desk, sessions} = start({initial: ready({s1: row({running: true})})});
  // Both facts change in one snapshot, which is the normal shape of an
  // approval: the run stops because it is waiting. Two banners for one event.
  sessions.push(ready({s1: row({running: false, pendingInteraction: 'approval'})}));
  assert.equal(desk.posts.length, 1);
  assert.equal(desk.posts[0].kind, 'needs-input');

  // Same shape one step apart - the wait was already announced, so the stop
  // that follows it is not a second event either.
  const later = start({initial: ready({s2: row({running: true, pendingInteraction: 'question'})})});
  later.sessions.push(ready({s2: row({running: false, pendingInteraction: 'question'})}));
  assert.deepEqual(later.desk.posts, []);
});

test('a subagent finishing is not an event, but a subagent blocked on a person is', () => {
  const sub = (over) => ready({helper: row({origin: 'subagent', displayTitle: 'Reviewer', ...over})});
  const {desk, sessions} = start({initial: sub({running: true})});
  // The parent turn is still in flight; it will post when the work ends.
  sessions.push(sub({running: false}));
  assert.deepEqual(desk.posts, []);
  // Nothing else asks on a subagent's behalf, so a blocked one still counts.
  sessions.push(sub({running: false, pendingInteraction: 'question'}));
  assert.deepEqual(sent(desk), [
    {kind: 'needs-input', reason: 'question', sessionId: 'helper', sessionTitle: 'Reviewer'},
  ]);
});

test('a session that leaves the list and comes back is a new baseline, not a finished turn', () => {
  const {desk, sessions} = start({initial: ready({gone: row({running: true}), keep: row()})});
  // Removed while it was running. Its disappearance is not news.
  sessions.push(ready({keep: row()}));
  assert.deepEqual(desk.posts, []);
  // The same id can come back - a reconnect re-pull restores the row - and if
  // its last running state were still on file, that return would read as a
  // turn that ended while nothing was watching, and post for it.
  sessions.push(ready({gone: row({running: false}), keep: row()}));
  assert.deepEqual(desk.posts, [], 'a returning session posted a completion for a turn nobody saw');
});

test('a pending-phase snapshot is ignored entirely and does not become the baseline', () => {
  const {desk, sessions} = start({initial: ready({s1: row({running: true})})});
  assert.deepEqual(desk.badges, [0]);

  // Measured, sessions/manager.d.ts:14 and service.d.ts:73: phase is the
  // arrival lifecycle, and rows are absent before the first successful pull
  // rather than finished. Diffing a reconnect would read as every running
  // session completing at once.
  sessions.push({phase: 'pending', ids: [], byId: {}});
  assert.deepEqual(desk.posts, []);
  assert.deepEqual(desk.badges, [0], 'a reconnect moved the badge');

  // The seeded row survived it: this snapshot only posts if running:true is
  // still remembered from before the ignored one.
  sessions.push(ready({s1: row({running: false})}));
  assert.deepEqual(desk.posts.map((p) => p.kind), ['turn-complete']);
});

test('the badge counts sessions waiting on a person and moves only when that count changes', () => {
  const {desk, sessions} = start({initial: ready({a: row(), b: row()})});
  assert.deepEqual(desk.badges, [0]);
  sessions.push(ready({a: row({pendingInteraction: 'approval'}), b: row()}));
  sessions.push(ready({a: row({pendingInteraction: 'approval'}), b: row({pendingInteraction: 'question'})}));
  assert.deepEqual(desk.badges, [0, 1, 2]);

  // Running is not waiting. The badge is a count of things that need a person,
  // which is the only number worth putting on the Dock icon.
  sessions.push(ready({a: row({pendingInteraction: 'approval'}), b: row({running: true})}));
  assert.deepEqual(desk.badges, [0, 1, 2, 1]);

  // A rename re-fires the store. The Dock icon must not repaint for it.
  sessions.push(ready({a: row({pendingInteraction: 'approval', displayTitle: 'Renamed'}), b: row({running: true})}));
  assert.deepEqual(desk.badges, [0, 1, 2, 1], 'an unrelated mutation pushed the badge again');

  // A deleted session cannot leave its wait behind on the icon.
  sessions.push(ready({b: row({running: true})}));
  assert.deepEqual(desk.badges, [0, 1, 2, 1, 0]);
});

test('notifications default on, and only a stored "0" turns them off', () => {
  const empty = start({initial: ready({})});
  assert.deepEqual(empty.desk.enabled, [true], 'a first run with no stored preference started silent');
  const off = start({initial: ready({}), storage: new Map([['dshd.notify.enabled', '0']])});
  assert.deepEqual(off.desk.enabled, [false]);
  const on = start({initial: ready({}), storage: new Map([['dshd.notify.enabled', '1']])});
  assert.deepEqual(on.desk.enabled, [true]);
});

test('the Settings switch stops posts, clears the badge, tells the main process, and is durable', async (t) => {
  const storage = new Map();
  const {desk, sessions, client} = start({
    initial: ready({s1: row({running: true, pendingInteraction: 'approval', displayTitle: 'Long build'})}),
    storage,
  });
  assert.deepEqual(client.registrations.map((r) => [r.meta.name, r.meta.id]),
    [['settings.general.item', 'dshd-notify']]);
  assert.deepEqual(desk.badges, [1]);

  const view = await client.mount().flush();
  t.after(() => view.unmount());
  const toggle = () => view.find((n) => n.props.role === 'switch');
  assert.equal(toggle().props['aria-checked'], 'true');

  toggle().props.onClick();
  await view.flush();
  assert.equal(toggle().props['aria-checked'], 'false');
  // Enforced on both sides: the renderer stops sending and the main process
  // stops posting, so a confused page cannot put a banner on a screen where
  // the user said no.
  assert.deepEqual(desk.enabled, [true, false]);
  assert.deepEqual(desk.badges, [1, 0], 'the Dock kept its count after notifications were turned off');
  assert.equal(storage.get('dshd.notify.enabled'), '0', 'the choice will not survive a reload');

  // A real event while off: a new wait, which would otherwise post.
  sessions.push(ready({s1: row({running: false, pendingInteraction: 'question', displayTitle: 'Long build'})}));
  assert.deepEqual(desk.posts, []);
  assert.deepEqual(desk.badges, [1, 0]);

  toggle().props.onClick();
  await view.flush();
  assert.equal(toggle().props['aria-checked'], 'true');
  assert.deepEqual(desk.enabled, [true, false, true]);
  // Turning it back on re-reads the list rather than waiting for the next
  // change, so the Dock is right immediately.
  assert.deepEqual(desk.badges, [1, 0, 1]);
  assert.equal(storage.get('dshd.notify.enabled'), '1');
  sessions.push(ready({s1: row({running: false, pendingInteraction: 'approval', displayTitle: 'Long build'})}));
  assert.deepEqual(desk.posts.map((p) => p.reason), ['approval']);
});

test('the Settings row renders nothing where there is no OS surface to post to', async () => {
  const sessions = store(ready({s1: row({running: true})}));
  const client = loadClient('client-ui-notify', () => {}, {context: {sessions: sessions.api}});
  // It still registers: the slot order is shared with the rest of General, and
  // a conditional registration would move every row below it in the browser.
  assert.deepEqual(client.registrations.map((r) => r.meta.id), ['dshd-notify']);
  const view = await client.mount().flush();
  assert.equal(view.tree, null, 'a switch that cannot do anything is worse than no switch');
  assert.equal(sessions.subscribers(), 0, 'the watcher ran without a bridge to report to');
  view.unmount();
});

test('a notification click opens the session, and is dropped when that session is gone', () => {
  const {desk, sessions} = start({initial: ready({live: row(), other: row()})});
  assert.equal(typeof desk.click, 'function', 'nothing is listening for a click on the banner');
  desk.click('live');
  assert.deepEqual(sessions.opened, ['live']);
  // Measured, contract/sessions.d.ts on open(): "must exist in the list;
  // unknown ids fail loud". A banner outlives the session it names - it sits on
  // screen until it is clicked or times out - so this guard is the whole point.
  desk.click('deleted');
  assert.deepEqual(sessions.opened, ['live'], 'a click for a deleted session reached open()');
});

test('upstream still models a pending interaction the way this maps it', () => {
  const pending = runtimeTypes('index.d.ts', 'dsh-client-ui-session');
  // These three strings are the whole vocabulary of the needs-input banner: the
  // main process picks its title from them, so a fourth value would post a
  // banner with no title and a removed one would post nothing at all.
  assert.ok(pending.includes('readonly kind: string;'));
  assert.ok(pending.includes('readonly pendingInteraction: SessionPendingInteraction | undefined;'));
  assert.ok(pending.includes('readonly sessionStatus: HostObservable<SessionStatusSnapshot>;'));

  const lineage = runtimeTypes('sessions/lineage.d.ts');
  // The turn-complete skip compares against this exact literal. If origin grows
  // another value, subagent rows are still handled; if the literal is renamed,
  // every subagent starts posting completions for work still in flight.
  assert.ok(lineage.includes("origin?: 'subagent';"),
    'the subagent origin marker moved: the turn-complete skip is now matching nothing');
  assert.ok(!lineage.includes('pendingInteraction'), 'pending status must come from uiSession, not the list');
  assert.ok(lineage.includes('running: boolean;'),
    'a session row no longer carries running, so a finished turn cannot be detected');
});

test('upstream still exposes the list feed and the selection call this is built on', () => {
  const manager = runtimeTypes('sessions/manager.d.ts');
  // 'pending' is the pre-first-pull and reconnect state. The watcher accepts
  // only 'ready', so a renamed or removed phase would make it accept nothing
  // and go permanently silent - the failure mode with no symptom.
  assert.ok(manager.includes("export type SessionListPhase = 'pending' | 'ready';"),
    'SessionListPhase changed: the watcher filters on phase === "ready" and will now ignore every snapshot');

  const service = runtimeTypes('sessions/service.d.ts');
  assert.ok(service.includes('ids: SessionId[];'), 'the list snapshot no longer carries ids');
  assert.ok(service.includes('byId: Record<SessionId, SessionSummary>;'), 'the list snapshot no longer carries byId');
  assert.ok(service.includes('phase: SessionListPhase;'), 'the list snapshot no longer carries phase');

  const contract = runtimeTypes('contract/sessions.d.ts');
  // ctx.sessions.list is an ObservableSnapshot - getSnapshot plus a
  // no-argument subscribe. The watcher polls the former from the latter.
  assert.ok(contract.includes('readonly list: ObservableSnapshot<SessionListState>;'),
    'ctx.sessions.list is no longer an ObservableSnapshot: the subscribe/getSnapshot pair this watcher uses is gone');
  const navigation = runtimeTypes('navigation.d.ts', 'dsh-client-ui-workspace');
  assert.ok(navigation.includes('openSession(target: SessionTarget): void;'),
    'notification navigation no longer matches uiWorkspace');
  const store = runtimeTypes('contract.d.ts', 'dsh-client-store', '');
  assert.ok(store.includes('subscribe(fn: () => void): () => void;'),
    'subscribe changed shape: the test double hands the callback nothing, and the watcher re-reads the snapshot');
});


test('the tray feed publishes on seed, without clocks for work already running', () => {
  const {desk} = start({initial: ready({
    building: row({running: true, displayTitle: 'Build'}),
    asking: row({pendingInteraction: 'approval', displayTitle: 'Review'}),
    idle: row({displayTitle: 'Done'}),
  })});
  assert.equal(desk.feeds.length, 1);
  // Idle rows are omitted; waiting rows lead running ones so the tray can
  // put the thing that needs a person at the top.
  // Re-spread: the plugin runs in a vm, so node:assert/strict would reject a
  // field-for-field match on prototype (see sent() above).
  const feed = JSON.parse(JSON.stringify(desk.feeds[0]));
  assert.deepEqual(feed, {
    waiting: 1,
    sessions: [
      {id: 'asking', title: 'Review', running: false, waiting: true},
      {id: 'building', title: 'Build', running: true, waiting: false},
    ],
  });
  assert.equal('startedAt' in desk.feeds[0].sessions[1], false,
    'a session already running at seed was given a clock');
});

test('a false-to-true running edge after seed records startedAt, and a stop forgets it', () => {
  let now = 1000;
  let mod;
  const sessions = store(ready({s1: row({displayTitle: 'Build'})}));
  loadClient('client-ui-notify', () => {}, {
    context: {sessions: sessions.api, uiSession: sessions.uiSession, uiWorkspace: sessions.uiWorkspace},
    desktopBridge: bridge().api,
    onModule (m) { mod = m; },
  });
  const feed = mod.createSessionFeed(() => now);
  assert.equal(feed({phase: 'pending', ids: [], byId: {}}), null);
  // Seed: already running, no clock.
  let snap = feed(ready({s1: row({running: true, displayTitle: 'Build'})}));
  assert.equal(snap.sessions[0].startedAt, undefined);
  now = 5000;
  // Still running: still no clock. The second snapshot is not a start.
  snap = feed(ready({s1: row({running: true, displayTitle: 'Build'})}));
  assert.equal(snap.sessions[0].startedAt, undefined);
  snap = feed(ready({s1: row({running: false, displayTitle: 'Build'})}));
  assert.equal(snap.sessions.length, 0);
  now = 9000;
  snap = feed(ready({s1: row({running: true, displayTitle: 'Build'})}));
  assert.equal(snap.sessions[0].startedAt, 9000);
});

test('turning notifications off does not empty the tray', () => {
  const storage = new Map([['dshd.notify.enabled', '0']]);
  const {desk, sessions} = start({
    initial: ready({s1: row({running: true, displayTitle: 'Build'})}),
    storage,
  });
  assert.deepEqual(desk.enabled, [false]);
  assert.equal(desk.feeds.length, 1, 'the seed did not reach the tray with notifications off');
  assert.equal(desk.feeds[0].sessions[0].id, 's1');
  sessions.push(ready({s1: row({running: true, pendingInteraction: 'approval', displayTitle: 'Build'})}));
  assert.deepEqual(desk.posts, [], 'a wait posted a banner while notifications were off');
  assert.equal(desk.feeds.length, 2);
  assert.equal(desk.feeds[1].waiting, 1);
  assert.equal(desk.feeds[1].sessions[0].waiting, true);
});

test('the feed cap matches the host cap and waiting count is the real total', () => {
  let mod;
  loadClient('client-ui-notify', () => {}, {
    context: {sessions: store(null).api},
    onModule (m) { mod = m; },
  });
  const feed = mod.createSessionFeed();
  const byId = {};
  for (let i = 0; i < mod.FEED_CAP + 5; i++) {
    byId['s' + i] = row({pendingInteraction: 'approval', displayTitle: 'W' + i});
  }
  const snap = feed(ready(byId));
  assert.equal(snap.sessions.length, mod.FEED_CAP);
  assert.equal(snap.waiting, mod.FEED_CAP + 5, 'the header count was capped with the rows');
});
