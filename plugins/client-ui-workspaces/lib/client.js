/**
 * Workspaces settings section — browser half.
 *
 * Pinning a workspace means "keep it at the top of the list", and the harness
 * already owns list order: `workspace.insertBefore(workspaceId, beforeId)`
 * reorders the registry, and the sidebar renders that order. So pinning is
 * implemented as a reorder through the real API rather than as a parallel
 * ordering of our own — nothing to keep in sync, and the sidebar updates itself.
 *
 * Which workspaces are "pinned" is our own presentation state (localStorage);
 * the ORDER it produces is the harness's durable state.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-workspaces",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;

    const PIN_KEY = "dshd.workspaces.pinned";
    const SKELETON_ROWS = 3;

    const CSS = [
      ".dshd-ws{display:flex;flex-direction:column;gap:10px;max-width:720px}",
      ".dshd-ws h2{font:var(--dsw-font-base-strong-16,500 16px/24px sans-serif);margin:0;",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-ws-intro{font:var(--dsw-font-s-14,14px/22px sans-serif);margin:0;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      // Group headings (PINNED / ALL) — same small-caps label voice as the
      // account cards' title row, just quieter (tertiary, not secondary),
      // since these are dividers rather than content.
      ".dshd-ws-group{margin:4px 0 -2px;font:var(--dsw-font-xxs-strong-12,500 12px/18px sans-serif);",
      "text-transform:uppercase;letter-spacing:.05em;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-ws-group:first-child{margin-top:0}",
      ".dshd-ws-list{display:flex;flex-direction:column;gap:8px}",
      ".dshd-ws-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "background:var(--dsw-alias-bg-layer-3,#353638);",
      "transition:border-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease),",
      "background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      // Highlight only — the row itself isn't a control (the Pin button is),
      // so no cursor change, just enough contrast to scan the list by eye.
      ".dshd-ws-row:hover{border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.16));",
      "background:linear-gradient(var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08)),",
      "var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))),",
      "var(--dsw-alias-bg-layer-3,#353638)}",
      // Folder mark — same glyph client-ui-brand draws for the Workspaces nav
      // icon, just inline and currentColor instead of a masked background.
      ".dshd-ws-mark{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-ws-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
      ".dshd-ws-name{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);",
      "color:var(--dsw-alias-label-primary,#f9fafb);white-space:nowrap;overflow:hidden;",
      "text-overflow:ellipsis}",
      // The meta line is a flex row of two runs, not one string.
      //
      // It used to be one span with direction:rtl, to head-truncate long paths
      // so the meaningful tail stays visible. That reorders the whole line, not
      // just the truncation: "5 sessions - /Users/..." rendered as
      // "sessions - /Users/... 5", with the count thrown to the far end. Only
      // the PATH may live in an rtl box, and its contents are fenced with LRM
      // marks so the path's own characters keep their order while the ellipsis
      // still lands at the start.
      ".dshd-ws-meta{display:flex;align-items:baseline;gap:5px;min-width:0;",
      "font:var(--dsw-font-xxs-12,12px/18px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-ws-count{flex:0 0 auto;white-space:nowrap}",
      ".dshd-ws-sep{flex:0 0 auto;opacity:.55}",
      ".dshd-ws-path{min-width:0;white-space:nowrap;overflow:hidden;",
      "text-overflow:ellipsis;direction:rtl;text-align:left}",
      ".dshd-ws-pin{display:inline-flex;align-items:center;justify-content:center;gap:6px;",
      "height:32px;padding:0 12px;border-radius:16px;border:none;cursor:pointer;flex:0 0 auto;",
      "font:var(--dsw-font-xs-13,13px/20px sans-serif);background:transparent;",
      "color:var(--dsw-alias-label-secondary,#cfd3d6);",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-ws-pin:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-ws-pin:disabled{opacity:.4;cursor:not-allowed}",
      ".dshd-ws-pin:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);",
      "outline-offset:2px}",
      ".dshd-ws-pin[aria-pressed=\"true\"]{color:var(--dsw-alias-state-business-primary,#679efe)}",
      ".dshd-ws-empty{border:1px dashed var(--dsw-alias-border-l3,rgba(255,255,255,.16));",
      "border-radius:8px;padding:12px;text-align:center;font-size:12px;line-height:18px;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      // Distinct from the empty state on purpose: an empty state says "there is
      // nothing here", an error state says "we don't actually know" — telling
      // the user they have no workspaces when the request just failed is a lie.
      ".dshd-ws-error{display:flex;flex-direction:column;align-items:center;gap:10px;",
      "border:1px dashed var(--dsw-alias-border-l3,rgba(255,255,255,.16));",
      "border-radius:8px;padding:16px 12px;text-align:center}",
      ".dshd-ws-error p{margin:0;font-size:12px;line-height:18px;",
      "color:var(--dsw-alias-state-error-primary,#f25a5a)}",
      ".dshd-ws-retry{height:28px;padding:0 14px;border-radius:14px;cursor:pointer;",
      "border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:transparent;",
      "font:var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-secondary,#cfd3d6);",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-ws-retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-ws-retry:disabled{opacity:.4;cursor:not-allowed}",
      ".dshd-ws-retry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);",
      "outline-offset:2px}",
      // Skeleton rows share the real row's box (same padding/border/radius) so
      // height matches exactly and the panel doesn't jump once data lands.
      ".dshd-ws-skel-bar{height:10px;border-radius:4px;",
      "background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.06))}",
      ".dshd-ws-skel-name{width:38%}",
      ".dshd-ws-skel-meta{width:64%;height:8px}",
      ".dshd-ws-skel-pin{width:64px;height:32px;border-radius:16px;flex:0 0 auto;",
      "background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.06))}",
      "@media (prefers-reduced-motion:reduce){",
      ".dshd-ws-row,.dshd-ws-pin,.dshd-ws-retry{transition:none}}",
    ].join("");
    const STYLE_ID = "dshd-workspaces-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    function readPins() {
      try { return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || "[]")); }
      catch { return new Set(); }
    }
    function writePins(set) {
      try { localStorage.setItem(PIN_KEY, JSON.stringify([...set])); } catch {}
    }

    /**
     * One unary call against the harness's own RPC surface.
     *
     * Resolves `{ ok, value }` rather than collapsing every failure (a 4xx/5xx
     * response, a malformed body, a network error) down to the same `null` a
     * genuinely empty result would produce. Callers that only care about the
     * value can still destructure `{ value }`, but state that depends on
     * *whether the call actually worked* — the initial load, the optimistic
     * pin revert — needs `ok` to tell those cases apart.
     */
    async function rpc(method, payload) {
      try {
        const res = await fetch(`/api/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "client-request", rpcId: `ws-${Date.now()}`, method, payload }),
        });
        const body = await res.json().catch(() => ({}));
        return body?.result?.ok ? { ok: true, value: body.result.value } : { ok: false, value: null };
      } catch {
        return { ok: false, value: null };
      }
    }

    function PinIcon({ filled }) {
      return h("svg", { viewBox: "0 0 24 24", width: 15, height: 15,
        fill: filled ? "currentColor" : "none", stroke: "currentColor",
        "stroke-width": 1.8, "stroke-linejoin": "round", "aria-hidden": "true" },
        h("path", { d: "M15 3l6 6-3 1-4 4-1 5-2-2-4 4 4-4-2-2 5-1 4-4 1-3z" }));
    }

    /** Same glyph client-ui-brand masks in for the Workspaces nav icon. */
    function FolderIcon() {
      return h("svg", { viewBox: "0 0 24 24", width: 15, height: 15,
        fill: "none", stroke: "currentColor", "stroke-width": 1.7,
        "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
        h("path", { d: "M3 7.5a2 2 0 0 1 2-2h3.9l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" }));
    }

    function WorkspaceRow({ w, pinned, busy, onToggle }) {
      return h(
        "div",
        { className: "dshd-ws-row" },
        h("span", { key: "m", className: "dshd-ws-mark" }, h(FolderIcon, null)),
        h("div", { key: "b", className: "dshd-ws-body" },
          h("span", { className: "dshd-ws-name" }, w.title || w.path),
          h("span", { className: "dshd-ws-meta" },
            h("span", { key: "c", className: "dshd-ws-count" },
              `${(w.sessionIds || []).length} session${(w.sessionIds || []).length === 1 ? "" : "s"}`),
            h("span", { key: "s", className: "dshd-ws-sep" }, "·"),
            // \u200e fences the path so the rtl box truncates from the
            // head without reordering the path's own characters.
            h("span", { key: "p", className: "dshd-ws-path", title: w.path },
              `\u200e${w.path}\u200e`))),
        h("button", {
          key: "p", type: "button", className: "dshd-ws-pin",
          "aria-pressed": String(pinned), disabled: busy,
          title: pinned ? "Unpin from top" : "Pin to top",
          onClick: () => void onToggle(w.workspaceId),
        }, h(PinIcon, { filled: pinned }), h("span", null, pinned ? "Pinned" : "Pin")),
      );
    }

    function SkeletonRow() {
      return h(
        "div",
        { className: "dshd-ws-row", "aria-hidden": "true" },
        h("span", { key: "m", className: "dshd-ws-mark" }, h(FolderIcon, null)),
        h("div", { key: "b", className: "dshd-ws-body" },
          h("span", { className: "dshd-ws-skel-bar dshd-ws-skel-name" }),
          h("span", { className: "dshd-ws-skel-bar dshd-ws-skel-meta" })),
        h("span", { key: "p", className: "dshd-ws-skel-pin" }),
      );
    }

    function WorkspacesSection() {
      ensureStyle();
      const [items, setItems] = useState(null);
      const [loadFailed, setLoadFailed] = useState(false);
      const [pins, setPins] = useState(readPins);
      const [busy, setBusy] = useState(false);

      // `loadFailed` only drives the UI while `items` is still null (see
      // render below) — a failed *refresh* after we already have a good list
      // (e.g. the one `toggle` triggers) just leaves the stale list showing
      // rather than replacing it with a scary full-panel error.
      const load = useCallback(async () => {
        const { ok, value } = await rpc("workspace.list", {});
        if (ok) setItems(value?.items ?? []);
        setLoadFailed(!ok);
      }, []);

      useEffect(() => { void load(); }, [load]);

      const retry = useCallback(async () => {
        if (busy) return;
        setBusy(true);
        try { await load(); } finally { setBusy(false); }
      }, [busy, load]);

      /**
       * Apply the pinned-first order to the harness registry.
       *
       * Every insert targets the SAME fixed anchor — the first unpinned
       * workspace — so the pinned block lands in the order the inserts run.
       * Iterating in reverse (which would be right if the anchor moved with
       * each insert) laid the block down backwards, and flipped it again on
       * every subsequent pin.
       *
       * When nothing is unpinned there is no anchor: insertBefore with an
       * undefined `beforeWorkspaceId` falls through to the host's APPEND
       * branch, so "pin to top" silently moved workspaces to the end and
       * reversed the whole sidebar on each toggle. With everything pinned the
       * pinned-first order is already satisfied, so the right move is to do
       * nothing at all.
       *
       * Resolves `{ ok }` so `toggle` can tell a real reorder failure apart
       * from the legitimate no-op above, and revert the optimistic pin state
       * only in the failure case.
       */
      const applyOrder = useCallback(async (nextPins, list) => {
        const pinned = list.filter((w) => nextPins.has(w.workspaceId));
        const firstUnpinned = list.find((w) => !nextPins.has(w.workspaceId));
        if (pinned.length === 0 || !firstUnpinned) return { ok: true };
        for (const w of pinned) {
          const { ok } = await rpc("workspace.insertBefore", {
            workspaceId: w.workspaceId,
            beforeWorkspaceId: firstUnpinned.workspaceId,
          });
          if (!ok) return { ok: false };
        }
        return { ok: true };
      }, []);

      const toggle = useCallback(async (workspaceId) => {
        if (busy || !items) return;
        setBusy(true);
        const prevPins = pins;
        const next = new Set(pins);
        if (next.has(workspaceId)) next.delete(workspaceId);
        else next.add(workspaceId);
        setPins(next);
        writePins(next);
        try {
          const { ok } = await applyOrder(next, items);
          if (!ok) {
            // The registry never moved — put the pin state back so the UI
            // doesn't keep claiming an order change that didn't happen.
            setPins(prevPins);
            writePins(prevPins);
            return;
          }
          await load();
        } finally { setBusy(false); }
      }, [busy, items, pins, applyOrder, load]);

      // Plain alphabetical. The pinned-first sort this replaced was a leftover
      // from the ungrouped layout — with groups doing the ordering, sorting the
      // source list as well only made the duplication below harder to see.
      const rows = items === null
        ? null
        : [...items].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
      const pinnedRows = rows === null ? [] : rows.filter((w) => pins.has(w.workspaceId));
      const otherRows = rows === null ? [] : rows.filter((w) => !pins.has(w.workspaceId));

      return h(
        "div",
        { className: "dshd-ws" },
        h("h2", { key: "h" }, "Workspaces"),
        h("p", { key: "i", className: "dshd-ws-intro" },
          "Pin the projects you use most — pinned workspaces move to the top of the sidebar."),
        rows === null
          ? (loadFailed
              ? h("div", { key: "err", className: "dshd-ws-error" },
                  h("p", { role: "alert" }, "Couldn't load workspaces."),
                  h("button", {
                    type: "button", className: "dshd-ws-retry", disabled: busy,
                    onClick: () => void retry(),
                  }, busy ? "Retrying…" : "Retry"))
              : h("div", { key: "l", className: "dshd-ws-list", role: "status",
                  "aria-live": "polite", "aria-label": "Loading workspaces" },
                  Array.from({ length: SKELETON_ROWS }, (_, i) => h(SkeletonRow, { key: i }))))
          : rows.length === 0
            ? h("p", { key: "e", className: "dshd-ws-empty" },
                "No workspaces yet. Choose a project folder to create one.")
            : h(
                React.Fragment,
                { key: "g" },
                // Each workspace appears in exactly ONE group. The second list
                // used to map the whole set, so every pinned workspace rendered
                // twice — back to back, each copy carrying its own Pin toggle
                // for the same workspace. With everything pinned the two lists
                // were byte-identical.
                //
                // With nothing pinned there is only one group, so the headings
                // are dropped entirely rather than leaving a lone divider over
                // the only list.
                pinnedRows.length === 0
                  ? h("div", { key: "only", className: "dshd-ws-list" },
                      rows.map((w) => h(WorkspaceRow, {
                        key: w.workspaceId, w, pinned: false, busy, onToggle: toggle,
                      })))
                  : h(
                      React.Fragment,
                      { key: "grouped" },
                      h("h3", { key: "ph", className: "dshd-ws-group" }, "Pinned"),
                      h("div", { key: "pl", className: "dshd-ws-list" },
                        pinnedRows.map((w) => h(WorkspaceRow, {
                          key: w.workspaceId, w, pinned: true, busy, onToggle: toggle,
                        }))),
                      otherRows.length === 0 ? null : h(
                        React.Fragment,
                        { key: "others" },
                        h("h3", { key: "oh", className: "dshd-ws-group" }, "Others"),
                        h("div", { key: "ol", className: "dshd-ws-list" },
                          otherRows.map((w) => h(WorkspaceRow, {
                            key: w.workspaceId, w, pinned: false, busy, onToggle: toggle,
                          }))),
                      ),
                    ),
              ),
      );
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "workspaces", order: 1, label: () => "Workspaces" },
          WorkspacesSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
