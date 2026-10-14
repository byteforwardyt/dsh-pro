/**
 * OS notifications and the dock badge - the two moments worth interrupting for.
 *
 * The premise of this app is work that runs for minutes in a window you have
 * already alt-tabbed away from, and until now nothing told you when that work
 * stopped. The only way to find out was to keep watching the window, which is
 * the thing handing work to an agent was supposed to save you from.
 *
 * Upstream computes both signals and surfaces neither outside the page: every
 * session row carries pendingInteraction ("approval" | "plan-review" |
 * "question") and running. There is no client event for a finished turn - the
 * whole bundle publishes four events and none of them is about turns - so this
 * watches the session-list store and diffs consecutive snapshots. That store is
 * also what paints the sidebar amber dot, so the banner and the sidebar cannot
 * disagree about which session is waiting.
 *
 * This half only DETECTS. It sends a kind, a reason and the session title over
 * the desktop bridge; the wording of the banner is fixed in the main process
 * (shell/src/notify.cjs). A session title is model-written text and a banner is
 * a trusted macOS surface floating over every other app, so the page does not
 * get to choose what it says.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /**
     * The preference lives in localStorage because that is what every other
     * plugin here uses for a renderer-owned choice (ctx.settingsScope would
     * need a host plugin to own the namespace, which buys nothing for one
     * boolean). Absence means ON: a notification you have to go and find first
     * is worth nothing on the run it was meant to catch.
     */
    const PREF_KEY = "dshd.notify.enabled";

    function readPref() {
      try { return window.localStorage.getItem(PREF_KEY) !== "0"; } catch { return true; }
    }

    /** Shared by the Settings row and the watcher, so one toggle moves both. */
    const pref = {
      value: readPref(),
      listeners: new Set(),
      subscribe(fn) { pref.listeners.add(fn); return () => { pref.listeners.delete(fn); }; },
      set(next) {
        const value = next === true;
        if (value === pref.value) return;
        pref.value = value;
        // Private mode throws on write. The choice still holds for this
        // renderer; it simply will not survive a reload, which is better than
        // the toggle appearing not to work at all.
        try { window.localStorage.setItem(PREF_KEY, value ? "1" : "0"); } catch { /* in-memory only */ }
        for (const fn of [...pref.listeners]) fn();
      },
    };

    /**
     * Diff consecutive session-list snapshots into events.
     *
     * Deliberately free of every browser API - no window, no bridge, no React -
     * so the edge rules can be exercised directly by a test. The caller decides
     * what a post means.
     *
     * Rules, and why:
     *
     *   - The FIRST accepted snapshot only seeds. Sessions are restored from
     *     durable logs at boot, so posting on what is already there would greet
     *     every launch with a banner for a turn that finished yesterday. This
     *     mirrors upstream's own first-snapshot guard in the session list.
     *   - phase must be "ready". Measured: listPhase is set to "pending" only in
     *     the field initializer and to "ready" once, after the first successful
     *     pull (dsh-client-runtime/lib/client.js:7820 and :8093). It never goes
     *     back, so this guard covers the pre-first-pull window and NOTHING
     *     about reconnects. Reconnects are handled by the rule below.
     *   - A pending interaction is announced once per session until the session
     *     does something. On reconnect, handleDisconnected clears every pending
     *     interaction (dsh-client-runtime/lib/client.js:8434-8438) and mux-open
     *     replay re-adds the same requests, so a session waiting on an approval
     *     publishes it, loses it, and publishes it again - three snapshots, one
     *     event. What separates that from a genuinely new request is updatedAt:
     *     it advances only on logged activity (:8615 takes the mutation only
     *     when it is strictly greater, and the replayed frame carries its
     *     original event time at :8300), and a session blocked on a person logs
     *     nothing. So the same reason at the same updatedAt is the one we
     *     already announced.
     *   - A session that stops running WHILE it waits on a person did not
     *     finish - it is the needs-input case, and posting both would put two
     *     banners on screen for one event.
     *   - Subagents are skipped for turn completion only. Their parent posts
     *     when the work actually ends; a subagent finishing is an implementation
     *     detail of a turn still in flight. A subagent BLOCKED on a person is
     *     not - nothing else will ask on its behalf - so needs-input still
     *     covers it.
     *
     * @param post - called with a ready-to-send payload per event.
     * @returns update(state) -> the waiting count, or null when the snapshot
     *          was not usable and the caller should leave the badge alone.
     */
    function createWatcher(post) {
      const wasRunning = new Map();
      // sessionId -> { reason, at }: what we last announced, and the row's
      // updatedAt when we announced it.
      const announced = new Map();
      let seeded = false;
      return function update(state) {
        if (!state || state.phase !== "ready") return null;
        const ids = Array.isArray(state.ids) ? state.ids : [];
        const byId = state.byId || {};
        const seen = new Set();
        let waiting = 0;
        for (const id of ids) {
          const row = byId[id];
          if (!row) continue;
          seen.add(id);
          const pending = typeof row.pendingInteraction === "string" ? row.pendingInteraction : "";
          const running = row.running === true;
          const at = typeof row.updatedAt === "number" ? row.updatedAt : 0;
          const hadRunning = wasRunning.get(id) === true;
          const prior = announced.get(id);
          wasRunning.set(id, running);
          if (pending !== "") waiting += 1;
          // Seeding still records what is already on screen, so the first real
          // change is measured against it rather than against nothing.
          const fresh = pending !== "" && (prior === undefined || prior.reason !== pending || prior.at !== at);
          if (fresh) announced.set(id, { reason: pending, at: at });
          if (!seeded) continue;
          if (fresh) {
            post({ kind: "needs-input", reason: pending, sessionId: id, sessionTitle: row.displayTitle });
          } else if (hadRunning && !running && pending === "" && row.origin !== "subagent") {
            post({ kind: "turn-complete", reason: "done", sessionId: id, sessionTitle: row.displayTitle });
          }
        }
        // A deleted session must not leave its last running state behind: the
        // id can come back (reconnect re-pull) and would then read as a turn
        // that ended while the app was not even watching.
        for (const id of [...wasRunning.keys()]) {
          if (!seen.has(id)) { wasRunning.delete(id); announced.delete(id); }
        }
        seeded = true;
        return waiting;
      };
    }


    /**
     * How many live rows the tray is allowed to hear about.
     *
     * tray.cjs draws eight (MAX_ROWS in shell/src/tray.cjs) and turns the rest
     * into "N more not shown". Sending more than eight is what makes that
     * overflow line true; sending unbounded is how a session-creating agent
     * becomes a native-menu bomb. Thirty-two is four screens of overflow and
     * a hard stop. The same number is FEED_CAP in shell/src/tray-host.cjs -
     * a test pins the two together, because they cannot import each other
     * (renderer vs main).
     */
    const FEED_CAP = 32;

    /**
     * The session list, reduced to what the tray will draw.
     *
     * Separate from createWatcher because the two surfaces answer different
     * questions. A notification is a moment and is gated by a preference; the
     * tray is standing state and is not. Turning notifications off must not
     * empty the menu bar.
     *
     * startedAt is recorded only on a false->true running edge AFTER the seed.
     * A session already running when we first see the list has no known start,
     * and inventing Date.now() would count from "when the app opened" rather
     * than from when the work began. Omitting the field is what tray.cjs
     * treats as "no clock" (toStart yields NaN, the row says "running").
     *
     * Deliberately free of every browser API, so the edge rules can be
     * exercised directly by a test.
     *
     * @param now - () => number, injected so a test can pin the clock.
     */
    function createSessionFeed(now) {
      const clock = typeof now === "function" ? now : Date.now;
      const started = new Map();
      const wasRunning = new Map();
      let seeded = false;
      return function snapshot(state) {
        if (!state || state.phase !== "ready") return null;
        const ids = Array.isArray(state.ids) ? state.ids : [];
        const byId = state.byId || {};
        const seen = new Set();
        const live = [];
        let waiting = 0;
        for (const id of ids) {
          if (typeof id !== "string" || id === "" || id.length > 200) continue;
          if (/[\u0000-\u001f]/.test(id)) continue;
          const row = byId[id];
          if (!row) continue;
          seen.add(id);
          const running = row.running === true;
          const pending = typeof row.pendingInteraction === "string" && row.pendingInteraction !== "";
          if (pending) waiting += 1;
          const previously = wasRunning.get(id) === true;
          if (running && seeded && !previously) started.set(id, clock());
          if (!running) started.delete(id);
          wasRunning.set(id, running);
          if (!running && !pending) continue;
          const entry = {
            id: id,
            title: typeof row.displayTitle === "string" ? row.displayTitle : "",
            running: running,
            waiting: pending,
          };
          if (started.has(id)) entry.startedAt = started.get(id);
          live.push(entry);
        }
        for (const id of [...wasRunning.keys()]) {
          if (!seen.has(id)) { wasRunning.delete(id); started.delete(id); }
        }
        seeded = true;
        const ordered = live.filter((row) => row.waiting).concat(live.filter((row) => !row.waiting));
        return { sessions: ordered.slice(0, FEED_CAP), waiting: waiting };
      };
    }

    const CSS = [
      ".dshd-notify-row{display:flex;align-items:center;gap:16px;justify-content:space-between}",
      ".dshd-notify-row h4{margin:0;font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-notify-row p{margin:2px 0 0;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8);max-width:52ch}",
      // A switch rather than a button: this is a persistent state, and the only
      // other General row that reads as state (Phone) is a whole section with
      // room to spell it out. 40x24 with a 16px knob matches the app's control
      // scale; the knob travels exactly the track width minus its own inset.
      ".dshd-notify-switch{flex:0 0 auto;position:relative;width:40px;height:24px;padding:0;",
      "border-radius:999px;cursor:pointer;box-sizing:border-box;",
      "border:1px solid var(--dsw-alias-border-l2,#3a3f45);",
      "background:var(--dsw-alias-bg-layer-3,#26292e);",
      "transition:background-color var(--ds-transition-duration-fast,.14s) var(--ds-ease-in-out,ease),",
      "border-color var(--ds-transition-duration-fast,.14s) var(--ds-ease-in-out,ease)}",
      '.dshd-notify-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;',
      "border-radius:50%;background:var(--dsw-alias-label-tertiary,#adb2b8);",
      "transition:transform var(--ds-transition-duration-fast,.14s) var(--ds-ease-in-out,ease),",
      "background-color var(--ds-transition-duration-fast,.14s) var(--ds-ease-in-out,ease)}",
      '.dshd-notify-switch[aria-checked="true"]{background:var(--dsw-alias-button-primary-fill,#4d6bfe);',
      "border-color:transparent}",
      '.dshd-notify-switch[aria-checked="true"]::after{transform:translateX(16px);',
      "background:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".dshd-notify-switch:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);",
      "outline-offset:2px}",
      // The knob is the only moving part, and its travel is the whole state
      // change - hold it still rather than dropping it, or the switch reads as
      // broken for anyone who asked the OS to stop animation.
      "@media(prefers-reduced-motion:reduce){.dshd-notify-switch,.dshd-notify-switch::after{transition:none}}",
    ].join("");
    const STYLE_ID = "dshd-notify-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /**
     * The Settings > General row.
     *
     * Renders nothing without the desktop bridge - in a phone browser there is
     * no OS surface to post to, and a switch that silently does nothing is
     * worse than no switch.
     */
    function NotifyRow() {
      ensureStyle();
      const enabled = React.useSyncExternalStore(pref.subscribe, () => pref.value);
      const bridge = typeof window !== "undefined" ? window.__DSH_DESKTOP__ : null;
      if (!bridge || typeof bridge.notify !== "function") return null;
      return h("div", { className: "dshd-notify-row" },
        h("div", null,
          h("h4", { id: "dshd-notify-label" }, "Notifications"),
          h("p", null, "Get a notification when a session needs your approval or an answer, "
            + "and when a turn finishes while DSH PRO is in the background. The Dock icon "
            + "counts the sessions waiting on you.")),
        h("button", {
          type: "button",
          role: "switch",
          "aria-checked": enabled ? "true" : "false",
          "aria-labelledby": "dshd-notify-label",
          className: "dshd-notify-switch",
          onClick: () => pref.set(!enabled),
        }));
    }

    /**
     * Wire the store to the bridge.
     *
     * @returns a disposer, so ctx.effect can unwind the subscription.
     */
    function startWatching(ctx, bridge) {
      const canNotify = typeof bridge.notify === "function";
      const canFeed = typeof bridge.publishSessions === "function";
      if (!canNotify && !canFeed) return;

      let badge = -1;
      const watch = canNotify ? createWatcher((payload) => {
        if (!pref.value) return;
        // The main process decides whether this actually posts - it is the only
        // side that can see whether the window is focused. Failures here are
        // never worth surfacing: a missed banner must not break the page.
        try { void Promise.resolve(bridge.notify(payload)).catch(() => {}); } catch { /* bridge gone */ }
      }) : null;
      const feed = canFeed ? createSessionFeed() : null;

      function push(count) {
        if (!canNotify) return;
        const next = pref.value && typeof count === "number" ? count : 0;
        if (next === badge) return;
        badge = next;
        try { void Promise.resolve(bridge.setNotifyBadge(next)).catch(() => {}); } catch { /* bridge gone */ }
      }

      function sync() {
        const list = ctx.sessions.list.getSnapshot();
        const statuses = ctx.uiSession.sessionStatus.getSnapshot();
        const snap = list && { ...list, byId: Object.fromEntries(Object.entries(list.byId || {}).map(([id, row]) => {
          const status = statuses.get(id);
          const kind = status?.pendingInteraction?.kind;
          return [id, { ...row, running: status?.running ?? row.running,
            pendingInteraction: ['approval', 'plan-review', 'question'].includes(kind) ? kind : undefined }];
        })) };
        if (watch) {
          const count = watch(snap);
          if (count !== null) push(count);
        }
        if (feed) {
          const next = feed(snap);
          if (next !== null) {
            try { bridge.publishSessions(next); } catch { /* bridge gone */ }
          }
        }
      }

      // The preference is mirrored into the main process so it can refuse
      // without a round trip, and so the Dock badge is cleared by the side that
      // owns it. Not a boundary - this toggle is in the same renderer.
      function pushEnabled() {
        if (!canNotify || typeof bridge.setNotifyEnabled !== "function") return;
        try { void Promise.resolve(bridge.setNotifyEnabled(pref.value)).catch(() => {}); } catch { /* bridge gone */ }
      }

      pushEnabled();
      // Seed before subscribing: the store fires only on change, so waiting for
      // the first callback would treat some later change as the baseline and
      // swallow the event that came with it.
      sync();
      const stopPref = pref.subscribe(() => {
        pushEnabled();
        // Force the next push through in either direction: turning the feature
        // off has to clear a badge that is already the right number, and
        // turning it back on has to restore one we just sent as 0.
        badge = -1;
        if (pref.value) sync(); else push(0);
      });
      const stopList = ctx.sessions.list.subscribe(sync);
      const stopStatus = ctx.uiSession.sessionStatus.subscribe(sync);

      let stopOpen = () => {};
      if (typeof bridge.onOpenSession === "function") {
        stopOpen = bridge.onOpenSession((id) => {
          // Clicks arrive late - the session may have been deleted in between -
          // and open() throws on an id it does not know.
          // ids, not byId: byId also carries the currently addressed subagent
          // route, which open() does not accept (sessions/service.d.ts:68-71).
          const state = ctx.sessions.list.getSnapshot();
          if (!state || !Array.isArray(state.ids) || !state.ids.includes(id)) return;
          try { ctx.uiWorkspace.openSession(id); } catch { /* raced a deletion */ }
        }) || (() => {});
      }

      return () => { stopOpen(); stopStatus(); stopList(); stopPref(); };
    }

    function apply(ctx) {
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          { name: "settings.general.item", id: "dshd-notify", order: 850 },
          NotifyRow,
        ),
      );
      const bridge = typeof window !== "undefined" ? window.__DSH_DESKTOP__ : null;
      if (!bridge) return;
      if (typeof bridge.notify !== "function" && typeof bridge.publishSessions !== "function") return;
      ctx.effect(() => startWatching(ctx, bridge), "desktop notifications");
    }

    const inject = ["slots", "sessions", "uiSession", "uiWorkspace"];

    exports.apply = apply;
    exports.inject = inject;
    exports.createWatcher = createWatcher;
    exports.createSessionFeed = createSessionFeed;
    exports.FEED_CAP = FEED_CAP;
    return module.exports;
  },
});
