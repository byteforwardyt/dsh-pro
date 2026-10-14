/**
 * "Reset DSH PRO" — a General-settings row, desktop only.
 *
 * The row is only an entry point: the CONFIRMATION is a native dialog owned by
 * the main process (preload's resetApp), so a page cannot fake or suppress it,
 * and the wipe itself runs outside this renderer entirely. If the desktop
 * bridge is absent (plain browser tab), the row does not render — there is
 * nothing it could honestly do there.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-reset",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const CSS = [
      ".dshd-reset-row{display:flex;align-items:center;gap:16px;justify-content:space-between;",
      "padding:14px 0}",
      ".dshd-reset-row h4{margin:0;font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-reset-row p{margin:2px 0 0;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8);max-width:52ch}",
      ".dshd-reset-btn{flex:0 0 auto;padding:6px 14px;border-radius:16px;cursor:pointer;",
      "font:var(--dsw-font-xs-13,500 13px/20px sans-serif);",
      "border:1px solid var(--dsw-alias-state-error-primary,#f25a5a);",
      "background:transparent;color:var(--dsw-alias-state-error-primary,#f25a5a);",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      // :not(:disabled) so the destructive fill never appears while the button
      // is disabled mid-reset. Token is -primary — the one the theme defines
      // (the app's other error styling uses it); the old name resolved to
      // nothing and always fell back to the literal red.
      ".dshd-reset-btn:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#f25a5a);color:#fff}",
      ".dshd-reset-btn:disabled{opacity:.5;cursor:default}",
    ].join("");
    const STYLE_ID = "dshd-reset-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    function ResetRow() {
      ensureStyle();
      const [busy, setBusy] = React.useState(false);
      const bridge = typeof window !== "undefined" ? window.__DSH_DESKTOP__ : null;
      if (!bridge || typeof bridge.resetApp !== "function") return null;
      return h("div", { className: "dshd-reset-row" },
        h("div", null,
          h("h4", null, "Reset DSH PRO"),
          h("p", null, "Erase everything the app stores on this Mac — sessions, workspaces, "
            + "settings and sign-ins — and relaunch fresh. Your project folders are not touched.")),
        h("button", { type: "button", className: "dshd-reset-btn", disabled: busy,
          onClick: () => {
            setBusy(true);
            // The native dialog does the real asking; a Cancel there resolves
            // false and the row simply re-arms.
            Promise.resolve(bridge.resetApp()).finally(() => setBusy(false));
          } },
          "Reset…"));
    }

    const inject = ["slots"];
    function apply(ctx) {
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          { name: "settings.general.item", id: "dshd-reset", order: 900 },
          ResetRow,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
