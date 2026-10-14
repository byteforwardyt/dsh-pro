/**
 * Byte Forward subscribe action — browser half.
 *
 * Written directly in the client module-table format rather than compiled: the
 * plugin has one component and no JSX, so a bundler would add a build step
 * without changing the output. `require` here is the shell's synchronous module
 * table, which supplies the baseline externals (React, slots, primitives).
 *
 * Occupies `sidebar.footer.action` — a `list` slot in the sidebar foot, declared
 * by @deepseek-ai/dsh-client-ui-sidebar and rendered beside the settings control.
 * The slot hands occupants a `wide` flag reflecting sidebar expansion.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-byteforward",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useRef } = React;

    const CHANNEL_URL =
      "https://www.youtube.com/channel/UCGGHPOAzUaKsSc2yjsOeAFQ?sub_confirmation=1";

    const STYLE_ID = "dshd-byteforward-style";

    /**
     * Presented as a sibling row to the Settings control directly below it: same
     * icon gutter, same label offset, same hover treatment. The handle stays
     * visible rather than hiding behind a hover, because a channel handle is the
     * point of the control. On the collapsed rail (`wide === false`) the label is
     * dropped so the icon still fits.
     *
     * Styles are injected once — a hand-written bundle has no CSS-module pipeline.
     */
    // Measured against the Settings trigger it sits above, so the two read as one
    // set: 42px tall, 0/10/0/8 padding, 8px gap, 12px radius, 14px/400 type, and a
    // 16px icon. The trigger is 4px wider than the foot column and inset -2px, so
    // the row reproduces that overhang to keep both left edges on the same line.
    // Token colours at full strength — the earlier opacity dimming also dimmed
    // the YouTube red and made the row read greyer than the Settings control it
    // sits above. Hover uses the same token as that control, and the collapsed
    // rail gets the host's own 36px circle treatment.
    const STYLE = [
      ".dshd-yt{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;",
      "box-sizing:border-box;width:42px;height:42px;border-radius:12px;text-decoration:none;",
      "color:var(--dsw-alias-label-primary,#f9fafb);",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease);",
      "-webkit-app-region:no-drag}",
      ".dshd-yt:hover,.dshd-yt:focus-visible{",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-yt:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);",
      "outline-offset:2px}",
      ".dshd-yt-icon{display:inline-flex;flex:0 0 auto;width:18px;height:18px;",
      "align-items:center;justify-content:center;overflow:visible}",
      "@media (prefers-reduced-motion:reduce){.dshd-yt{transition:none}}",
    ].join("");

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = STYLE;
      document.head.appendChild(el);
    }

    /** The YouTube glyph, drawn inline so the bundle pulls in no asset. */
    function PlayMark() {
      return React.createElement(
        "svg",
        { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": "true", focusable: "false" },
        React.createElement("rect", { x: 1, y: 4, width: 22, height: 16, rx: 5, fill: "#ff0033" }),
        React.createElement("path", { d: "m10 8 6 4-6 4Z", fill: "#fff" }),
      );
    }

    /**
     * `target="_blank"` is deliberate: the Electron main process intercepts window
     * opens and hands allowlisted hosts to the user's real browser, so the link
     * never navigates the app window. `sub_confirmation=1` makes YouTube present
     * the subscribe dialog directly.
     */
    function SubscribeAction() {
      ensureStyle();
      // Icon-only, sized to sit beside the Settings control as a peer button
      // (chrome.cjs lays the two out on one row). The channel handle and the
      // full pitch live on the About tab.
      return React.createElement(
        "a",
        {
          className: "dshd-yt",
          href: CHANNEL_URL,
          target: "_blank",
          rel: "noreferrer noopener",
          title: "Subscribe to Byte Forward on YouTube",
          "aria-label": "Subscribe to Byte Forward on YouTube",
        },
        React.createElement("span", { key: "i", className: "dshd-yt-icon" }, React.createElement(PlayMark)),
      );
    }

    const ABOUT_CSS = [
      // 720/12 and a tertiary secondary-text token match the geometry of the
      // sibling Accounts section (client-ui-accounts/lib/client.js: .dshd-acc /
      // .dshd-acc-intro) so the two settings panels read as one author.
      ".dshd-about{display:flex;flex-direction:column;gap:12px;max-width:720px}",
      ".dshd-about h2{font:var(--dsw-font-base-strong-16,500 16px/24px sans-serif);margin:0;",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-about p{font:var(--dsw-font-s-14,14px/22px sans-serif);margin:0;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      // Version identity: a selectable, copy-pasteable line so a bug report can
      // quote a build number instead of "it's broken on my Mac".
      ".dshd-about-version{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshd-about-version-text{font:var(--dsw-font-markdown-code-block,13px/22px monospace);",
      "padding:6px 10px;border-radius:8px;user-select:all;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-about-copy{display:inline-flex;align-items:center;justify-content:center;",
      "height:28px;padding:0 10px;border-radius:14px;cursor:pointer;white-space:nowrap;",
      "font:var(--dsw-font-xxs-12,12px/18px sans-serif);",
      "color:var(--dsw-alias-label-primary,#f9fafb);background:transparent;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-about-copy:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-about-copy:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);",
      "outline-offset:2px}",
      ".dshd-about-card{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "background:var(--dsw-alias-bg-layer-3,#353638)}",
      ".dshd-about-yt{display:inline-flex;align-items:center;justify-content:center;",
      "width:40px;height:40px;flex:0 0 auto;border-radius:10px;",
      "background:color-mix(in srgb,#ff0033 14%,transparent)}",
      ".dshd-about-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
      ".dshd-about-name{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-about-handle{font:var(--dsw-font-xxs-12,12px/18px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-about-sub{display:inline-flex;align-items:center;justify-content:center;height:36px;",
      "padding:0 16px;border-radius:18px;text-decoration:none;font:var(--dsw-font-s-14,14px/22px sans-serif);",
      "background:var(--dsw-alias-button-primary-fill,#f9fafb);",
      "color:var(--dsw-alias-label-primary-foreground,#0f1115);",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-about-sub:hover{background:var(--dsw-alias-button-primary-hover,#ebeef2)}",
      ".dshd-about-sub:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);",
      "outline-offset:2px}",
      ".dshd-about-legal{display:flex;gap:8px;flex-wrap:wrap}",
      // Geometry matched to client-ui-accounts' .dshd-btn/.dshd-btn-outline (36px
      // pill, 1px border-l2, same hover token) so this row and the Accounts
      // section's buttons stop looking like different authors.
      ".dshd-about-legal button{font:var(--dsw-font-s-14,14px/22px sans-serif);height:36px;",
      "padding:0 14px;border-radius:18px;cursor:pointer;white-space:nowrap;",
      "color:var(--dsw-alias-label-primary,#f9fafb);background:transparent;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-about-legal button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-about-legal button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);",
      "outline-offset:2px}",
      ".dshd-about-meta{font:var(--dsw-font-xxs-12,12px/18px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      "@media (prefers-reduced-motion:reduce){",
      ".dshd-about-sub,.dshd-about-legal button,.dshd-about-copy{transition:none}}",
    ].join("");
    const ABOUT_STYLE_ID = "dshd-about-style";
    function ensureAboutStyle() {
      if (typeof document === "undefined" || document.getElementById(ABOUT_STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = ABOUT_STYLE_ID;
      el.textContent = ABOUT_CSS;
      document.head.appendChild(el);
    }

    /** Raw `process.platform` values presented the way a person actually reads them. */
    const FRIENDLY_PLATFORM = { darwin: "macOS", win32: "Windows", linux: "Linux" };

    /**
     * A compact, selectable, copyable line stating exactly which build is
     * running, so a user reporting a problem can quote it instead of digging
     * through Finder or guessing. The preload bridge exposes version, platform,
     * arch, the harness version and the Electron version — all identity, none
     * sensitive — so all of them go here; arch especially matters, since an
     * arm64/x64 mismatch is a common source of native-module failures.
     *
     * Rendered only in the desktop app: on a plain browser tab there is no
     * bridge to read, and blank fields are worse than no block at all.
     */
    function VersionMeta() {
      const bridge = typeof window !== "undefined" ? window.__DSH_DESKTOP__ : null;
      const metaLine = bridge
        ? [
            bridge.version ? `Version ${bridge.version}` : "Version unknown",
            FRIENDLY_PLATFORM[bridge.platform] || bridge.platform || null,
            bridge.arch || null,
            bridge.harnessVersion ? `Harness ${bridge.harnessVersion}` : null,
            bridge.electronVersion ? `Electron ${bridge.electronVersion}` : null,
          ].filter(Boolean).join(" · ")
        : "";

      const [copied, setCopied] = useState(false);
      const timer = useRef(null);
      useEffect(() => () => clearTimeout(timer.current), []);
      const copy = useCallback(async () => {
        try {
          await navigator.clipboard.writeText(metaLine);
          setCopied(true);
          timer.current = setTimeout(() => setCopied(false), 1200);
        } catch {}
      }, [metaLine]);

      // Hooks above always run in the same order; only the render output is
      // skipped when there's no bridge, keeping this a legal early return.
      if (!bridge) return null;

      return React.createElement(
        "div",
        { className: "dshd-about-version" },
        React.createElement("span", { key: "v", className: "dshd-about-version-text" }, metaLine),
        React.createElement(
          "button",
          {
            key: "c",
            type: "button",
            className: "dshd-about-copy",
            onClick: copy,
            "aria-label": "Copy version info",
          },
          copied ? "Copied" : "Copy",
        ),
      );
    }

    /**
     * Buttons that open the notices shipped inside the bundle.
     *
     * Rendered only in the desktop app: on a plain browser tab there is no
     * bridge to open a local file, and a dead button is worse than no button.
     * The bridge takes a NAME, not a path — see shell/src/preload.cjs.
     */
    function LicenseButtons() {
      const bridge = typeof window !== "undefined" ? window.__DSH_DESKTOP__ : null;
      if (!bridge || typeof bridge.openNotice !== "function") return null;
      const open = (which) => { try { bridge.openNotice(which); } catch {} };
      return React.createElement(
        "div",
        { key: "legal", className: "dshd-about-legal" },
        React.createElement("button", {
          key: "l", type: "button", onClick: () => open("license"),
        }, "License"),
        React.createElement("button", {
          key: "t", type: "button", onClick: () => open("third-party"),
        }, "Third-party notices"),
      );
    }

    /**
     * The About page. Ordered what this is → which build → who made it → legal
     * notice: title, then the copyable version line, then the pitch, then the
     * Byte Forward card (demoted below both so it no longer dominates the
     * panel), then the notice buttons and the attribution footer.
     */
    function AboutSection() {
      ensureAboutStyle();
      return React.createElement(
        "div",
        { className: "dshd-about" },
        React.createElement("h2", { key: "t" }, "About DSH PRO"),
        React.createElement(VersionMeta, { key: "version" }),
        React.createElement(
          "p",
          { key: "p1" },
          "DSH PRO — Enhanced Desktop Edition. Made by Byte Forward. We wrapped "
            + "DeepSeek Harness into a desktop app so anyone can use it with a click — "
            + "not everyone loves the terminal, and the harness is worth more people "
            + "getting to try it.",
        ),
        React.createElement(
          "div",
          { key: "card", className: "dshd-about-card" },
          React.createElement("span", { key: "i", className: "dshd-about-yt" }, React.createElement(PlayMark)),
          React.createElement(
            "div",
            { key: "b", className: "dshd-about-body" },
            React.createElement("span", { key: "n", className: "dshd-about-name" }, "Byte Forward"),
            React.createElement("span", { key: "h", className: "dshd-about-handle" }, "@ByteForward on YouTube"),
          ),
          React.createElement(
            "a",
            {
              key: "s",
              className: "dshd-about-sub",
              href: CHANNEL_URL,
              target: "_blank",
              rel: "noreferrer noopener",
            },
            "Subscribe",
          ),
        ),
        LicenseButtons(),
        React.createElement(
          "p",
          { key: "attr", className: "dshd-about-meta" },
          "Enhanced desktop client built on DeepSeek Harness. Not affiliated with, "
            + "endorsed by, or an official release of DeepSeek or DeepSeek Harness. "
            + "DeepSeek Harness is MIT licensed. This app redistributes several "
            + "hundred open-source packages, one of which (libvips, via sharp) is "
            + "LGPL-3.0-or-later.",
        ),
      );
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    /**
     * Registration waits on the slot's declarer, so this package loads cleanly
     * whether its row activates before or after ui-sidebar.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      // The About page. Ordered last so it sits at the bottom of the settings nav.
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "about", order: 100, label: () => "About" },
          AboutSection,
        ),
      );
      ctx.slots.inject("sidebar.footer.action", function* () {
        // A `list` slot keys its occupants, so an id is required, not optional.
        // Ordered after the account indicator, immediately above Settings.
        yield ctx.slots.register(
          { name: "sidebar.footer.action", id: "byteforward", order: 0 },
          SubscribeAction,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
