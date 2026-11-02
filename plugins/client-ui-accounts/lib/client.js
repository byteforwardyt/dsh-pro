/**
 * Accounts settings section — browser half.
 *
 * Renders the login flows the host exposes at /dsh-auth and drives them over its
 * SSE stream. Written directly in the client module-table format: no JSX, so a
 * bundler would add a build step without changing the output.
 *
 * Styling consumes the host's design tokens (declared on `body` by the theme
 * plugin, 355 custom properties) with the dark-theme values as fallbacks, and
 * structural chrome comes from the host's own exported primitives
 * (@deepseek-ai/dsh-client-ui-primitives: Modal, icons, writeClipboard) — both
 * of which are what makes this panel read as native rather than bolted on, and
 * both verified present in the shell's module table.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-accounts",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useRef } = React;
    const h = React.createElement;

    /** Host primitives; every use degrades gracefully if an export moves. */
    let P = {};
    try { P = require("@deepseek-ai/dsh-client-ui-primitives"); } catch {}

    /**
     * Token-first styling. Every colour is a host token with that token's dark
     * value as the fallback, so the panel follows the theme (light mode
     * included — hardcoded rgba() greys collapsed to near-invisible there) and
     * still renders correctly if the theme plugin loads after us.
     */
    const CSS = [
      // Same measure and rhythm as the sibling sections (Workspaces runs the same
      // 720px column), and the size container for the grid below: a container
      // query cannot style the element it queries, so the containment sits on the
      // section and .dshd-grid inside it is what responds.
      ".dshd-acc{display:flex;flex-direction:column;gap:12px;padding:0;max-width:960px}",
      // No media query and no container query. The old `@media (max-width:820px)`
      // measured the viewport, which never described this box — the grid lives
      // in a fixed-width dialog that stays put whatever the window does. A
      // container query replaced it and was worse: the content column measures
      // 556px, the breakpoint was written at 560px, and the 2x2 grid this
      // section is supposed to be silently collapsed to a single column.
      //
      // auto-fill already does the whole job. Two 268px tracks plus the 12px gap
      // need 548px, so the grid holds two columns at the shipped width and
      // folds to one by itself if the dialog is ever squeezed below that. One
      // rule, no magic number to keep in sync with a layout somebody else owns.
      ".dshd-grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));",
      // Deliberately NO grid-auto-rows:1fr. It looked like the thing that put the
      // action rails on one baseline, and it is not — within a row, the default
      // align-items:stretch plus the card's own flex:1 body already does that.
      // What it actually did was size EVERY implicit row to the tallest row: in
      // a container with indefinite free space, each 1fr track resolves to the
      // max base size across tracks. So starting a sign-in, which grows the
      // first row with a device code, a link and a prompt, inflated the second
      // row by the same ~170px and left two cards with a band of dead space
      // between body and foot. Verified in Chromium, not inferred.
      "}",
      ".dshd-acc-title{font:var(--dsw-font-base-strong-16,500 16px/24px sans-serif);",
      "margin:0;color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-acc-intro{font:var(--dsw-font-s-14,14px/22px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8);margin:0}",

      // Three rows, exactly like the host's own Agent-presets card: identity,
      // one elastic middle that absorbs every per-provider difference, and a
      // foot. The card carries no padding of its own so the foot's rule runs
      // edge to edge.
      ".dshd-card{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "border-radius:12px;padding:0;display:flex;flex-direction:column;",
      "min-height:150px;",
      "background:var(--dsw-alias-bg-layer-3,#353638);",
      "transition:border-color .16s var(--ds-ease-in-out,ease),background-color .16s var(--ds-ease-in-out,ease)}",
      ".dshd-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;",
      "padding:14px 16px 0}",
      // Everything that varies per provider — usage, live prompts, disclosures —
      // lives here, so no amount of it can move the foot.
      ".dshd-card-body{flex:1;display:flex;flex-direction:column;gap:10px;padding:12px 16px 14px}",
      ".dshd-card-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;",
      "flex-wrap:wrap;padding:8px 12px;",
      "border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      // Top-aligned: a provider name that wraps to two lines must not drag its
      // icon down the card with it.
      ".dshd-card-ident{display:flex;align-items:flex-start;gap:12px;min-width:0}",
      ".dshd-card-mark{display:inline-flex;align-items:center;justify-content:center;",
      "width:32px;height:32px;flex:0 0 auto;border-radius:8px;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f);color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-card-title{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dshd-card-name{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-card-sub{font:var(--dsw-font-xxs-12,12px/18px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",

      // Rides the name's first line, not the middle of a title block that may be
      // one line or two.
      ".dshd-badge{font:500 11px/17px sans-serif;padding:1px 8px;border-radius:999px;white-space:nowrap;",
      "align-self:flex-start;margin-top:2px;",
      "color:var(--dsw-alias-state-success-primary,#22c55e);",
      "background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 10%,transparent)}",

      // No `margin-top:auto` any more: pushing the row to the bottom only worked
      // on a card with nothing after it, which is exactly why the four baselines
      // disagreed. The card foot does that structurally now, and this class is
      // left to the onboarding step's centred button row.
      ".dshd-actions{display:flex;flex-wrap:wrap;gap:8px}",
      // Host button geometry: 36px pills, 14px/400, token fills. The primary is
      // the host's inverted near-white — the app has no saturated blue button.
      ".dshd-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;",
      "box-sizing:border-box;height:36px;padding:0 14px;border:none;border-radius:18px;",
      "font:var(--dsw-font-s-14,14px/22px sans-serif);cursor:pointer;",
      "color:var(--dsw-alias-label-primary,#f9fafb);background:transparent;",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.14))}",
      ".dshd-btn:disabled{opacity:.4;cursor:not-allowed}",
      ".dshd-btn-primary{background:var(--dsw-alias-button-primary-fill,#f9fafb);",
      "color:var(--dsw-alias-label-primary-foreground,#0f1115)}",
      ".dshd-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#ebeef2)}",
      ".dshd-btn-outline{border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-btn-quiet{background:transparent}",
      // Sign-out reads as an ordinary secondary control at rest — it was the
      // loudest thing on a connected card while being the one action nobody
      // opens this panel to take. Red is reserved for hover and for the armed
      // state, where it is a warning rather than decoration.
      ".dshd-signout-action{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0}",
      ".dshd-btn-signout{color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      ".dshd-btn-signout:hover:not(:disabled),.dshd-btn.dshd-btn-armed{",
      "color:var(--dsw-alias-state-error-primary,#f25a5a);",
      "background:var(--dsw-alias-interactive-bg-hover-danger,rgba(242,90,90,.15))}",
      ".dshd-btn:focus-visible,.dshd-link:focus-visible{",
      "outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}",

      ".dshd-live{display:flex;flex-direction:column;gap:10px;",
      "border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));padding-top:12px}",
      ".dshd-notice{font-size:13px;line-height:20px;display:flex;flex-direction:column;gap:6px;",
      "color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      ".dshd-code-row{display:flex;align-items:center;gap:8px}",
      ".dshd-code{font:var(--dsw-font-markdown-code-block,13px/22px monospace);font-weight:700;",
      "letter-spacing:.14em;padding:8px 12px;border-radius:8px;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f);user-select:all}",
      ".dshd-copy{height:28px;padding:0 10px;border-radius:14px;font-size:12px;line-height:18px}",
      ".dshd-prompt{display:flex;flex-direction:column;gap:8px}",
      ".dshd-prompt-msg{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      ".dshd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".dshd-input{flex:1 1 260px;min-width:0;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "padding:7px 10px;border-radius:8px;color:inherit;",
      "border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f)}",
      ".dshd-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#f9fafb)}",
      ".dshd-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#adb2b8)}",

      ".dshd-warn{font-size:12px;line-height:18px;padding:9px 11px;border-radius:8px;",
      "color:var(--dsw-alias-state-warn-label,#dd8629);",
      "background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 10%,transparent)}",
      ".dshd-err{font-size:12px;line-height:18px;padding:9px 11px;border-radius:8px;",
      "color:var(--dsw-alias-state-error-primary,#f25a5a);",
      "background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f25a5a) 10%,transparent)}",
      // A dead stream is only actionable if the retry sits in the message.
      ".dshd-err-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}",
      ".dshd-retry{color:inherit;flex:0 0 auto}",
      ".dshd-link{color:var(--dsw-alias-state-business-primary,#679efe);text-decoration:none;font-weight:400}",
      ".dshd-link:hover{text-decoration:underline}",

      // Usage bar: real data only (harvested from response headers host-side).
      ".dshd-usage{display:flex;flex-direction:column;gap:4px}",
      ".dshd-usage-row{display:flex;justify-content:space-between;align-items:baseline}",
      ".dshd-usage-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-usage-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      ".dshd-bar{height:4px;border-radius:2px;overflow:hidden;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f)}",
      ".dshd-bar>i{display:block;height:100%;border-radius:2px;",
      "background:var(--dsw-alias-state-business-primary,#679efe);",
      "transition:width .3s var(--ds-ease-in-out,ease)}",
      ".dshd-bar-hot>i{background:var(--dsw-alias-state-warn-primary,#f59e0b)}",
      ".dshd-bar-full>i{background:var(--dsw-alias-state-error-primary,#f25a5a)}",

      ".dshd-skel{height:150px;border-radius:12px;",
      "background:var(--dsw-alias-bg-skeleton,rgba(255,255,255,.06))}",
      ".dshd-empty{border:1px dashed var(--dsw-alias-border-l3,rgba(255,255,255,.16));",
      "border-radius:8px;padding:12px;text-align:center;font-size:12px;line-height:18px;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",

      ".dshd-onb{display:flex;flex-direction:column;padding:28px;width:100%;",
      "max-width:560px;box-sizing:border-box}",
      // The two featured sign-ins sit side by side as equal halves — never
      // wrapped into an ugly stack by a few pixels of font rounding.
      ".dshd-onb .dshd-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}",
      // Size to content and never break a label across lines: the two buttons
      // then share one row at equal height, and wrap as whole units if narrow.
      ".dshd-onb .dshd-actions .dshd-btn-primary{white-space:nowrap;flex:0 1 auto}",
      // Secondary row wraps normally and stays inside the dialog.
      ".dshd-onb-actions{flex-wrap:wrap}",
      ".dshd-onb{text-align:center;align-items:center}",
      ".dshd-onb h2{font-size:20px;font-weight:500;line-height:28px;margin:0;",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-onb-body{margin-top:20px;display:flex;flex-direction:column;gap:12px}",
      ".dshd-onb-actions{display:flex;justify-content:center;gap:8px;margin-top:20px;flex-wrap:wrap}",
      ".dshd-onb-actions .dshd-btn-primary{min-width:120px}",

      "@keyframes dshd-spin{to{transform:rotate(360deg)}}",
      ".dshd-spin{animation:dshd-spin .8s linear infinite}",
      "@media (prefers-reduced-motion:reduce){",
      ".dshd-card,.dshd-btn,.dshd-bar>i{transition:none}.dshd-spin{animation-duration:2.4s}}",
    ].join("");

    const STYLE_ID = "dshd-accounts-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    // BEGIN GENERATED provider-icons (scripts/sync-icons.cjs) — do not edit
    // @lobehub/icons-static-svg@1.94.0 (MIT). Regenerate: node scripts/sync-icons.cjs
    const PROVIDER_ICONS = {
      "openai-codex": "<path d=\"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z\"></path>",
      "xai": "<path d=\"M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815\"></path>",
      "openrouter": "<path d=\"M18.654 3.87a5.087 5.087 0 110 10.174L23.7 19.09c.64.641.187 1.737-.72 1.737H8.48a8.479 8.479 0 010-16.958h10.175zM8.479 7.26a5.087 5.087 0 100 10.176 5.087 5.087 0 000-10.175z\"></path>",
      "kimi-coding": "<path d=\"M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z\"></path><path d=\"M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z\"></path>",
      "deepseek": "<path d=\"M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z\"></path>",
    };
    // END GENERATED provider-icons

    const EXTRA_PROVIDER_ICONS = {
      opencode: "<path d=\"M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5zm2 0v14h12V5H6zm2.3 4.3a1 1 0 0 1 1.4 0l2.3 2.3a1 1 0 0 1 0 1.4l-2.3 2.3a1 1 0 1 1-1.4-1.4l1.6-1.6-1.6-1.6a1 1 0 0 1 0-1.4zM12 14h4a1 1 0 1 1 0 2h-4a1 1 0 1 1 0-2z\"></path>",
      anthropic: "<path d=\"M13.83 3.52h3.46L23.5 20.48h-3.46l-6.21-16.96zm-7.12 0h3.62l6.21 16.96h-3.54l-1.26-3.58H5.26L4 20.48H.5L6.71 3.52zm-.44 10.6h4.46L8.5 7.72l-2.23 6.4z\"></path>",
      google: "<path d=\"M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c4.84 0 8.87-3.44 9.8-8h-9.8v-3.6h13.4c.14.8.2 1.6.2 2.4 0 6.63-5.37 12-12 12S0 18.63 0 12 5.37 0 12 0c3.24 0 6.18 1.28 8.34 3.36l-2.54 2.54C16.32 4.52 14.27 3.6 12 3.6z\"></path>",
      openai: "<path d=\"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128z\"></path>",
      groq: "<path d=\"M13 2L4 14h7l-1 8 9-12h-7l1-8z\"></path>",
      cerebras: "<path d=\"M12 2l8.66 5v10L12 22l-8.66-5V7L12 2zm0 2.31L5.34 8.15v7.7L12 19.69l6.66-3.84v-7.7L12 4.31zm0 3.69a4 4 0 1 1 0 8 4 4 0 0 1 0-8z\"></path>",
      mistral: "<path d=\"M3 4h4v4H3V4zm14 0h4v4h-4V4zM3 8h8v4H3V8zm10 0h8v4h-8V8zM3 12h4v8H3v-8zm7 0h4v4h-4v-4zm7 0h4v8h-4v-8z\"></path>",
      together: "<path d=\"M7 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm10 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM7 13a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm10 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6z\"></path>",
      fireworks: "<path d=\"M12 2l2.4 6.2L21 9.5l-5 4.3 1.5 6.4L12 16.8 6.5 20.2 8 13.8 3 9.5l6.6-1.3L12 2z\"></path>",
      nvidia: "<path d=\"M3 6h9v3H6v6h6v3H3V6zm11 0h7v12h-7v-3h4V9h-4V6z\"></path>",
      huggingface: "<path d=\"M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-3.5 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM8 14.5h8a4 4 0 0 1-8 0z\"></path>",
      minimax: "<path d=\"M3 18V6l4.5 6L12 6l4.5 6L21 6v12h-3v-6l-3 4-3-4-3 4-3-4v6H3z\"></path>",
      zai: "<path d=\"M4 5h16v3L9.5 16H20v3H4v-3l10.5-8H4V5z\"></path>",
      "vercel-ai-gateway": "<path d=\"M12 3l10 17.5H2L12 3z\"></path>",
      "custom-gateway": "<path d=\"M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6zm2 1v1h2V7H6zm0 6a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H6zm0 2h2v1H6v-1z\"></path>",
    };

    /**
     * Official brand mark for a provider, drawn at the caller's size and in the
     * caller's colour (the upstream monochrome variants are `currentColor`).
     * `dangerouslySetInnerHTML` is safe here: the markup is build-time constant,
     * spliced from a pinned package, never user or network data.
     */
    function ProviderMark({ provider, size }) {
      const body = PROVIDER_ICONS[provider] || EXTRA_PROVIDER_ICONS[provider];
      if (!body) return null;
      return h("svg", {
        viewBox: "0 0 24 24",
        width: size || 20,
        height: size || 20,
        fill: "currentColor",
        "fill-rule": "evenodd",
        "aria-hidden": "true",
        focusable: "false",
        dangerouslySetInnerHTML: { __html: body },
      });
    }

    /**
     * Product copy per provider. The seam's own labels are accurate but written
     * for a catalog ("OpenAI Codex"); a person looking for ChatGPT needs to see
     * the word ChatGPT.
     */
    /**
     * Providers whose OAuth flow authenticates as the VENDOR'S OWN first-party
     * client, so the consent screen names that client rather than this app. The
     * user is told before they consent — see docs/BACKLOG.md for the release
     * gate that removes the need for this disclosure.
     */
    const BORROWED_CLIENT = {
      "openai-codex": "OpenAI's Codex CLI",
      xai: "xAI's CLI",
      "kimi-coding": "Moonshot's Kimi CLI",
    };

    const PRESENTATION = {
      "openai-codex": { rank: 0, name: "ChatGPT", sub: "ChatGPT Plus, Pro or Business", verb: "Sign in with ChatGPT" },
      xai: { rank: 1, name: "Grok", sub: "SuperGrok or X Premium", verb: "Sign in with Grok" },
      openrouter: { rank: 2, name: "OpenRouter", sub: "OpenRouter account", verb: "Sign in with OpenRouter" },
      "kimi-coding": { rank: 3, name: "Kimi", sub: "Kimi For Coding subscription", verb: "Sign in with Kimi" },
    };

    const present = (account) =>
      PRESENTATION[account.provider] || { rank: 99, name: account.label, sub: account.provider, verb: "Sign in" };

    /** Lead with the two providers this build exists to offer, not alphabetically. */
    const byProminence = (a, b) => {
      const delta = present(a).rank - present(b).rank;
      return delta !== 0 ? delta : present(a).name.localeCompare(present(b).name);
    };

    /** A timed-out mutation may have reached the host; never retry it automatically. */
    async function post(path, body, signal) {
      const controller = new AbortController();
      const withdraw = () => controller.abort();
      let timedOut = false;
      if (signal?.aborted) controller.abort();
      signal?.addEventListener("abort", withdraw, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
      try {
        const res = await fetch(`/dsh-auth/${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await res.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return { ok: false, status: res.status, error: "The host returned an unreadable response. Check account status before retrying." };
        }
        return { ...payload, ok: res.ok, status: res.status };
      } catch {
        return { ok: false, status: 0, error: timedOut
          ? "The host did not respond in time. It may have received the request; check account status before retrying."
          : "The app could not confirm the request with its host. Check account status before retrying." };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", withdraw);
      }
    }

    /** Own one mutation per mounted account/prompt, including before React renders. */
    function useAuthAction(identity) {
      const [pending, setPending] = useState(false);
      const [error, setError] = useState(null);
      const owner = useRef(null);
      useEffect(() => {
        const scope = { identity, request: null };
        owner.current = scope;
        setPending(false);
        setError(null);
        return () => { scope.request?.abort(); if (owner.current === scope) owner.current = null; };
      }, [identity]);
      const run = useCallback(async (path, body, validate) => {
        const scope = owner.current;
        if (!scope || scope.identity !== identity || scope.request) return null;
        const request = new AbortController();
        scope.request = request;
        setPending(true);
        setError(null);
        const result = await post(path, body, request.signal);
        if (owner.current !== scope) return null;
        scope.request = null;
        setPending(false);
        const failure = !result.ok ? (result.error === "stale-attempt"
          ? "This sign-in has already changed. Check the current account status."
          : result.error || `The request failed (HTTP ${result.status}).`) : validate?.(result);
        if (failure) { setError(failure); return null; }
        return result;
      }, [identity]);
      return { pending, error, run };
    }

    /** Give up reconnecting after this many consecutive failures (~7.5s total). */
    const STREAM_RETRY_LIMIT = 4;

    /**
     * Subscribe to host state; the stream pushes a full `state` on connect.
     *
     * The stream is the ONLY source of account state, so its death is not a
     * cosmetic problem: the panel used to sit on four skeletons forever, which
     * reads as "still loading" no matter how long ago the host went away.
     * EventSource does reconnect on its own, but only for transport-level
     * failures — a 403 from the cross-origin fence or a 404 from a host that
     * unregistered the route closes it permanently and silently. So retries are
     * driven here, bounded, and end in something the user can act on.
     */
    function useAuthState(enabled = true) {
      const [accounts, setAccounts] = useState([]);
      const [loaded, setLoaded] = useState(false);
      const [live, setLive] = useState({});
      const [outcomes, setOutcomes] = useState({});
      const [streamLost, setStreamLost] = useState(false);
      // Bumping this re-runs the effect, which is the reconnect.
      const [attempt, setAttempt] = useState(0);

      useEffect(() => {
        if (!enabled) return;
        let source = null;
        let timer = null;
        let disposed = false;
        let failures = 0;
        let newestRevision = -1;
        let currentAttempts = new Map();

        const onMessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        const snapshotLive = msg.live ?? [];
        if (msg.type === "state" && (!Array.isArray(msg.accounts) || !Array.isArray(snapshotLive)
          || !msg.accounts.every(account => account && typeof account.key === "string" && typeof account.provider === "string" && Array.isArray(account.methods))
          || !snapshotLive.every(entry => entry && typeof entry.key === "string"))) return;
        if (msg.revision !== undefined) {
          if (!Number.isSafeInteger(msg.revision) || msg.revision < 0 || msg.revision < newestRevision) return;
          newestRevision = msg.revision;
        } else if (newestRevision >= 0) return;
        if (msg.type === "state") {
          failures = 0;
          currentAttempts = new Map(snapshotLive.map(entry => [entry.key, entry.attemptId]));
          setAccounts(msg.accounts);
          setLoaded(true);
          // The connect-time state carries any attempt already running, which is
          // how a reopened settings panel (or a second window) picks up a login
          // in progress instead of showing an idle card over a live attempt.
          //
          // It is a FULL snapshot of what is live now, so REBUILD from it rather
          // than merging into the old map. Empty notices and a null prompt are
          // authoritative, including for attempts that persist. Merging
          // left an attempt that settled during a stream gap (its "settled"
          // event never delivered) stuck busy forever with a stale device code.
          setLive(() => {
            const next = {};
            for (const entry of snapshotLive) {
              next[entry.key] = {
                busy: true,
                attemptId: entry.attemptId,
                notices: Array.isArray(entry.notices) ? entry.notices : [],
                prompt: entry.prompt ?? null,
              };
            }
            return next;
          });
          return;
        }
        const key = msg.key;
        if (!key) return;
        // A delayed terminal event or callback must never affect a replacement
        // login. Legacy hosts omit ids and retain their existing behavior.
        if (msg.type === "attempt-started") currentAttempts.set(key, msg.attemptId);
        else if (msg.attemptId !== undefined && currentAttempts.get(key) !== msg.attemptId) return;
        if (msg.type === "settled") currentAttempts.delete(key);
        failures = 0;
        setLive((prev) => {
          const cur = prev[key] || { notices: [], prompt: null, busy: false };
          switch (msg.type) {
            case "attempt-started": return { ...prev, [key]: { notices: [], prompt: null, busy: true, attemptId: msg.attemptId } };
            case "notice": return { ...prev, [key]: { ...cur, busy: true, notices: [...cur.notices, msg.notice] } };
            case "prompt": return { ...prev, [key]: { ...cur, busy: true, prompt: msg.prompt } };
            // A withdrawn prompt means the flow's other racer won. That is
            // progress, not failure: clear the box and keep the attempt alive.
            case "prompt-withdrawn":
            case "prompt-answered": return { ...prev, [key]: { ...cur, prompt: null } };
            case "settled": { const next = { ...prev }; delete next[key]; return next; }
            default: return prev;
          }
        });
        if (msg.type === "outcome") {
          // Three ways an attempt can end, three answers. `cancelled` — the user
          // closing the consent screen, or declining it — used to render as
          // nothing at all, leaving a card that looked like the click had never
          // happened. It is not an error, so it is not styled as one.
          setOutcomes((prev) => ({
            ...prev,
            [key]: msg.status === "failed"
              ? { tone: "error", message: msg.message || "The sign-in failed." }
              : msg.status === "cancelled"
                ? { tone: "warn", message: "Sign-in was cancelled before it finished — nothing was saved." }
                : null,
          }));
        }
        if (msg.type === "attempt-started") setOutcomes((prev) => ({ ...prev, [key]: null }));
        };

        const connect = () => {
          // Held locally as well as in `source`, so a late error from a stream we
          // already replaced closes itself rather than the current one.
          const es = new EventSource("/dsh-auth/events");
          source = es;
          // A replacement connection may belong to a restarted host, whose
          // revision counter starts over. Late frames from its predecessor are
          // excluded by connection identity before they reach the reducer.
          newestRevision = -1;
          es.onmessage = (event) => {
            if (!disposed && source === es) onMessage(event);
          };
          es.onerror = () => {
            // Close first: EventSource schedules its own reconnect on transport
            // errors, and two reconnect schedules racing means two live streams.
            es.close();
            if (disposed || source !== es) return;
            source = null;
            if (failures >= STREAM_RETRY_LIMIT) { setStreamLost(true); return; }
            const wait = 500 * 2 ** failures;
            failures += 1;
            timer = setTimeout(connect, wait);
          };
        };

        setStreamLost(false);
        connect();
        return () => {
          disposed = true;
          clearTimeout(timer);
          source?.close();
        };
      }, [attempt, enabled]);

      const retry = useCallback(() => setAttempt((n) => n + 1), []);

      return { accounts, loaded, live, outcomes, streamLost, retry };
    }

    /** Copy affordance for device codes; flips to a check for a beat. */
    function CopyCode({ code }) {
      const [copied, setCopied] = useState(false);
      const timer = useRef(null);
      useEffect(() => () => clearTimeout(timer.current), []);
      const copy = useCallback(async () => {
        try {
          if (P.writeClipboard) await P.writeClipboard(code);
          else await navigator.clipboard.writeText(code);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 1200);
        } catch {}
      }, [code]);
      return h(
        "button",
        { type: "button", className: "dshd-btn dshd-btn-outline dshd-copy", onClick: copy,
          "aria-label": "Copy code" },
        copied ? "Copied" : "Copy",
      );
    }

    function Notice({ notice }) {
      return h(
        "div",
        { className: "dshd-notice" },
        h("span", { key: "m" }, notice.message),
        notice.code
          ? h("div", { key: "c", className: "dshd-code-row" },
              h("span", { className: "dshd-code" }, notice.code),
              h(CopyCode, { code: notice.code }))
          : null,
        notice.url
          ? h(
              "a",
              { key: "u", className: "dshd-link", href: notice.url, target: "_blank", rel: "noreferrer noopener" },
              "Open the sign-in page ↗",
            )
          : null,
      );
    }

    /**
     * A prompt is answered or left alone — never dismissed.
     *
     * `interaction.prompt` rejecting is how the seam learns a human said no, and
     * for openai-codex the paste box is RACING the loopback callback: rejecting it
     * kills a sign-in the user is completing in their browser at that moment. So
     * there is no dismiss control here. The only exit is "Cancel sign-in", which
     * withdraws the whole attempt through the request signal instead.
     */
    function Prompt({ account, prompt }) {
      const [value, setValue] = useState("");
      const [accepted, setAccepted] = useState(false);
      const action = useAuthAction(`${account.provider}:${prompt.id}`);
      const sending = action.pending || accepted;
      const inputRef = useRef(null);

      useEffect(() => { setValue(""); setAccepted(false); }, [prompt.id]);
      useEffect(() => { if (prompt.kind !== "select") inputRef.current?.focus(); }, [prompt.id, prompt.kind]);

      const answer = useCallback(async (answerValue) => {
        const result = await action.run("answer", { provider: account.provider, promptId: prompt.id, value: answerValue },
          result => result.delivered === true ? null : "This prompt is no longer waiting for an answer. Check the current sign-in status.");
        if (result) { setValue(""); setAccepted(true); }
      }, [action.run, account.provider, prompt.id]);
      const feedback = action.error
        ? h("div", { className: "dshd-err", role: "alert" }, action.error)
        : accepted ? h("div", { className: "dshd-hint", role: "status" }, "Answer received. Waiting for sign-in to finish…") : null;

      if (prompt.kind === "select") {
        return h(
          "div",
          { className: "dshd-prompt" },
          feedback,
          h("div", { key: "m", className: "dshd-prompt-msg" }, prompt.message),
          h(
            "div",
            { key: "o", className: "dshd-row" },
            (prompt.options || []).map((option, index) =>
              h(
                "button",
                {
                  key: option.id,
                  type: "button",
                  disabled: sending,
                  className: "dshd-btn " + (index === 0 ? "dshd-btn-primary" : "dshd-btn-outline"),
                  onClick: () => answer(option.id),
                },
                option.label,
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        { className: "dshd-prompt" },
        feedback,
        h("div", { key: "m", className: "dshd-prompt-msg" }, prompt.message),
        h(
          "form",
          {
            key: "f",
            className: "dshd-row",
            onSubmit: (event) => { event.preventDefault(); if (!sending && value.trim()) void answer(value.trim()); },
          },
          h("input", {
            key: "i",
            ref: inputRef,
            className: "dshd-input",
            type: prompt.kind === "secret" ? "password" : "text",
            placeholder: prompt.placeholder || "",
            // A placeholder is not an accessible name (it is not announced as a
            // label and vanishes on input). Name the field from the prompt's own
            // message so a screen-reader user knows what to type.
            "aria-label": prompt.message || (prompt.kind === "secret" ? "Paste your key" : "Enter the code"),
            value,
            disabled: sending,
            spellCheck: false,
            autoComplete: "off",
            onChange: (event) => setValue(event.target.value),
          }),
          h(
            "button",
            { key: "s", type: "submit", className: "dshd-btn dshd-btn-outline", disabled: sending || !value.trim() },
            "Submit",
          ),
        ),
        h(
          "div",
          { key: "h", className: "dshd-hint" },
          prompt.kind === "secret"
            ? "This value is hidden while you type and cleared from this field after submission."
            : "Enter the requested value to continue. If your browser completes sign-in first, this prompt closes automatically.",
        ),
      );
    }

    function resetLabel(seconds) {
      if (!Number.isFinite(seconds)) return '';
      const minutes=Math.max(1,Math.ceil(seconds/60));
      if (minutes>=1440) return `Resets in ${Math.floor(minutes/1440)}d ${Math.floor(minutes%1440/60)}h`;
      if (minutes>=60) return `Resets in ${Math.floor(minutes/60)}h ${minutes%60}m`;
      return `Resets in ${minutes}m`;
    }
    const QUOTA_CSS = `.dshd-account-usage{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px;min-width:0}.dshd-quota-account{min-width:0;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}.dshd-quota-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:10px}.dshd-quota-title>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshd-quota-title small{flex:none;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);text-transform:capitalize}.dshd-quota-title small:empty{display:none}.dshd-quota-windows{display:grid;gap:10px;min-width:0}.dshd-quota-window{min-width:0;--quota-color:var(--dshd-good,#247a4b)}.dshd-quota-window[data-tone=warn]{--quota-color:var(--dshd-warn,#a45d13)}.dshd-quota-window[data-tone=bad]{--quota-color:var(--dshd-bad,#bb3e46)}.dshd-quota-row{display:flex;gap:6px;align-items:baseline;justify-content:space-between;font-size:11px;min-width:0;font-variant-numeric:tabular-nums}.dshd-quota-row>span{color:var(--dsw-alias-label-secondary);min-width:0}.dshd-quota-row b{color:var(--quota-color);font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}.dshd-quota-bar{height:3px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);margin-top:6px}.dshd-quota-bar i{display:block;height:100%;border-radius:999px;background:var(--quota-color);transition:width .3s var(--ds-ease-in-out,ease)}.dshd-quota-reset,.dshd-quota-note{display:block;font-size:10px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:5px 0 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.dshd-quota-window[data-expired=true] .dshd-quota-row b{color:var(--dsw-alias-label-tertiary)}.dshd-account-usage.compact{display:flex;flex-direction:column;gap:12px;max-height:min(26dvh,280px);overflow:auto;overscroll-behavior:contain}.dshd-account-usage.compact .dshd-quota-account{padding:0;border:0;border-radius:0}.dshd-account-usage.compact.scrolls{-webkit-mask-image:linear-gradient(#000 calc(100% - 20px),transparent);mask-image:linear-gradient(#000 calc(100% - 20px),transparent)}.dshd-account-usage.compact .dshd-quota-account+.dshd-quota-account{border-top:1px solid var(--dsw-alias-border-l1);padding-top:12px}.dshd-account-usage.compact .dshd-quota-title{margin-bottom:8px;font-size:11px}.dshd-account-usage.compact .dshd-quota-row{font-size:11px}.dshd-account-usage.compact .dshd-quota-windows{gap:10px}.dshd-account-usage.compact .dshd-quota-reset{font-size:10px;margin-top:4px}@media(prefers-reduced-motion:reduce){.dshd-quota-bar i{transition:none}}`;
    function quotaStyle() {
      if (document.getElementById('dshd-quota-style')) return;
      const style=document.createElement('style');style.id='dshd-quota-style';style.textContent=QUOTA_CSS;document.head.appendChild(style);
    }
    function windowLabel(minutes, fallback) {
      if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
      if (minutes === 10080) return 'Weekly';
      if (minutes === 300) return '5 hours';
      if (minutes % 1440 === 0) return `${minutes/1440} days`;
      if (minutes % 60 === 0) return `${minutes/60} hours`;
      return `${minutes} minutes`;
    }
    function quotaRows(usage, now, compact = false) {
      const rows=[];
      const add=(window,label)=>{
        if (!Number.isFinite(window?.usedPercent)) return;
        const reset=Number.isFinite(window.resetsAt) ? window.resetsAt
          : Number.isFinite(usage?.observedAt) && Number.isFinite(window.resetAfterSeconds) ? usage.observedAt+window.resetAfterSeconds*1000 : null;
        if (compact && window.usedPercent === 0 && !Number.isFinite(window.windowMinutes) && reset === null) return;
        const used=Math.min(100,Math.max(0,window.usedPercent));
        rows.push({label:windowLabel(window.windowMinutes,label),used,remaining:Math.round(100-used),reset,expired:reset!==null&&reset<=now});
      };
      add(usage?.primary,'Allowance');add(usage?.secondary,'Secondary allowance');
      return rows;
    }
    function UsageBar({ usage, now: suppliedNow, stale = false, compact = false }) {
      quotaStyle();
      const [clockNow,setClockNow]=useState(Date.now);
      useEffect(()=>{
        if (suppliedNow !== undefined) return;
        const timer=setInterval(()=>setClockNow(Date.now()),30000);
        return()=>clearInterval(timer);
      },[suppliedNow !== undefined]);
      const now=suppliedNow ?? clockNow;
      stale=stale || usage?.status==='stale' || !Number.isFinite(usage?.observedAt) || now-usage.observedAt>10*60000;
      const rows=quotaRows(usage,now,compact);
      if (!rows.length) return null;
      return h('div',{className:'dshd-quota-windows'},rows.map((row,i)=>{
        const resetText = row.expired ? 'Reset passed · waiting for refresh' : [
          stale?'Last known':null,row.reset?resetLabel(Math.ceil((row.reset-now)/1000)):(compact?null:'Reset time not reported')
        ].filter(Boolean).join(' · ');
        return h('div',{key:i,className:'dshd-quota-window','data-tone':row.used>=95?'bad':row.used>=75?'warn':'good','data-expired':row.expired},
        h('div',{className:'dshd-quota-row'},h('span',null,row.label),h('b',null,row.expired?'—':`${row.remaining}% left`)),
        row.expired?null:h('div',{className:'dshd-quota-bar',role:'progressbar','aria-label':row.label+' remaining','aria-valuenow':row.remaining,'aria-valuemin':0,'aria-valuemax':100},h('i',{style:{width:row.remaining+'%'}})),
        resetText?h('small',{className:'dshd-quota-reset',title:row.reset?new Date(row.reset).toLocaleString():undefined},resetText):null);
      }));
    }
    function AccountUsage({ compact = false, className = "" }) {
      quotaStyle();
      const {accounts,loaded,streamLost,retry}=useAuthState();
      const [now,setNow]=useState(Date.now);
      useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),30000);return()=>clearInterval(timer);},[]);
      const connected=accounts.filter(a=>a.configured).sort((a,b)=>(a.provider==='openai-codex'?-1:0)-(b.provider==='openai-codex'?-1:0));
      // Settings is a provider inventory, so "this provider reports nothing"
      // earns a line there. The sidebar is a glance at what is left, where the
      // same line can only spend height saying nothing — so compact keeps the
      // accounts that can report a quota and renders nothing when none can.
      const listed=compact?connected.filter(account=>quotaRows(account.usage,now,true).length):connected;
      // Whether the glance list overflows is a measurement, not a guess from
      // the row count: accounts report different numbers of windows, so two
      // accounts can overflow where three do not. Guessing wrong either clips a
      // row with no cue or fades a list that fits, and both read as a bug.
      const list=useRef(null);
      const [scrolls,setScrolls]=useState(false);
      const measure=useCallback(()=>{
        const node=list.current;
        if (node) setScrolls(node.scrollHeight-node.clientHeight>1);
      },[]);
      useEffect(measure);
      useEffect(()=>{
        const node=list.current;
        if (!node||typeof ResizeObserver!=='function') return;
        const observer=new ResizeObserver(measure);
        observer.observe(node);
        return()=>observer.disconnect();
      },[measure,compact]);
      // Same reasoning one step earlier: "Checking account limits…" is a report
      // that there is nothing to report yet, and the glance card should never
      // spend a line on that either. It stays silent until it has a quota to
      // show, and only speaks up when no account is connected at all — which is
      // an action to take, not a status. The settings inventory still says both.
      if (compact&&!listed.length&&(!loaded||connected.length)) return null;
      // A list that actually overflows fades at its bottom edge: nothing in
      // this app draws a scrollbar, so the fade is the only cue there is more.
      return h('div',{ref:list,className:'dshd-account-usage'+(compact?' compact':'')+(compact&&scrolls?' scrolls':'')+(className?' '+className:'')},
        !loaded?h('span',{className:'dshd-quota-note'},streamLost?'Account limits unavailable':'Checking account limits…'):null,
        loaded&&!connected.length?h('span',{className:'dshd-quota-note'},'Connect an account in Settings to see plan limits.'):null,
        listed.map(account=>{
          const usage=account.usage;
          const stale=streamLost||usage?.status==='stale'||!Number.isFinite(usage?.observedAt)||now-usage.observedAt>10*60000;
          const rows=quotaRows(usage,now);
          return h('div',{key:account.key,className:'dshd-quota-account'},
            h('div',{className:'dshd-quota-title'},h('span',{'data-dshd-provider':account.provider},present(account).name),h('small',null,usage?.planType?.replaceAll('_',' ')||'')),
            rows.length?h(UsageBar,{usage,now,stale,compact}):h('span',{className:'dshd-quota-note'},account.provider==='openai-codex'?'Codex plan limits unavailable':'Limits not reported by this provider'),
            !compact?(usage?.additional||[]).map((extra,i)=>h('div',{key:i,style:{marginTop:12}},h('p',{className:'dshd-quota-note'},extra.name),h(UsageBar,{usage:{...extra,observedAt:usage.observedAt},now,stale}))):null,
            !compact&&account.provider==='openai-codex'?h('p',{className:'dshd-quota-note'},'Codex allowance on your ChatGPT plan. Separate from ChatGPT web-chat limits.'):null,
            stale&&rows.length?h('span',{className:'dshd-quota-note'},'Last reported limits · refresh pending'):null);
        }),
        streamLost&&!compact?h('button',{type:'button',className:'dshd-us-refresh',onClick:retry},'Reconnect account usage'):null);
    }

    /** How long an armed sign-out stays armed before it forgets it was asked. */
    const ARM_MS = 4000;

    /**
     * Two-step sign-out.
     *
     * The single click this replaces destroyed an OAuth credential with no undo
     * and no confirmation — the user's only recovery was to walk the whole
     * consent flow again. Arming is cheaper than a modal and stays inside the
     * card: first click asks, second click does it, and it disarms on blur or
     * after ARM_MS so a stray click never leaves a loaded gun in the foot.
     */
    function SignOutButton({ account, disabled = false }) {
      const [armed, setArmed] = useState(false);
      const timer = useRef(null);
      const action = useAuthAction(account.provider);

      useEffect(() => () => clearTimeout(timer.current), []);

      const disarm = useCallback(() => {
        clearTimeout(timer.current);
        setArmed(false);
      }, []);

      useEffect(() => { if (disabled) disarm(); }, [disabled, disarm]);

      const click = useCallback(() => {
        if (disabled || action.pending) return;
        if (!armed) {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), ARM_MS);
          return;
        }
        disarm();
        void action.run("signout", { provider: account.provider });
      }, [armed, disarm, account.provider, action.run, action.pending, disabled]);

      return h("div", { className: "dshd-signout-action" },
        action.error ? h("div", { className: "dshd-err", role: "alert" }, action.error) : null,
        h(
        "button",
        {
          type: "button",
          disabled: disabled || action.pending,
          className: "dshd-btn dshd-btn-signout" + (armed ? " dshd-btn-armed" : ""),
          onClick: click,
          onBlur: disarm,
          // The accessible name must CONTAIN the visible label, or speech-input
          // users cannot activate the control by saying what they can see
          // (WCAG 2.5.3). "Sign ChatGPT out of this Mac" splits the visible
          // "Sign out" across an inserted provider name, so "click sign out"
          // matched nothing — on the confirmation gate for a destructive,
          // unrecoverable action.
          "aria-label": armed
            ? `Confirm sign out of ${present(account).name} on this Mac`
            : `Sign out of ${present(account).name} on this Mac`,
        },
        action.pending ? "Signing out…" : armed ? "Confirm sign out" : "Sign out",
      ));
    }

    function Card({ account, live, outcome }) {
      const meta = present(account);
      const busy = Boolean(live && live.busy) || account.inFlight;
      const action = useAuthAction(`${account.provider}:${live?.attemptId || ""}`);
      const working = action.pending;
      const localError = action.error;
      const begin = useCallback((method) => action.run("begin", { provider: account.provider, method }), [action.run, account.provider]);
      const cancel = () => action.run("cancel", { provider: account.provider, attemptId: live?.attemptId });

      const oauth = account.methods.find((m) => m.id === "oauth");
      const blocked = account.loopbackBusy === true;
      // A begin that never started is this surface's own error; anything else is
      // the attempt's reported outcome, which may be a cancellation rather than a
      // failure and must not shout like one.
      const report = localError ? { tone: "error", message: localError }
        : account.signOutWarning ? { tone: "warn", message: account.signOutWarning } : outcome;

      return h(
        "div",
        { className: "dshd-card" },
        h(
          "div",
          { key: "head", className: "dshd-card-head" },
          h(
            "div",
            { key: "id", className: "dshd-card-ident" },
            h(
              "span",
              { key: "m", className: "dshd-card-mark" },
              h(ProviderMark, { provider: account.provider, size: 20 }),
            ),
            h(
              "div",
              { key: "t", className: "dshd-card-title" },
              h("span", { key: "n", className: "dshd-card-name" }, meta.name),
              h("span", { key: "s", className: "dshd-card-sub" }, meta.sub),
            ),
          ),
          account.configured ? h("span", { key: "b", className: "dshd-badge" }, "Connected") : null,
        ),

        // Middle row. Everything below is optional and varies by provider and by
        // moment; it grows and shrinks here so the foot never moves.
        h(
          "div",
          { key: "body", className: "dshd-card-body" },

          account.configured ? h(UsageBar, { key: "usage", usage: account.usage }) : null,

          report
            ? h(
                "div",
                {
                  key: "report",
                  className: report.tone === "warn" ? "dshd-warn" : "dshd-err",
                  role: report.tone === "warn" ? "status" : "alert",
                },
                report.message,
              )
            : null,

          blocked && !busy
            ? h(
                "div",
                { key: "warn", className: "dshd-warn" },
                `Port ${account.loopbackPort} is in use, so the browser sign-in cannot start. `
                  + "Close the OpenAI Codex CLI if it is running, or wait a moment after cancelling "
                  + "a previous attempt, then choose the device-code option.",
              )
            : null,

          busy && live
            ? h(
                "div",
                { key: "live", className: "dshd-live", "aria-live": "polite" },
                (live.notices || []).map((notice, index) => h(Notice, { key: `n${index}`, notice })),
                live.prompt ? h(Prompt, { key: live.prompt.id, account, prompt: live.prompt }) : null,
              )
            : null,

          !account.configured && oauth && BORROWED_CLIENT[account.provider]
            ? h(
                "div",
                { key: "borrowed", className: "dshd-hint" },
                `Sign-in uses ${BORROWED_CLIENT[account.provider]} client, so the consent `
                  + "screen will name it rather than DSH PRO. Your credentials are stored "
                  + "only on this Mac.",
              )
            : null,

          account.configured
            ? h(
                "div",
                { key: "note", className: "dshd-hint" },
                "Signing out forgets the credential on this Mac only — it does not revoke access with the provider.",
              )
            : null,
        ),

        // Foot. Last in the DOM as well as last on screen, which is what keeps
        // the four action rails on one baseline whatever the middle holds.
        h(
          "div",
          { key: "foot", className: "dshd-card-foot" },
          busy
            ? h(
                "button",
                {
                  key: "cancel",
                  type: "button",
                  className: "dshd-btn dshd-btn-quiet",
                  onClick: cancel,
                  disabled: working,
                },
                working ? "Cancelling…" : "Cancel sign-in",
              )
            : null,
          !account.configured && oauth
            ? h(
                "button",
                {
                  key: "in",
                  type: "button",
                  className: "dshd-btn dshd-btn-primary",
                  disabled: busy || working || account.signingOut,
                  onClick: () => begin("oauth"),
                },
                account.signingOut ? "Signing out…" : (busy || working) ? "Signing in…" : meta.verb,
              )
            : null,
          account.configured ? h(SignOutButton, { key: "out", account, disabled: busy || account.signingOut }) : null,
        ),
      );
    }

    /** The stream is gone and retries are spent — say so, and offer the retry. */
    function StreamLost({ retry, stale }) {
      return h(
        "div",
        { className: "dshd-err dshd-err-row", role: "alert" },
        h(
          "span",
          { key: "m" },
          stale
            ? "Lost the connection to the app's own host, so what you see below may be out of date."
            : "The app could not reach its own host, so account status is unavailable.",
        ),
        h(
          "button",
          { key: "r", type: "button", className: "dshd-btn dshd-btn-outline dshd-copy dshd-retry", onClick: retry },
          "Retry",
        ),
      );
    }

    /**
     * Local model servers — Ollama and LM Studio.
     *
     * Detection is the host's job (host-auth-api probes the well-known loopback
     * ports and writes the routes into llm-pi-ai settings); this section only
     * SHOWS that state. No buttons: a server that is running appears with its
     * models, one that is not shows how to start it. Polled while mounted, so
     * starting Ollama flips the row green without reopening Settings.
     */
    const LOCAL_CSS = [
      ".dshd-local{margin-top:24px;display:flex;flex-direction:column;gap:10px}",
      ".dshd-local-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".dshd-local h3{margin:0;font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-local-intro{margin:0;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-local-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px}",
      ".dshd-local-row{display:flex;align-items:center;gap:10px;padding:14px 16px;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:14px;",
      "background:var(--dsw-alias-bg-layer-1,#1d1e21);",
      "transition:border-color .15s ease,background-color .15s ease;",
      "font:var(--dsw-font-xs-13,13px/20px sans-serif)}",
      ".dshd-local-row:hover{border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.2))}",
      ".dshd-local-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;",
      "background:var(--dsw-alias-border-l3,rgba(255,255,255,.25))}",
      ".dshd-local-row.is-up .dshd-local-dot{background:var(--dsw-alias-state-success,#3fb950)}",
      ".dshd-local-name{font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-local-sub{color:var(--dsw-alias-label-tertiary,#adb2b8);min-width:0;",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto}",
      ".dshd-direct-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(216px,1fr));gap:10px}",
      ".dshd-direct-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:14px;",
      "background:var(--dsw-alias-bg-layer-3,#353638);transition:border-color .15s ease}",
      ".dshd-direct-card:hover{border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.2))}",
      ".dshd-direct-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}",
      ".dshd-direct-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;flex-wrap:wrap}",
      ".dshd-env-badge{font:500 10px/16px monospace;padding:1px 7px;border-radius:999px;white-space:nowrap;",
      "color:var(--dsw-alias-label-secondary,#cfd3d6);background:var(--dsw-alias-bg-module-platform,#2c2d2f);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-gw-card{display:flex;flex-direction:column;gap:12px;padding:16px 18px;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));border-radius:14px;",
      "background:var(--dsw-alias-bg-layer-3,#353638)}",
      ".dshd-gw-presets{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".dshd-gw-pill{height:26px;padding:0 10px;border-radius:999px;font-size:11px;font-weight:500;cursor:pointer;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f);color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      ".dshd-gw-pill:hover{border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.22));color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-gw-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px}",
    ].join("");
    const LOCAL_STYLE_ID = "dshd-local-style";
    function ensureLocalStyle() {
      if (typeof document === "undefined" || document.getElementById(LOCAL_STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = LOCAL_STYLE_ID;
      el.textContent = LOCAL_CSS;
      document.head.appendChild(el);
    }

    function OpenCodeZenCard() {
      const [zen, setZen] = useState(null);
      const [editing, setEditing] = useState(false);
      const [apiKey, setApiKey] = useState("");
      const [busy, setBusy] = useState(false);
      const [armed, setArmed] = useState(false);
      const [error, setError] = useState(null);
      const armTimer = useRef(null);

      useEffect(() => {
        let alive = true;
        fetch("/dsh-auth/opencode", { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (alive && d) setZen(d); })
          .catch(() => {});
        return () => { alive = false; clearTimeout(armTimer.current); };
      }, []);

      const run = async (payload) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const res = await post("opencode", payload);
        setBusy(false);
        if (!res.ok) {
          setError(res.error || "Could not update OpenCode Zen.");
          return;
        }
        setZen(res);
        setEditing(false);
        setApiKey("");
        setArmed(false);
      };

      const configured = Boolean(zen?.configured);
      const cliAvailable = Boolean(zen?.cliAvailable);
      const modelCount = zen?.modelCount || 0;

      return h(
        "div",
        { className: "dshd-card" },
        h(
          "div",
          { key: "head", className: "dshd-card-head" },
          h(
            "div",
            { key: "id", className: "dshd-card-ident" },
            h(
              "span",
              { key: "m", className: "dshd-card-mark" },
              h(ProviderMark, { provider: "opencode", size: 20 }),
            ),
            h(
              "div",
              { key: "t", className: "dshd-card-title" },
              h("span", { key: "n", className: "dshd-card-name" }, "OpenCode Zen"),
              h("span", { key: "s", className: "dshd-card-sub" }, "OpenCode Zen & Go coding gateway"),
            ),
          ),
          configured ? h("span", { key: "b", className: "dshd-badge" }, "Connected") : null,
        ),
        h(
          "div",
          { key: "body", className: "dshd-card-body" },
          error ? h("div", { key: "err", className: "dshd-err", role: "alert" }, error) : null,
          configured
            ? h(
                "div",
                { key: "connected", className: "dshd-hint" },
                `${modelCount > 0 ? modelCount : "80+"} OpenCode Zen models active in the model picker (Claude, GPT-5, DeepSeek, Gemini, Kimi, plus free Zen models).`,
              )
            : editing
              ? h(
                  "div",
                  { key: "form", className: "dshd-prompt" },
                  h(
                    "div",
                    { key: "m", className: "dshd-prompt-msg" },
                    "Paste your API key from ",
                    h(
                      "a",
                      {
                        className: "dshd-link",
                        href: "https://opencode.ai/auth",
                        target: "_blank",
                        rel: "noreferrer noopener",
                      },
                      "opencode.ai/auth ↗",
                    ),
                  ),
                  h(
                    "form",
                    {
                      key: "f",
                      className: "dshd-row",
                      onSubmit: (e) => {
                        e.preventDefault();
                        if (!busy && apiKey.trim()) void run({ action: "connect", apiKey: apiKey.trim() });
                      },
                    },
                    h("input", {
                      key: "i",
                      className: "dshd-input",
                      type: "password",
                      placeholder: "sk-…",
                      "aria-label": "OpenCode Zen API key",
                      value: apiKey,
                      disabled: busy,
                      onChange: (e) => setApiKey(e.target.value),
                    }),
                    h(
                      "button",
                      {
                        key: "s",
                        type: "submit",
                        className: "dshd-btn dshd-btn-primary",
                        disabled: busy || !apiKey.trim(),
                      },
                      busy ? "Connecting…" : "Connect",
                    ),
                  ),
                )
              : h(
                  "div",
                  { key: "hint", className: "dshd-hint" },
                  cliAvailable
                    ? "OpenCode CLI credentials detected on this Mac — connect in one click, or use a key from opencode.ai/auth."
                    : "Access curated coding models and free Zen tier models with an OpenCode key from ",
                  !cliAvailable
                    ? h(
                        "a",
                        {
                          className: "dshd-link",
                          href: "https://opencode.ai/auth",
                          target: "_blank",
                          rel: "noreferrer noopener",
                        },
                        "opencode.ai/auth ↗",
                      )
                    : null,
                ),
        ),
        h(
          "div",
          { key: "foot", className: "dshd-card-foot" },
          configured
            ? [
                h(
                  "button",
                  {
                    key: "refresh",
                    type: "button",
                    className: "dshd-btn dshd-btn-quiet",
                    disabled: busy,
                    onClick: () => void run({ action: "refresh" }),
                  },
                  busy ? "Refreshing…" : "Refresh models",
                ),
                h(
                  "button",
                  {
                    key: "out",
                    type: "button",
                    disabled: busy,
                    className: "dshd-btn dshd-btn-signout" + (armed ? " dshd-btn-armed" : ""),
                    onBlur: () => { clearTimeout(armTimer.current); setArmed(false); },
                    onClick: () => {
                      if (busy) return;
                      if (!armed) {
                        setArmed(true);
                        armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
                        return;
                      }
                      clearTimeout(armTimer.current);
                      setArmed(false);
                      void run({ action: "disconnect" });
                    },
                  },
                  busy ? "Signing out…" : armed ? "Confirm sign out" : "Sign out",
                ),
              ]
            : editing
              ? h(
                  "button",
                  {
                    key: "cancel",
                    type: "button",
                    className: "dshd-btn dshd-btn-quiet",
                    disabled: busy,
                    onClick: () => { setEditing(false); setError(null); setApiKey(""); },
                  },
                  "Cancel",
                )
              : cliAvailable
                ? [
                    h(
                      "button",
                      {
                        key: "key",
                        type: "button",
                        className: "dshd-btn dshd-btn-outline",
                        disabled: busy,
                        onClick: () => setEditing(true),
                      },
                      "Enter key",
                    ),
                    h(
                      "button",
                      {
                        key: "cli",
                        type: "button",
                        className: "dshd-btn dshd-btn-primary",
                        disabled: busy,
                        onClick: () => void run({ action: "connect", useCli: true }),
                      },
                      busy ? "Connecting…" : "Sign in with OpenCode CLI",
                    ),
                  ]
                : h(
                    "button",
                    {
                      key: "in",
                      type: "button",
                      className: "dshd-btn dshd-btn-primary",
                      disabled: busy,
                      onClick: () => setEditing(true),
                    },
                    "Sign in with OpenCode Zen",
                  ),
        ),
      );
    }

    function LocalModelsSection() {
      ensureLocalStyle();
      const [servers, setServers] = useState(null);
      useEffect(() => {
        let alive = true;
        const pull = () => {
          fetch("/dsh-auth/local-models", { credentials: "same-origin" })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (alive && d) setServers(d); })
            .catch(() => {});
        };
        pull();
        const timer = setInterval(pull, 10_000);
        return () => { alive = false; clearInterval(timer); };
      }, []);
      const entries = servers === null
        ? []
        : Object.entries(servers).filter(([, v]) => v && typeof v === "object");
      if (entries.length === 0) return null;
      return h("div", { className: "dshd-local" },
        h("div", { key: "h", className: "dshd-local-head" }, h("h3", null, "Local models")),
        h("p", { key: "p", className: "dshd-local-intro" },
          "Run models on this Mac with Ollama or LM Studio — no account, no key. "
            + "A running server is detected automatically and its models join the picker."),
        h("div", { key: "g", className: "dshd-local-grid" },
          entries.map(([id, srv]) =>
            h("div", { key: id, className: "dshd-local-row" + (srv.up ? " is-up" : "") },
              h("i", { key: "d", className: "dshd-local-dot" }),
              h("span", { key: "n", className: "dshd-local-name", "data-dshd-provider": id }, srv.displayName || id),
              h("span", { key: "s", className: "dshd-local-sub" },
                srv.up
                  ? (srv.models.length === 0
                      ? "Running — no models installed yet"
                      : `${srv.models.length} model${srv.models.length === 1 ? "" : "s"}: ${srv.models.slice(0, 3).join(", ")}${srv.models.length > 3 ? "…" : ""}`)
                  : `Not running · ${srv.hint || "start it and it appears here"}`)))));
    }

    function ModelCatalogSection() {
      ensureLocalStyle();
      const [catalog, setCatalog] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(null);
      const request = useRef(null);
      useEffect(() => {
        let alive = true, active = null, timer;
        const pull = async (force = false) => {
          if (!alive || active) return;
          const controller = new AbortController();
          active = controller;
          if (force) setBusy(true);
          try {
            const response = await fetch(force ? "/dsh-auth/models/refresh" : "/dsh-auth/models", {
              method: force ? "POST" : "GET", credentials: "same-origin",
              ...(force ? { headers: { "Content-Type": "application/json" }, body: "{}" } : {}),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
            });
            if (!response.ok) throw new Error("Model refresh is unavailable.");
            const data = await response.json();
            if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid model status.");
            if (alive) { setCatalog(data); setError(null); }
          } catch {
            if (alive) setError("Could not check model updates. Try again.");
          } finally {
            active = null;
            if (alive) setBusy(false);
          }
        };
        request.current = pull;
        void pull();
        timer = setInterval(() => { void pull(); }, 5000);
        return () => { alive = false; clearInterval(timer); active?.abort(); request.current = null; };
      }, []);
      const entries = Object.entries(catalog || {}).filter(([, row]) => row && row.status !== "disconnected");
      return h("div", { className: "dshd-local" },
        h("div", { className: "dshd-local-head" },
          h("h3", null, "Model updates"),
          h("button", { type: "button", className: "dshd-btn dshd-btn-outline", disabled: busy,
            onClick: () => { void request.current?.(true); } }, busy ? "Refreshing…" : "Refresh models")),
        h("p", { className: "dshd-local-intro" },
          "Connected accounts check for new models automatically every 15 minutes. Your selected model stays the same."),
        error ? h("p", { role: "alert", className: "dshd-local-intro" }, error) : null,
        entries.length > 0
          ? h("div", { className: "dshd-local-grid" },
              entries.map(([id, row]) => h("div", { key: id, className: "dshd-local-row" },
                h("span", { className: "dshd-local-name", "data-dshd-provider": id }, row.name || id),
                h("span", { className: "dshd-local-sub", title: row.checkedAt ? new Date(row.checkedAt).toLocaleString() : undefined },
                  row.status === "fresh" ? `${row.count} models · Updated ${new Date(row.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : row.status === "custom" ? "Custom model settings · Automatic changes paused"
                      : row.status === "stale" ? row.error || "Using the previous model list"
                        : row.status === "refreshing" ? "Checking provider…" : "Waiting for account…"))))
          : null,
      );
    }

    const GATEWAY_PRESETS = [
      { label: "vLLM (:8000)", name: "vLLM Local", url: "http://127.0.0.1:8000/v1" },
      { label: "Llama.cpp (:8080)", name: "Llama.cpp Server", url: "http://127.0.0.1:8080/v1" },
      { label: "LiteLLM (:4000)", name: "LiteLLM Proxy", url: "http://127.0.0.1:4000/v1" },
      { label: "Jan (:1337)", name: "Jan Local", url: "http://127.0.0.1:1337/v1" },
      { label: "SGLang (:30000)", name: "SGLang Server", url: "http://127.0.0.1:30000/v1" },
    ];

    function DirectProviderCard({ item, onMutate }) {
      const [editing, setEditing] = useState(false);
      const [apiKey, setApiKey] = useState("");
      const [busy, setBusy] = useState(false);
      const [armed, setArmed] = useState(false);
      const [error, setError] = useState(null);
      const armTimer = useRef(null);

      useEffect(() => () => clearTimeout(armTimer.current), []);

      const run = async (payload) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const res = await post("direct", payload);
        setBusy(false);
        if (!res.ok) {
          setError(res.error || `Could not update ${item.name}.`);
          return;
        }
        onMutate(res);
        setEditing(false);
        setApiKey("");
        setArmed(false);
      };

      return h(
        "div",
        { className: "dshd-direct-card", "data-dshd-direct": item.id },
        h(
          "div",
          { key: "top", className: "dshd-direct-top" },
          h(
            "div",
            { className: "dshd-card-ident" },
            h(
              "span",
              { className: "dshd-card-mark", style: { width: "28px", height: "28px" } },
              h(ProviderMark, { provider: item.id, size: 16 }),
            ),
            h(
              "div",
              { className: "dshd-card-title" },
              h("span", { className: "dshd-card-name", style: { fontSize: "13px", lineHeight: "19px" } }, item.name),
              h("span", { className: "dshd-card-sub", style: { fontSize: "11px", lineHeight: "16px" } }, item.sub),
            ),
          ),
          item.configured
            ? h("span", { className: "dshd-badge" }, "Connected")
            : item.envAvailable
              ? h("span", { className: "dshd-env-badge", title: `${item.envVar} detected in environment` }, `$${item.envVar}`)
              : null,
        ),
        error ? h("div", { key: "err", className: "dshd-err", role: "alert" }, error) : null,
        editing
          ? h(
              "form",
              {
                key: "form",
                className: "dshd-prompt",
                onSubmit: (e) => {
                  e.preventDefault();
                  if (!busy && apiKey.trim()) void run({ action: "connect", provider: item.id, apiKey: apiKey.trim() });
                },
              },
              h("input", {
                className: "dshd-input",
                style: { flex: "1 1 auto" },
                type: "password",
                placeholder: item.placeholder || "API key…",
                "aria-label": `${item.name} API key`,
                value: apiKey,
                disabled: busy,
                onChange: (e) => setApiKey(e.target.value),
              }),
              h(
                "div",
                { className: "dshd-direct-foot" },
                item.keyUrl
                  ? h(
                      "a",
                      { className: "dshd-link", style: { fontSize: "11px" }, href: item.keyUrl, target: "_blank", rel: "noreferrer noopener" },
                      "Get API key ↗",
                    )
                  : h("span"),
                h(
                  "div",
                  { className: "dshd-row", style: { gap: "6px" } },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dshd-btn dshd-btn-quiet dshd-copy",
                      disabled: busy,
                      onClick: () => { setEditing(false); setError(null); setApiKey(""); },
                    },
                    "Cancel",
                  ),
                  h(
                    "button",
                    {
                      type: "submit",
                      className: "dshd-btn dshd-btn-primary dshd-copy",
                      disabled: busy || !apiKey.trim(),
                    },
                    busy ? "Saving…" : "Connect",
                  ),
                ),
              ),
            )
          : h(
              "div",
              { key: "foot", className: "dshd-direct-foot" },
              item.configured
                ? [
                    h(
                      "span",
                      { key: "cnt", className: "dshd-hint", style: { fontSize: "11px" } },
                      item.modelCount > 0 ? `${item.modelCount} models active` : "Active in picker",
                    ),
                    h(
                      "button",
                      {
                        key: "out",
                        type: "button",
                        disabled: busy,
                        className: "dshd-btn dshd-btn-signout dshd-copy" + (armed ? " dshd-btn-armed" : ""),
                        onBlur: () => { clearTimeout(armTimer.current); setArmed(false); },
                        onClick: () => {
                          if (busy) return;
                          if (!armed) {
                            setArmed(true);
                            armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
                            return;
                          }
                          clearTimeout(armTimer.current);
                          setArmed(false);
                          void run({ action: "disconnect", provider: item.id });
                        },
                      },
                      busy ? "Removing…" : armed ? "Confirm" : "Disconnect",
                    ),
                  ]
                : item.envAvailable
                  ? [
                      h(
                        "button",
                        {
                          key: "env",
                          type: "button",
                          className: "dshd-btn dshd-btn-primary dshd-copy",
                          disabled: busy,
                          onClick: () => void run({ action: "connect", provider: item.id, useEnv: true }),
                        },
                        busy ? "Connecting…" : "Use env key",
                      ),
                      h(
                        "button",
                        {
                          key: "manual",
                          type: "button",
                          className: "dshd-btn dshd-btn-outline dshd-copy",
                          disabled: busy,
                          onClick: () => setEditing(true),
                        },
                        "Paste key",
                      ),
                    ]
                  : h(
                      "button",
                      {
                        key: "add",
                        type: "button",
                        className: "dshd-btn dshd-btn-outline dshd-copy",
                        disabled: busy,
                        onClick: () => setEditing(true),
                      },
                      "Connect API key",
                    ),
            ),
      );
    }

    function CustomGatewayCard({ gateway, onMutate }) {
      const configured = Boolean(gateway?.configured);
      const [editing, setEditing] = useState(false);
      const [displayName, setDisplayName] = useState(gateway?.displayName || "Custom Gateway");
      const [baseURL, setBaseURL] = useState(gateway?.baseURL || "");
      const [apiKey, setApiKey] = useState("");
      const [models, setModels] = useState((gateway?.models || []).join(", "));
      const [busy, setBusy] = useState(false);
      const [armed, setArmed] = useState(false);
      const [error, setError] = useState(null);
      const armTimer = useRef(null);

      useEffect(() => () => clearTimeout(armTimer.current), []);

      const applyPreset = (preset) => {
        setEditing(true);
        setDisplayName(preset.name);
        setBaseURL(preset.url);
        setError(null);
      };

      const run = async (payload) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const res = await post("direct", payload);
        setBusy(false);
        if (!res.ok) {
          setError(res.error || "Could not configure custom gateway.");
          return;
        }
        onMutate(res);
        setEditing(false);
        setApiKey("");
        setArmed(false);
      };

      return h(
        "div",
        { className: "dshd-gw-card", "data-dshd-gateway": "custom-gateway" },
        h(
          "div",
          { key: "head", className: "dshd-direct-top" },
          h(
            "div",
            { className: "dshd-card-ident" },
            h(
              "span",
              { className: "dshd-card-mark" },
              h(ProviderMark, { provider: "custom-gateway", size: 20 }),
            ),
            h(
              "div",
              { className: "dshd-card-title" },
              h("span", { className: "dshd-card-name" }, configured ? gateway.displayName : "Custom OpenAI-Compatible Gateway"),
              h(
                "span",
                { className: "dshd-card-sub" },
                configured
                  ? `${gateway.baseURL} · ${gateway.modelCount || 0} model${gateway.modelCount === 1 ? "" : "s"} (${(gateway.models || []).slice(0, 4).join(", ")})`
                  : "Connect vLLM, Llama.cpp, LiteLLM, SGLang, Jan, or any local/cloud /v1 endpoint",
              ),
            ),
          ),
          configured ? h("span", { className: "dshd-badge" }, "Connected") : null,
        ),
        error ? h("div", { key: "err", className: "dshd-err", role: "alert" }, error) : null,
        !configured || editing
          ? h(
              "div",
              { key: "presets", className: "dshd-gw-presets" },
              h("span", { className: "dshd-hint", style: { fontSize: "11px", marginRight: "4px" } }, "Quick presets:"),
              GATEWAY_PRESETS.map((preset) =>
                h(
                  "button",
                  {
                    key: preset.label,
                    type: "button",
                    className: "dshd-gw-pill",
                    onClick: () => applyPreset(preset),
                  },
                  preset.label,
                ),
              ),
            )
          : null,
        editing
          ? h(
              "form",
              {
                key: "form",
                className: "dshd-prompt",
                onSubmit: (e) => {
                  e.preventDefault();
                  if (!busy && baseURL.trim()) {
                    void run({
                      action: "connect-gateway",
                      displayName: displayName.trim() || "Custom Gateway",
                      baseURL: baseURL.trim(),
                      apiKey: apiKey.trim(),
                      models,
                    });
                  }
                },
              },
              h(
                "div",
                { className: "dshd-gw-fields" },
                h("input", {
                  className: "dshd-input",
                  type: "text",
                  placeholder: "Gateway name (e.g. vLLM Local)",
                  "aria-label": "Gateway display name",
                  value: displayName,
                  disabled: busy,
                  onChange: (e) => setDisplayName(e.target.value),
                }),
                h("input", {
                  className: "dshd-input",
                  type: "text",
                  placeholder: "http://127.0.0.1:8000/v1",
                  "aria-label": "Gateway base URL",
                  value: baseURL,
                  disabled: busy,
                  onChange: (e) => setBaseURL(e.target.value),
                }),
                h("input", {
                  className: "dshd-input",
                  type: "password",
                  placeholder: "API key (optional for local servers)",
                  "aria-label": "Gateway API key",
                  value: apiKey,
                  disabled: busy,
                  onChange: (e) => setApiKey(e.target.value),
                }),
                h("input", {
                  className: "dshd-input",
                  type: "text",
                  placeholder: "Model IDs (auto-discovered from /models if blank)",
                  "aria-label": "Gateway model IDs",
                  value: models,
                  disabled: busy,
                  onChange: (e) => setModels(e.target.value),
                }),
              ),
              h(
                "div",
                { className: "dshd-direct-foot" },
                h("span", { className: "dshd-hint" }, "Probes /models automatically and merges any model IDs you list."),
                h(
                  "div",
                  { className: "dshd-row", style: { gap: "8px" } },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "dshd-btn dshd-btn-quiet dshd-copy",
                      disabled: busy,
                      onClick: () => { setEditing(false); setError(null); },
                    },
                    "Cancel",
                  ),
                  h(
                    "button",
                    {
                      type: "submit",
                      className: "dshd-btn dshd-btn-primary dshd-copy",
                      disabled: busy || !baseURL.trim(),
                    },
                    busy ? "Probing & saving…" : "Connect gateway",
                  ),
                ),
              ),
            )
          : h(
              "div",
              { key: "foot", className: "dshd-direct-foot" },
              h(
                "span",
                { className: "dshd-hint" },
                configured
                  ? "Routes requests over OpenAI-compatible Chat Completions."
                  : "Auto-discovers models from any /v1/models endpoint or accepts custom model IDs.",
              ),
              h(
                "div",
                { className: "dshd-row", style: { gap: "8px" } },
                h(
                  "button",
                  {
                    type: "button",
                    className: "dshd-btn dshd-btn-outline dshd-copy",
                    disabled: busy,
                    onClick: () => {
                      setDisplayName(gateway?.displayName || "Custom Gateway");
                      setBaseURL(gateway?.baseURL || "http://127.0.0.1:8000/v1");
                      setModels((gateway?.models || []).join(", "));
                      setEditing(true);
                    },
                  },
                  configured ? "Edit gateway" : "Configure gateway",
                ),
                configured
                  ? h(
                      "button",
                      {
                        type: "button",
                        disabled: busy,
                        className: "dshd-btn dshd-btn-signout dshd-copy" + (armed ? " dshd-btn-armed" : ""),
                        onBlur: () => { clearTimeout(armTimer.current); setArmed(false); },
                        onClick: () => {
                          if (busy) return;
                          if (!armed) {
                            setArmed(true);
                            armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
                            return;
                          }
                          clearTimeout(armTimer.current);
                          setArmed(false);
                          void run({ action: "disconnect-gateway" });
                        },
                      },
                      busy ? "Removing…" : armed ? "Confirm" : "Disconnect",
                    )
                  : null,
              ),
            ),
      );
    }

    function DirectProvidersSection() {
      ensureLocalStyle();
      const [direct, setDirect] = useState(null);
      const [busyAll, setBusyAll] = useState(false);
      const [bulkError, setBulkError] = useState(null);
      useEffect(() => {
        let alive = true;
        fetch("/dsh-auth/direct", { credentials: "same-origin" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => { if (alive && d && Array.isArray(d.providers)) setDirect(d); })
          .catch(() => {});
        return () => { alive = false; };
      }, []);
      const providers = direct?.providers || [];
      if (providers.length === 0 && !direct?.gateway) return null;
      const unconfiguredEnvCount = providers.filter((p) => p.envAvailable && !p.configured).length;
      const connectAllEnv = async () => {
        setBusyAll(true);
        setBulkError(null);
        try {
          const res = await post("direct", { action: "connect-all-env" });
          if (res.ok && Array.isArray(res.providers)) {
            setDirect(res);
            if (Array.isArray(res.errors) && res.errors.length > 0) {
              setBulkError(`Connected ${res.connected?.length || 0} provider(s); ${res.errors.map((e) => e.name).join(", ")} failed.`);
            }
          } else {
            setBulkError(res.error || "Could not connect detected environment variables.");
          }
        } catch {
          setBulkError("Network error while connecting environment variables.");
        }
        setBusyAll(false);
      };
      return h(
        "div",
        { className: "dshd-local" },
        h(
          "div",
          { key: "h", className: "dshd-local-head" },
          h("h3", null, "Direct API Keys & Custom Gateways"),
          unconfiguredEnvCount > 0
            ? h(
                "button",
                {
                  type: "button",
                  className: "dshd-btn dshd-btn-primary dshd-copy",
                  disabled: busyAll,
                  onClick: () => void connectAllEnv(),
                },
                busyAll
                  ? "Connecting…"
                  : `Connect all detected ($ENV · ${unconfiguredEnvCount})`,
              )
            : null,
        ),
        bulkError ? h("div", { key: "bulk-err", className: "dshd-err", role: "alert", style: { margin: "0 0 12px 0" } }, bulkError) : null,
        h(
          "p",
          { key: "p", className: "dshd-local-intro" },
          "Bring your own API key for any frontier or open-weights provider, connect detected environment variables in one click, or attach any OpenAI-compatible inference server.",
        ),
        providers.length > 0
          ? h(
              "div",
              { key: "grid", className: "dshd-direct-grid" },
              providers.map((item) =>
                h(DirectProviderCard, { key: item.id, item, onMutate: setDirect }),
              ),
            )
          : null,
        h(CustomGatewayCard, { key: "gw", gateway: direct?.gateway, onMutate: setDirect }),
      );
    }

    function AccountsSection() {
      ensureStyle();
      const { accounts, loaded, live, outcomes, streamLost, retry } = useAuthState();

      return h(
        "div",
        { className: "dshd-acc" },
        h("h2", { key: "h", className: "dshd-acc-title" }, "Accounts"),
        h(
          "p",
          { key: "intro", className: "dshd-acc-intro" },
          "Sign in with a subscription you already pay for. Sign-in opens in your real browser; "
            + "credentials are stored on this Mac. Models appear in the picker automatically.",
        ),
        // A dead stream after the first state is a staleness problem, not a
        // blank-screen one: the cards are real, they just stopped updating.
        loaded && streamLost ? h(StreamLost, { key: "stale", retry, stale: true }) : null,
        // Skeletons only while there is still reason to expect state. Once the
        // retries are spent they are a lie — the wait is over and it failed.
        !loaded
          ? streamLost
            ? h(StreamLost, { key: "lost", retry })
            : h("div", { key: "skel", className: "dshd-grid" },
                h("div", { key: "s1", className: "dshd-skel" }),
                h("div", { key: "s2", className: "dshd-skel" }),
                h("div", { key: "s3", className: "dshd-skel" }),
                h("div", { key: "s4", className: "dshd-skel" }))
          : accounts.length === 0
            ? h("p", { key: "empty", className: "dshd-empty" }, "No sign-in providers are available in this build.")
            : h("div", { key: "grid", className: "dshd-grid" },
                [...accounts].sort(byProminence).map((account) =>
                  h(Card, {
                    key: account.key,
                    account,
                    live: live[account.key],
                    outcome: outcomes[account.key],
                  }),
                ),
                h(OpenCodeZenCard, { key: "opencode-zen" })),
        h(DirectProvidersSection, { key: "direct" }),
        h(ModelCatalogSection, { key: "catalog" }),
        h(LocalModelsSection, { key: "local" }),
      );
    }

    /**
     * How long the onboarding step waits for account state before standing aside.
     * Sits at the far end of the stream's own retry budget, so a stream that does
     * recover still gets to show the step.
     */
    const STALLED_STEP_MS = 8000;
    const ONBOARDING_KEY = "dshd.accounts.onboarding-dismissed";
    let dismissedThisRenderer = false;
    function onboardingDismissed() {
      if (dismissedThisRenderer) return true;
      try { return window.localStorage.getItem(ONBOARDING_KEY) === "1"; } catch { return false; }
    }

    /**
     * First-run step: lead with the subscription sign-ins, since that is the
     * point of this build, and keep the API-key route one click away.
     *
     * Wrapped in the host's own Modal primitive — the raw div rendered inside
     * the 256px sidebar foot (the onboarding slot's DOM home), crushing the
     * session list. The stock steps escape the same way.
     *
     * The shell renders the first `settings.onboarding` occupant whose id is not
     * yet completed. Registered after the durable welcome notice (-100), before
     * the stock DeepSeek API-key dialog (0). Once setup is dismissed or an account
     * is connected, keep this step parked without rendering a modal: completing
     * it would immediately ask for a DeepSeek key, contradicting the user's choice
     * to skip or configure another provider. Settings remains available normally.
     */
    function ConnectAccountStep({ complete, openSection }) {
      ensureStyle();
      const [dismissed, setDismissed] = useState(onboardingDismissed);
      const { accounts } = useAuthState(!dismissed);
      const [started, setStarted] = useState(false);
      const [signInError, setSignInError] = useState("");
      const dismiss = () => {
        dismissedThisRenderer = true;
        try { window.localStorage.setItem(ONBOARDING_KEY, "1"); } catch { /* retain this renderer's choice */ }
        setDismissed(true);
      };

      const offerable = accounts.filter((a) => a.methods.some((m) => m.id === "oauth"));
      const anyConnected = accounts.some((a) => a.configured);
      useEffect(() => {
        if (!dismissed && accounts.length > 0 && offerable.length === 0 && !anyConnected) complete();
      }, [dismissed, accounts.length, offerable.length, anyConnected, complete]);

      // Nothing to render until the stream delivers state — but rendering null
      // without completing is exactly how this step blocks every later one, and
      // a stream that never arrives would do that forever. Held in a ref because
      // `complete` is the shell's, and an unstable identity would restart the
      // clock on every render instead of ever reaching the end of it.
      const completeRef = useRef(complete);
      completeRef.current = complete;
      useEffect(() => {
        if (dismissed || accounts.length > 0) return undefined;
        const timer = setTimeout(() => completeRef.current(), STALLED_STEP_MS);
        return () => clearTimeout(timer);
      }, [dismissed, accounts.length]);

      if (dismissed || accounts.length === 0 || anyConnected) return null;
      if (offerable.length === 0) return null;

      const signIn = async (provider) => {
        setStarted(true);
        setSignInError("");
        const result = await post("begin", { provider, method: "oauth" });
        if (!result.ok) {
          // A failed begin must not burn the one-shot onboarding step: stay put,
          // re-enable the buttons and show the failure in the visible dialog.
          setStarted(false);
          setSignInError(typeof result.error === "string" && result.error
            ? result.error : "Could not start sign-in. Try again or connect an account in Settings.");
          return;
        }
        // Hand the user straight to the panel that shows the live prompts.
        dismiss();
        openSection("accounts");
      };

      const featured = [...offerable].sort(byProminence).slice(0, 2);

      const body = h(
        "div",
        { className: "dshd-onb" },
        h("h2", { key: "t" }, "Connect an account to get started"),
        signInError ? h("p", { role: "alert", className: "dshd-err" }, signInError) : null,
        h(
          "div",
          { key: "b", className: "dshd-onb-body" },
          h(
            "p",
            { key: "d", className: "dshd-acc-intro" },
            "Sign in with a subscription you already pay for. Sign-in opens in your real browser.",
          ),
          h(
            "div",
            { key: "a", className: "dshd-actions" },
            featured.map((account) =>
              h(
                "button",
                {
                  key: account.key,
                  type: "button",
                  className: "dshd-btn dshd-btn-primary",
                  disabled: started,
                  onClick: () => void signIn(account.provider),
                },
                h(ProviderMark, { key: "m", provider: account.provider, size: 16 }),
                h("span", { key: "t" }, present(account).verb),
              ),
            ),
          ),
        ),
        h(
          "p",
          { key: "attr", className: "dshd-hint", style: { marginTop: "18px" } },
          "Enhanced desktop client built on DeepSeek Harness. Not affiliated with, "
            + "endorsed by, or an official release of DeepSeek or DeepSeek Harness.",
        ),
        h(
          "div",
          { key: "s", className: "dshd-onb-actions" },
          h(
            "button",
            {
              key: "key",
              type: "button",
              className: "dshd-btn dshd-btn-outline",
              disabled: started,
              onClick: () => { dismiss(); openSection("models"); },
            },
            "Use an API key instead",
          ),
          h(
            "button",
            { key: "skip", type: "button", className: "dshd-btn dshd-btn-quiet", disabled: started, onClick: dismiss },
            "Skip for now",
          ),
        ),
        h("p", { className: "dshd-hint" }, "You can connect accounts or configure models later in Settings."),
      );

      // Without the Modal primitive (an upstream bump could move it) the step
      // still works — just inline rather than floating.
      if (!P.Modal) return body;
      return h(P.Modal, { open: true, headless: true, onClose: () => {} }, body);
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "accounts", order: 5, label: () => "Accounts" },
          AccountsSection,
        ),
      );
      ctx.slots.inject("settings.onboarding", () =>
        ctx.slots.register(
          { name: "settings.onboarding", id: "connect-account", order: -50 },
          ConnectAccountStep,
        ),
      );
    }

    exports.AccountUsage = AccountUsage;
    exports.DirectProvidersSection = DirectProvidersSection;
    exports.UsageBar = UsageBar;
    exports.quotaRows = quotaRows;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
