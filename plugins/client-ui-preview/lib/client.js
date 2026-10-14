/**
 * Preview view — browser half.
 *
 * A real browser pane beside Chat and Trajectory, for previewing whatever the
 * agent is building. Two things an <iframe> cannot do forced the move to
 * Electron's <webview>:
 *   - navigation history (back/forward/reload as a user expects), and
 *   - script injection for the element picker, which is cross-origin from the
 *     app's own 127.0.0.1:<port> origin the moment the dev server is on a
 *     different port.
 *
 * The pane is a full browser: any http(s) address loads, and anything that is
 * not an address becomes a web search. The main process still constrains every
 * attachment — http(s) only, Node integration and custom preloads stripped, no
 * popup windows, no permission grants, no downloads. If webviewTag is ever
 * turned back off, this falls back to the iframe path automatically — degraded
 * to loopback-only by the window CSP, not broken.
 *
 * Device framing turns the same pane into an app preview: the viewport is sized
 * to a device profile so the user can check responsive work without leaving the
 * app.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-preview",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useRef, useCallback, useEffect } = React;
    const h = React.createElement;

    const STORAGE_KEY = "dshd.preview.url";
    const DEVICE_KEY = "dshd.preview.device";
    const ORIGIN_KEY = "dshd.preview.origin";
    const PAGE_KEY = "dshd.preview.page";
    // A preview belongs to the conversation that launched its game. The old
    // global key could restore another session's (often dead) Vite URL.
    const sessionKey = (key, sessionId) => sessionId ? key + ":" + encodeURIComponent(sessionId) : key;
    const DEFAULT_URL = "http://localhost:3000";
    const COMMON_PORTS = [3000, 5173, 4173, 8080, 4321, 5000, 8000];

    /** How often an empty pane re-scans for a dev server that started later. */
    const RESCAN_MS = 4000;

    /**
     * Bring the Preview tab forward when the agent points it somewhere.
     *
     * The view toolbar belongs to the host conversation shell and exposes no
     * activation API, so this reaches for the tab by its accessible name. That
     * is a soft dependency on purpose: if the markup changes, or the toolbar is
     * not on screen, nothing breaks — the host retains the intent and the pane
     * applies it as soon as it mounts. Switching tabs is a convenience on top
     * of a mechanism that is already correct without it.
     */
    function selectPreviewTab() {
      try {
        const tabs = document.querySelectorAll('[role="tab"]');
        for (const tab of tabs) {
          if ((tab.textContent || "").trim() !== "Preview") continue;
          if (tab.getAttribute("aria-selected") !== "true") tab.click();
          return;
        }
      } catch {}
    }

    /** Device profiles for app-preview framing. */
    const DEVICES = [
      { id: "responsive", label: "Responsive", width: null, height: null },
      { id: "phone", label: "iPhone", width: 390, height: 844 },
      { id: "tablet", label: "iPad", width: 834, height: 1112 },
      { id: "desktop", label: "Desktop", width: 1440, height: 900 },
    ];

    /** Does this build have <webview>? Decided once, at module scope. */
    const HAS_WEBVIEW = typeof document !== "undefined"
      && typeof document.createElement("webview").getWebContentsId === "function";

    const CSS = [
      ".dshd-pv{display:flex;flex-direction:column;flex:1 1 0%;height:auto;min-height:0;box-sizing:border-box;",
      "background:var(--dsw-alias-bg-base,#151517)}",
      ".dshd-pv-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:0 0 auto;",
      "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-pv-btn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;",
      "width:32px;height:32px;border:none;border-radius:8px;cursor:pointer;color:inherit;",
      "background:transparent;",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-pv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-pv-btn:disabled{opacity:.35;cursor:default}",
      ".dshd-pv-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}",
      ".dshd-pv-btn[aria-pressed=\"true\"]{background:var(--dsw-alias-state-business-primary,#679efe);color:#fff}",
      ".dshd-pv-form{flex:1 1 auto;display:flex;min-width:0}",
      ".dshd-pv-url{flex:1 1 auto;min-width:0;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "padding:6px 12px;border-radius:16px;color:inherit;",
      "border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f)}",
      ".dshd-pv-url:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#f9fafb)}",
      ".dshd-pv-select{flex:0 0 auto;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "padding:6px 10px;border-radius:16px;color:inherit;",
      "border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f)}",
      ".dshd-pv-body{flex:1 1 auto;position:relative;min-height:0;overflow:auto;",
      "display:flex;align-items:flex-start;justify-content:center}",
      ".dshd-pv-stage{flex:0 0 auto;background:#fff;position:relative}",
      ".dshd-pv-stage-fill{position:absolute;inset:0}",
      ".dshd-pv-frame{width:100%;height:100%;border:0;display:block;background:#fff}",
      // A <webview> is a custom element; without an explicit flex display it
      // collapses to its intrinsic size before the observer above runs.
      "webview.dshd-pv-frame{display:flex;flex:1 1 auto}",
      ".dshd-pv-empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:20px;",
      "align-items:center;justify-content:center;text-align:center;padding:40px;overflow:auto}",
      ".dshd-pv-find{display:flex;flex-direction:column;gap:6px;align-items:center;max-width:460px}",
      ".dshd-pv-refind{font:500 12px/18px sans-serif;padding:4px 12px;border-radius:14px;cursor:pointer;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:transparent;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8);margin-top:4px}",
      ".dshd-pv-refind:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-pv-chip.is-live{border-color:var(--dsw-alias-state-success,#3fb950)}",
      ".dshd-pv-chip{display:inline-flex;align-items:center;gap:6px}",
      ".dshd-pv-chip svg{width:13px;height:13px;opacity:.7}",
      ".dshd-pv-live-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;",
      "background:var(--dsw-alias-state-success,#3fb950)}",
      ".dshd-pv-empty h3{font:var(--dsw-font-base-strong-16,500 16px/24px sans-serif);margin:0;",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-pv-empty p{font:var(--dsw-font-s-14,14px/22px sans-serif);margin:0;max-width:440px;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-pv-chip{font:500 12px/18px sans-serif;padding:2px 8px;border-radius:6px;cursor:pointer;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:transparent;color:inherit}",
      ".dshd-pv-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-pv-chips{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:6px}",
      ".dshd-pv-pick{flex:0 0 auto;padding:10px 12px;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "color:var(--dsw-alias-label-secondary,#cfd3d6);display:flex;gap:8px;align-items:flex-start}",
      ".dshd-pv-pick code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f);padding:2px 6px;border-radius:6px;",
      "word-break:break-all}",
      ".dshd-pv-copy{margin-left:auto;flex:0 0 auto;height:26px;padding:0 10px;border-radius:13px;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));background:transparent;",
      "color:inherit;cursor:pointer;font-size:12px}",
      ".dshd-pv{color:var(--dsw-alias-label-primary,#f9fafb);container-type:inline-size;min-width:0}",
      // Chat-width drag handles are meaningless over a full-width browser and
      // otherwise intercept clicks on the server controls and game below.
      "body[data-dshd-view=preview] [data-width-handle]{display:none}",
      ".dshd-pv-bar{box-sizing:border-box;min-height:48px;padding:7px 12px;gap:6px;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1,#19191b)}",
      ".dshd-pv-url,.dshd-pv-select{border-radius:8px;background:var(--dsw-alias-bg-base,#151517)}",
      ".dshd-pv-form{min-width:180px}.dshd-pv-url,.dshd-pv-select{box-sizing:border-box;height:32px;font-size:13px;line-height:18px}",
      ".dshd-pv-status{display:flex;justify-content:space-between;gap:12px;padding:7px 14px;font:11px/18px ui-sans-serif,sans-serif;color:var(--dsw-alias-label-tertiary,#adb2b8);border-bottom:1px solid var(--dsw-alias-border-l1,#ffffff12)}",
      ".dshd-pv-status:empty{display:none}.dshd-pv-status button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}",
      ".dshd-pv-empty{background:var(--dsw-alias-bg-base,#151517);z-index:1}.dshd-pv-empty p{font-size:13px;line-height:1.7}",
      ".dshd-pv-canvas{flex-shrink:0;position:relative}.dshd-pv-stage{overflow:hidden;box-shadow:0 4px 24px #0002}",
      ".dshd-pv-sources{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;flex:none;height:32px;padding:0 10px;font:12px/18px sans-serif;background:transparent;color:inherit;border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:8px;cursor:pointer}",
      ".dshd-pv-sources[aria-expanded=true],.dshd-pv-sources[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-active,#ffffff12)}",
      ".dshd-pv-server-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#adb2b8)}.dshd-pv-server-dot[data-status=ready]{background:#49b979}.dshd-pv-server-dot[data-status=starting],.dshd-pv-server-dot[data-status=stopping]{background:#d6a547}.dshd-pv-server-dot[data-status=error]{background:#e87a86}",
      ".dshd-pv-server-panel{padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff20);flex:none;font:12px/18px sans-serif;max-height:40vh;overflow:auto;background:var(--dsw-alias-bg-layer-1,#19191b)}.dshd-pv-server-panel[hidden]{display:none}",
      ".dshd-pv-server-heading{font-weight:500}.dshd-pv-server-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-top:12px}.dshd-pv-server-field{display:flex;flex-direction:column;gap:6px;min-width:0;color:var(--dsw-alias-label-secondary,#cfd3d6)}",
      ".dshd-pv-server-field input{box-sizing:border-box;width:100%;min-width:0;height:32px;background:var(--dsw-alias-bg-base,#151517);border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:8px;padding:6px 10px;font:inherit;color:inherit}.dshd-pv-server-actions{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap}.dshd-pv-server-panel button{box-sizing:border-box;min-height:30px;padding:5px 10px;font:inherit;border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:8px;background:transparent;color:inherit;cursor:pointer}.dshd-pv-server-panel button:disabled{opacity:.4;cursor:default}.dshd-pv-server-panel p{margin:10px 0;color:var(--dsw-alias-label-secondary,#cfd3d6)}.dshd-pv-server-panel pre{max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}",
      ".dshd-pv :is(button,input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}",
      ".dshd-pv-pick{align-items:center}.dshd-pv-copy:last-child{margin-left:0}",
      "@container(max-width:650px){.dshd-pv-form{order:-1;flex-basis:100%}.dshd-pv-status{font-size:10px}.dshd-pv-empty{padding:20px}.dshd-pv-server-form{grid-template-columns:minmax(0,1fr)}}",
    ].join("");
    const STYLE_ID = "dshd-preview-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /**
     * Turn whatever was typed into something the pane can load — the address
     * bar of a real browser. Three cases, in order:
     *   1. an explicit http(s) URL loads as given;
     *   2. something host-shaped (a domain, an IP, localhost, host:port, with
     *      an optional path) gets a scheme — http for loopback, LAN IPs and
     *      .local names, whose servers rarely speak TLS; https for the web;
     *   3. everything else is a search.
     * Non-web schemes (file:, javascript:) fall through to search rather than
     * load — the main process would refuse them anyway; this just makes the
     * refusal legible instead of silent.
     */
    const SEARCH_URL = "https://www.google.com/search?q=";
    function normalizeAddress(raw) {
      const value = (raw || "").trim();
      if (!value) return null;
      if (/^https?:\/\//i.test(value)) {
        try { return new URL(value).toString(); } catch { return null; }
      }
      const hostish = !/\s/.test(value) && (
        /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?([/?#]|$)/i.test(value)   // a.b[:port][/…]
        || /^(localhost|\[[0-9a-f:]+\])(:\d+)?([/?#]|$)/i.test(value) // localhost, [::1]
      );
      if (hostish) {
        const plainHttp =
          /^(localhost|127\.0\.0\.1|\[::1\])([:/?#]|$)/i.test(value)
          || /^(\d{1,3}\.){3}\d{1,3}([:/?#]|$)/.test(value)
          || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local([:/?#]|$)/i.test(value);
        try { return new URL((plainHttp ? "http://" : "https://") + value).toString(); } catch { /* search */ }
      }
      return SEARCH_URL + encodeURIComponent(value);
    }

    /**
     * Injected into the previewed page to pick an element. Kept as a string
     * because it is evaluated inside the guest, not this bundle. It highlights
     * on hover, and on click posts back a stable description of the target.
     */
    const PICKER_SOURCE = `(() => {
      if (window.__dshdPicker) { window.__dshdPicker.stop(); }
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #679efe;background:rgba(103,158,254,.14);border-radius:3px;transition:all .05s';
      document.body.appendChild(box);
      const describe = (el) => {
        if (!el || el === document.body) return 'body';
        if (el.id) return '#' + CSS.escape(el.id);
        const cls = (el.className && typeof el.className === 'string')
          ? '.' + el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3).map(c => CSS.escape(c)).join('.') : '';
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        let nth = '';
        if (parent) {
          const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
          if (sameTag.length > 1) nth = ':nth-of-type(' + (sameTag.indexOf(el) + 1) + ')';
        }
        return tag + cls + nth;
      };
      const onMove = (e) => {
        const el = e.target;
        if (!el || !el.getBoundingClientRect) return;
        const r = el.getBoundingClientRect();
        box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
        box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
      };
      const onClick = (e) => {
        e.preventDefault(); e.stopPropagation();
        const el = e.target;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        window.__dshdPicker.stop();
        console.log('DSHD_PICK:' + JSON.stringify({
          selector: describe(el),
          tag: el.tagName.toLowerCase(),
          text: (el.textContent || '').trim().slice(0, 120),
          size: Math.round(r.width) + '×' + Math.round(r.height),
          color: cs.color, background: cs.backgroundColor,
          font: cs.fontSize + ' / ' + cs.fontWeight,
        }));
      };
      window.__dshdPicker = { stop() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        box.remove(); window.__dshdPicker = null;
      } };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
    })()`;

    function Icon({ d }) {
      return h("svg", { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none",
        stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round",
        "stroke-linejoin": "round", "aria-hidden": "true" }, h("path", { d }));
    }

    function workspacePreviewOrigin(value) {
      try {
        const url = new URL(value);
        return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
          && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
          ? url.origin : null;
      } catch { return null; }
    }

    /** Local preview servers die with the process that spawned them. A failed
     *  loopback address can fall back to workspace HTML; a public URL must not. */
    function isLoopbackPreviewUrl(value) {
      try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        return (url.protocol === "http:" || url.protocol === "https:")
          && (host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1")
          && !url.username && !url.password;
      } catch { return false; }
    }

    function savedPreview(sessionId) {
      try {
        const url = localStorage.getItem(sessionKey(STORAGE_KEY, sessionId)) || "";
        const origin = workspacePreviewOrigin(localStorage.getItem(sessionKey(ORIGIN_KEY, sessionId)));
        const page = localStorage.getItem(sessionKey(PAGE_KEY, sessionId)) || "";
        const managed = !!url && localStorage.getItem(sessionKey('dshd.preview.managed', sessionId)) === url;
        return { url, origin, page, managed, owned: Boolean(origin && new URL(url).origin === origin) };
      } catch { return { url: "", origin: null, page: "", owned: false }; }
    }

    async function resolveWorkspacePreview(page, signal) {
      const route = page ? "/dsh-files/preview/open?path=" + encodeURIComponent(page) : "/dsh-files/preview/probe";
      const response = await fetch(route, { credentials: "same-origin", signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not restore this workspace preview");
      const origin = workspacePreviewOrigin(result.previewOrigin);
      if (!origin) throw new Error("The workspace preview server is unavailable. Try again.");
      if (page && (!result.url || new URL(result.url).origin !== origin))
        throw new Error("The workspace preview returned an invalid address. Try again.");
      return { ...result, previewOrigin: origin };
    }

    function rebasePreview(url, origin) {
      const previous = new URL(url);
      // Concatenation keeps a pathname beginning with // on our origin, rather
      // than interpreting it as a protocol-relative external URL.
      return origin + previous.pathname + previous.search + previous.hash;
    }

    let panelAsset;
    function loadServerPanel() {
      if (!panelAsset) panelAsset = new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '/dsh-files/preview/panel.js';
        script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('Could not load preview server controls. Reopen Preview to retry.')); };
        document.head.appendChild(script);
      }).catch(error => { panelAsset = null; throw error; });
      return panelAsset;
    }

    function PreviewView({ standalone = false, active = true, sessionId, useSessions } = {}) {
      ensureStyle();
      // Which workspace this pane is previewing. A conversation is bound to one
      // folder, so an unscoped scan is what made Preview feel broken from chat:
      // with two workspaces open it offered pages from whichever one the walk
      // reached first, and the user opened a page belonging to a different
      // project. Files already binds this way; Preview now matches it.
      const sessionCwd = useSessions
        ? useSessions(state => sessionId ? state.byId[sessionId]?.cwd : undefined)
        : undefined;
      const urlKey = sessionKey(STORAGE_KEY, sessionId);
      const originKey = sessionKey(ORIGIN_KEY, sessionId);
      const pageKey = sessionKey(PAGE_KEY, sessionId);
      const [saved] = useState(() => savedPreview(sessionId));
      // Never mount a previous process's workspace port before the host has
      // resolved it. This also works in browsers, whose iframes cannot report
      // reliable navigation failures for the native did-fail-load recovery path.
      const [committed, setCommitted] = useState(saved.owned || saved.managed ? "" : saved.url);
      const [draft, setDraft] = useState(saved.url || DEFAULT_URL);
      const restoreTargetRef = useRef(saved.owned ? saved.url : "");
      const restoreAttemptRef = useRef(false);
      const [restoring, setRestoring] = useState(false);
      const [deviceId, setDeviceId] = useState(() => {
        try { return localStorage.getItem(DEVICE_KEY) || "responsive"; } catch { return "responsive"; }
      });
      const [nonce, setNonce] = useState(0);
      const [loading, setLoading] = useState(false);
      const [sourcesOpen, setSourcesOpen] = useState(false);
      const [serverOpen, setServerOpen] = useState(false);
      const [serverState, setServerState] = useState({ status: 'checking', error: '' });
      const serverButtonRef = useRef(null);
      const reportServerState = useCallback(next => setServerState(previous =>
        previous.status === next.status && previous.error === next.error ? previous : next), []);
      const seenIntentRef = useRef('');
      const [probeError, setProbeError] = useState("");
      const [copyStatus, setCopyStatus] = useState("");
      const [availableWidth, setAvailableWidth] = useState(0);
      const bodyRef = useRef(null);
      const navigationRef = useRef(0);
      const navigationRequestRef = useRef(null);
      const activeRef = useRef(active);
      useEffect(() => {
        if (standalone || typeof document === "undefined" || !document.body) return undefined;
        document.body.setAttribute("data-dshd-view", "preview");
        return () => {
          if (document.body.getAttribute?.("data-dshd-view") === "preview")
            document.body.removeAttribute("data-dshd-view");
        };
      }, [standalone]);
      const invalidateNavigation = useCallback(() => {
        navigationRef.current += 1;
        navigationRequestRef.current?.abort();
        navigationRequestRef.current = null;
        return navigationRef.current;
      }, []);
      const pageRef = useRef(saved.page);
      const knownOriginsRef = useRef(new Set(saved.origin ? [saved.origin] : []));
      const [picking, setPicking] = useState(false);
      const [picked, setPicked] = useState(null);
      const [canBack, setCanBack] = useState(false);
      const [canForward, setCanForward] = useState(false);
      // What the host found worth previewing: live dev-server ports, HTML files
      // the workspace holds, and the separate origin that renders those files.
      const [discovery, setDiscovery] = useState(null);
      // A main-frame load that failed ({url}). Rendered as an honest error
      // panel with the discovery chips — never a silent white pane.
      const [failed, setFailed] = useState(null);
      // One heal attempt per target, so a heal that itself fails cannot loop.
      const healTriedRef = useRef("");
      // A dead 127.0.0.1:<old-port> after restart is not a workspace origin we
      // own, so heal never runs. Fall back to the first workspace HTML page
      // once. Never steal a failed google.com (or any non-loopback) load.
      const fallbackTriedRef = useRef(false);
      const loopbackFailRef = useRef(false);
      const viewRef = useRef(null);
      const serverPanelRef = useRef(null);
      const [diagnostics, setDiagnostics] = useState([]);
      const addDiagnostic = useCallback(text => setDiagnostics(items => [...items.slice(-19), String(text).slice(0, 2000)]), []);
      const scanRef = useRef(0);
      const scanRequestRef = useRef(null);

      // Probe on mount and whenever the pane is shown empty again, so a server
      // the user just started, or a page the agent just wrote, appears without
      // a manual refresh.
      const probe = useCallback(() => {
        const scan = ++scanRef.current;
        scanRequestRef.current?.abort();
        const controller = new AbortController();
        scanRequestRef.current = controller;
        const query = sessionCwd ? "?root=" + encodeURIComponent(sessionCwd) : "";
        fetch("/dsh-files/preview/probe" + query, { credentials: "same-origin", signal: controller.signal })
          .then((r) => { if (!r.ok) throw new Error("Could not scan this workspace"); return r.json(); })
          .then((d) => {
            if (controller.signal.aborted || scan !== scanRef.current) return;
            scanRequestRef.current = null;
            setDiscovery(d); setProbeError("");
            if (d.previewOrigin) {
              knownOriginsRef.current.add(d.previewOrigin);
            }
          })
          .catch(() => {
            if (!controller.signal.aborted && scan === scanRef.current) setProbeError("Workspace scan unavailable. Enter an address or try scanning again.");
          })
          .finally(() => { if (scanRequestRef.current === controller) scanRequestRef.current = null; });
      }, [sessionCwd]);
      useEffect(() => {
        activeRef.current = active;
        if (active) probe();
        return () => {
          activeRef.current = false;
          restoreAttemptRef.current = false;
          scanRef.current += 1;
          scanRequestRef.current?.abort();
          scanRequestRef.current = null;
          invalidateNavigation();
        };
      }, [active, probe, invalidateNavigation]);

      const device = DEVICES.find((d) => d.id === deviceId) || DEVICES[0];

      // A ref mirror of `picking`, because the console listener is installed once
      // per commit and would otherwise close over a stale value.
      const pickingRef = useRef(false);
      useEffect(() => { pickingRef.current = picking; }, [picking]);
      const inputRef = useRef(null);

      const go = useCallback((raw) => {
        const url = normalizeAddress(raw);
        if (!url) return;
        restoreTargetRef.current = "";
        setRestoring(false);
        // Clear any prior failure, or the error panel keeps rendering (render
        // gates on `committed && !failed`) and the address bar and discovery
        // chips stay dead after a bad load — the pane wedged on the error.
        invalidateNavigation();
        setFailed(null); setSourcesOpen(false); setPicking(false); setLoading(true); setCopyStatus("");
        // Preserve the guest for ordinary navigation, so Back/Forward keep history.
        if (HAS_WEBVIEW && viewRef.current && url === committed) {
          Promise.resolve(viewRef.current.loadURL(url)).catch(() => {}); // did-fail-load owns errors
        } else if (!HAS_WEBVIEW || failed) setNonce((n) => n + 1);
        setCommitted(url); setDraft(url); setPicked(null);
        try { localStorage.setItem(urlKey, url); } catch {}
      }, [committed, failed, invalidateNavigation, urlKey]);

      const goRef = useRef(go);
      goRef.current = go;
      useEffect(() => {
        if (!sessionId || !active) return;
        let live = true, dispose;
        loadServerPanel().then(() => {
          if (live && serverPanelRef.current) dispose = window.DshPreviewPanel(serverPanelRef.current, sessionId, sessionCwd, url => goRef.current(url), reportServerState);
        }).catch(error => { if (live) reportServerState({ status: 'unavailable', error: error.message }); });
        return () => { live = false; dispose?.(); };
      }, [sessionId, sessionCwd, active, reportServerState]);
      useEffect(() => { setServerOpen(false); setServerState({ status: 'checking', error: '' }); }, [sessionId, sessionCwd]);

      // Open a workspace HTML file through the separate-origin preview server.
      // The page renders in its own opaque origin, so it cannot reach the app's
      // API — the point of serving it off a different port.
      const openWorkspacePage = useCallback(async (page) => {
        if (!activeRef.current) return;
        restoreTargetRef.current = "";
        setRestoring(false);
        const epoch = invalidateNavigation();
        const controller = new AbortController();
        navigationRequestRef.current = controller;
        setProbeError("");
        try {
          const result = await resolveWorkspacePreview(page.path, controller.signal);
          if (controller.signal.aborted || navigationRef.current !== epoch) return;
          knownOriginsRef.current.add(result.previewOrigin);
          pageRef.current = page.path;
          try { localStorage.setItem(originKey, result.previewOrigin); localStorage.setItem(pageKey, page.path); } catch {}
          go(result.url);
        } catch (error) {
          if (!controller.signal.aborted && navigationRef.current === epoch) setProbeError(error.message);
        } finally {
          if (navigationRequestRef.current === controller) navigationRequestRef.current = null;
        }
      }, [go, invalidateNavigation, originKey, pageKey]);

      const restoreSavedPreview = useCallback(async () => {
        const target = restoreTargetRef.current;
        if (!target || !activeRef.current) return;
        const epoch = invalidateNavigation();
        const controller = new AbortController();
        navigationRequestRef.current = controller;
        setRestoring(true); setFailed(null);
        try {
          const result = await resolveWorkspacePreview(pageRef.current, controller.signal);
          if (controller.signal.aborted || navigationRef.current !== epoch) return;
          knownOriginsRef.current.add(result.previewOrigin);
          try { localStorage.setItem(originKey, result.previewOrigin); } catch {}
          go(rebasePreview(target, result.previewOrigin));
        } catch (error) {
          if (!controller.signal.aborted && navigationRef.current === epoch) {
            setRestoring(false);
            setFailed({ url: target, workspace: true, message: error.message });
          }
        } finally {
          if (navigationRequestRef.current === controller) navigationRequestRef.current = null;
        }
      }, [go, invalidateNavigation, originKey]);
      useEffect(() => {
        if (active && restoreTargetRef.current && !restoreAttemptRef.current) {
          restoreAttemptRef.current = true;
          restoreSavedPreview();
        }
      }, [active, restoreSavedPreview]);

      // "Code me an HTML site" should not end at an empty pane and a chip. An
      // untouched Preview (nothing ever committed) opens the workspace's own
      // page the moment discovery finds one — no server, no click. Live dev
      // ports deliberately do NOT auto-open: a server that happens to be
      // running may be unrelated to this workspace.
      useEffect(() => {
        if (!active || saved.managed || scanRequestRef.current || navigationRequestRef.current || restoreTargetRef.current || committed || failed || !discovery) return;
        const first = discovery.entries && discovery.entries.find(page => !page.needsServer);
        if (first) openWorkspacePage(first);
      }, [active, discovery, committed, failed, openWorkspacePage]);

      // Saved Vite/preview URLs commit immediately and are not remapped on
      // mount — the server might still be up. If that loopback load then
      // fails, and the workspace has HTML, open it once instead of leaving
      // the pane on "Couldn't reach 127.0.0.1:4173".
      useEffect(() => {
        if (!active || fallbackTriedRef.current || !loopbackFailRef.current) return;
        if (!failed || failed.workspace) return;
        if (navigationRequestRef.current) return;
        const first = discovery && discovery.entries && discovery.entries.find(page => !page.needsServer);
        if (!first) return;
        fallbackTriedRef.current = true;
        openWorkspacePage(first);
      }, [active, failed, discovery, openWorkspacePage]);

      // A dev server usually starts AFTER the user opens Preview — they ask for
      // a site, watch it get built, and the server appears a minute later. A
      // scan that only runs on activation misses exactly that, leaving the pane
      // sitting on "no server found" while one is answering, and the only way
      // out was the "Scan again" button most people never look for.
      //
      // So the empty state rescans on a timer, and only the empty state: once a
      // page is showing there is nothing to discover and polling would be pure
      // background noise. It also stops the moment the tab is hidden.
      useEffect(() => {
        if (!active || committed) return undefined;
        const timer = setInterval(() => {
          if (!scanRequestRef.current && !navigationRequestRef.current) probe();
        }, RESCAN_MS);
        return () => clearInterval(timer);
      }, [active, committed, probe]);

      // What the agent asked to be shown. The host retains the last intent and
      // replays it on connect, so a target published while Preview was closed
      // still lands when the pane opens — the tool is most useful precisely
      // when the user is still reading chat rather than watching this tab.
      useEffect(() => {
        if (typeof EventSource !== "function") return undefined;
        let source;
        try { source = new EventSource("/dsh-files/preview/events?sessionId=" + encodeURIComponent(sessionId || '')); } catch { return undefined; }
        const onPreview = (event) => {
          let intent;
          try { intent = JSON.parse(event.data); } catch { return; }
          // Replay on reconnect must not re-navigate a pane the user has since
          // steered somewhere else, so each intent is acted on once.
          if (!intent || typeof intent.id !== "number" || (intent.sessionId || '') !== (sessionId || '')) return;
          const token = `${intent.at || ''}:${intent.id}`;
          const intentKey = sessionKey('dshd.preview.intent', sessionId);
          let savedIntent = '';
          try { savedIntent = localStorage.getItem(intentKey); } catch {}
          if (token === seenIntentRef.current || token === savedIntent) return;
          seenIntentRef.current = token;
          try { localStorage.setItem(intentKey, token); } catch {}
          if (intent.managed && intent.url) {
            try { localStorage.setItem(sessionKey('dshd.preview.managed', sessionId), intent.url); } catch {}
          }
          selectPreviewTab();
          activeRef.current = true;
          if (intent.kind === "url" && typeof intent.url === "string") go(intent.url);
          else if (intent.kind === "file" && typeof intent.path === "string") openWorkspacePage({ path: intent.path });
        };
        source.addEventListener("preview", onPreview);
        return () => { source.removeEventListener("preview", onPreview); source.close(); };
      }, [sessionId, go, openWorkspacePage]);

      // Wire webview navigation state + the picker's console channel.
      useEffect(() => {
        const el = viewRef.current;
        if (!el || !HAS_WEBVIEW) return undefined;
        let live = true;
        const onStart = () => { invalidateNavigation(); setLoading(true); setPicking(false); setPicked(null); };
        const onStop = () => setLoading(false);
        const sync = () => {
          try {
            setCanBack(el.canGoBack()); setCanForward(el.canGoForward());
            const current = el.getURL();
            // Only adopt the guest's url when the box is not being edited.
            // did-navigate-in-page fires on any SPA route change, and this
            // used to overwrite the controlled input mid-keystroke — the user
            // watched their half-typed address vanish.
            if (current && /^https?:\/\//.test(current)) {
              if (document.activeElement !== inputRef.current) setDraft(current);
              try { localStorage.setItem(urlKey, current); } catch {}
            }
          } catch {}
        };
        const onConsole = (e) => {
          if ((e.level === 3 || e.level === 'error') && e.message) addDiagnostic('Console: ' + e.message);
          if (!e.message || !e.message.startsWith("DSHD_PICK:")) return;
          // Only while a pick is actually in progress. Any page can write this
          // string to its own console; without the gate a previewed page could
          // stage arbitrary text behind the Copy selector button at a moment
          // the user never asked for a pick.
          if (!pickingRef.current) return;
          try {
            const result = JSON.parse(e.message.slice("DSHD_PICK:".length));
            if (result && typeof result.selector === "string" && result.selector.length <= 2000) {
              const clean = {};
              for (const key of ["selector", "tag", "size", "font", "text"]) clean[key] = typeof result[key] === "string" ? result[key].slice(0, 2000) : "";
              setPicked(clean); setCopyStatus("");
            }
          } catch {}
          setPicking(false);
        };
        // The workspace preview origin gets a NEW random port every launch, but
        // the last URL is persisted — so after a restart the remembered address
        // points at a dead port and the pane rendered as a silent white screen.
        // On a failed main-frame load of a loopback URL, re-probe and retry the
        // same path on the CURRENT preview origin; anything unhealable renders
        // the error panel with the discovery chips instead of white.
        const onFail = (e) => {
          if (e.isMainFrame === false) return;
          if (e.errorCode === -3) return; // ERR_ABORTED: rapid re-navigation, not a failure
          addDiagnostic('Load failed: ' + (e.errorDescription || e.errorCode) + ' · ' + (e.validatedURL || ''));
          setLoading(false); setPicking(false);
          const epoch = invalidateNavigation();
          const bad = e.validatedURL || el.getAttribute("src") || "";
          let owned = false;
          try { owned = knownOriginsRef.current.has(new URL(bad).origin); } catch {}
          // Only repair an origin previously advertised by our host. A random
          // high-port dev server belongs to the user and must never be hijacked.
          if (!owned || !activeRef.current) {
            if (activeRef.current) {
              if (isLoopbackPreviewUrl(bad)) loopbackFailRef.current = true;
              probe();
            }
            setFailed({ url: bad }); return;
          }
          const controller = new AbortController();
          navigationRequestRef.current = controller;
          resolveWorkspacePreview(pageRef.current, controller.signal)
            .then((d) => {
              if (!live || controller.signal.aborted || navigationRef.current !== epoch) return;
              if (d && d.entries) setDiscovery(d);
              const base = d.previewOrigin;
              const healedUrl = rebasePreview(bad, base);
              if (new URL(bad).origin !== base && healTriedRef.current !== healedUrl) {
                healTriedRef.current = healedUrl;
                knownOriginsRef.current.add(base);
                try { localStorage.setItem(originKey, base); } catch {}
                setFailed(null);
                setCommitted(healedUrl); setDraft(healedUrl); setNonce((n) => n + 1);
                try { localStorage.setItem(urlKey, healedUrl); } catch {}
              } else {
                setFailed({ url: bad });
              }
            })
            .catch(() => { if (live && !controller.signal.aborted && navigationRef.current === epoch) setFailed({ url: bad }); })
            .finally(() => { if (navigationRequestRef.current === controller) navigationRequestRef.current = null; });
        };
        const onNav = () => {
          setFailed(null);
          fallbackTriedRef.current = false;
          loopbackFailRef.current = false;
        };
        el.addEventListener("did-start-loading", onStart);
        el.addEventListener("did-stop-loading", onStop);
        el.addEventListener("did-navigate", sync);
        el.addEventListener("did-navigate", onNav);
        el.addEventListener("did-navigate-in-page", sync);
        el.addEventListener("dom-ready", sync);
        el.addEventListener("console-message", onConsole);
        el.addEventListener("did-fail-load", onFail);
        return () => {
          live = false;
          el.removeEventListener("did-start-loading", onStart);
          el.removeEventListener("did-stop-loading", onStop);
          el.removeEventListener("did-navigate", sync);
          el.removeEventListener("did-navigate", onNav);
          el.removeEventListener("did-navigate-in-page", sync);
          el.removeEventListener("dom-ready", sync);
          el.removeEventListener("console-message", onConsole);
          el.removeEventListener("did-fail-load", onFail);
        };
        // Failure recovery changes nonce and mounts a new guest, which needs
        // fresh listeners even when its URL is unchanged.
      }, [committed, nonce, invalidateNavigation, urlKey, originKey]);

      // A webview can fail before its effect-installed did-fail-load listener
      // attaches (notably a dev server that just exited). Never leave a white
      // game pane claiming to load forever; show retry and discovered sources.
      useEffect(() => {
        if (!active || !loading || !committed || !isLoopbackPreviewUrl(committed)) return undefined;
        const timer = setTimeout(() => {
          setLoading(false);
          setFailed({ url: committed, message: "The local game server did not finish loading. Restart it or choose another source." });
          probe();
        }, 20000);
        return () => clearTimeout(timer);
      }, [active, loading, committed, probe]);

      // Electron sizes a <webview>'s guest viewport from the element's own box.
      // When the element is attached mid-tab-transition the stage is still
      // collapsing, so the guest keeps that stale height and paints white below
      // its short body. Percentage heights do not fix it — the guest never sees
      // the later layout. Pin real pixels and restate them whenever the stage
      // resizes, which is the one thing that does propagate.
      useEffect(() => {
        const el = viewRef.current;
        if (!el || !HAS_WEBVIEW) return undefined;
        const host = el.parentElement;
        if (!host || typeof ResizeObserver !== "function") return undefined;
        const apply = () => {
          // clientWidth/Height stay unscaled when the device canvas fits the pane.
          if (host.clientWidth < 1 || host.clientHeight < 1) return;
          el.style.width = `${host.clientWidth}px`;
          el.style.height = `${host.clientHeight}px`;
        };
        apply();
        const ro = new ResizeObserver(apply);
        ro.observe(host);
        // The guest can attach after the first measurement; restate on ready.
        el.addEventListener("dom-ready", apply);
        return () => { ro.disconnect(); el.removeEventListener("dom-ready", apply); };
      }, [committed, nonce, deviceId]);

      useEffect(() => {
        const body = bodyRef.current;
        if (!body || typeof ResizeObserver !== "function") return;
        const measure = () => setAvailableWidth(body.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        return () => observer.disconnect();
      }, []);

      const closeSources = useCallback(() => {
        invalidateNavigation();
        setRestoring(false);
        setSourcesOpen(false);
      }, [invalidateNavigation]);
      const back = useCallback(() => { closeSources(); try { viewRef.current?.goBack(); } catch {} }, [closeSources]);
      const forward = useCallback(() => { closeSources(); try { viewRef.current?.goForward(); } catch {} }, [closeSources]);
      const reload = useCallback(() => {
        if (restoreTargetRef.current) { setSourcesOpen(false); restoreSavedPreview(); return; }
        closeSources();
        // Only take the webview's own reload path when a webview is actually
        // mounted. On the error panel it is unmounted, so viewRef.current is
        // null and `?.reload()` silently no-ops — the old code still `return`ed,
        // making Reload dead exactly when the user needs it. Fall through to a
        // remount: clear the failure and bump the nonce so the view rebuilds.
        if (HAS_WEBVIEW && viewRef.current) { try { viewRef.current.reload(); return; } catch {} }
        setFailed(null);
        setNonce((n) => n + 1);
      }, [closeSources, restoreSavedPreview]);
      const openExternal = useCallback(() => {
        // The guest's live url, not the committed one. sync() adopts navigation
        // into `draft` (the address bar) but never into `committed`, so after
        // navigating to /settings inside the pane the bar correctly read
        // /settings while this button opened / in the system browser.
        let target = committed;
        if (HAS_WEBVIEW) {
          try { target = viewRef.current?.getURL() || committed; } catch { /* keep committed */ }
        }
        if (target) window.open(target, "_blank", "noreferrer");
      }, [committed]);

      const togglePick = useCallback(() => {
        const el = viewRef.current;
        if (!el || !HAS_WEBVIEW) return;
        if (picking) {
          try { Promise.resolve(el.executeJavaScript("window.__dshdPicker && window.__dshdPicker.stop()")).catch(() => {}); } catch {}
          setPicking(false);
          return;
        }
        // executeJavaScript returns a promise; a page whose document.body is
        // null (a top-level SVG, say) rejects it. Without the catch that was an
        // unhandled rejection, and picking stayed true for a pick that never
        // armed — one wasted click and a console error.
        try {
          el.executeJavaScript(PICKER_SOURCE)
            .then(() => setPicking(true))
            .catch(() => setPicking(false));
        } catch { setPicking(false); }
      }, [picking]);

      const chooseDevice = useCallback((id) => {
        setDeviceId(id);
        try { localStorage.setItem(DEVICE_KEY, id); } catch {}
      }, []);

      // Iframe fallback (no <webview>) has no reload(), so a nonce cache-buster
      // stands in. Insert it BEFORE any #fragment — appended after the hash it
      // becomes part of the fragment and corrupts hash-routed URLs.
      const bust = (u) => {
        const hash = u.indexOf("#");
        const base = hash === -1 ? u : u.slice(0, hash);
        const frag = hash === -1 ? "" : u.slice(hash);
        return `${base}${base.includes("?") ? "&" : "?"}__dshd=${nonce}${frag}`;
      };
      const src = committed
        ? (HAS_WEBVIEW ? committed : bust(committed))
        : "";

      const scale = device.width && availableWidth ? Math.min(1, Math.max(1, availableWidth - 32) / device.width) : 1;
      const stageStyle = device.width
        ? { width: `${device.width}px`, height: `${device.height}px`, transform: `scale(${scale})`, transformOrigin: "top left" }
        : null;

      // allowpopups must be PRESENT: without it Chromium swallows window.open
      // and target=_blank before the main process ever sees them. No popup
      // window results either way — the main-process handler denies the window
      // and navigates this same pane to the URL instead.
      const frame = HAS_WEBVIEW
        ? h("webview", { ref: viewRef, className: "dshd-pv-frame", src, key: `wv-${nonce}`,
            allowpopups: "", partition: sessionKey('persist:dshd-preview', sessionId) })
        : h("iframe", { className: "dshd-pv-frame", src, title: "Preview", key: `if-${nonce}`,
            sandbox: "allow-scripts allow-forms allow-same-origin allow-popups", onLoad: () => setLoading(false) });

      return h(
        "div",
        { className: "dshd-pv" },
        h(
          "div",
          { key: "bar", className: "dshd-pv-bar" },
          h("button", { key: "b", type: "button", className: "dshd-pv-btn", title: "Back",
            "aria-label": "Back", disabled: !canBack, onClick: back },
            h(Icon, { d: "M15 18l-6-6 6-6" })),
          h("button", { key: "f", type: "button", className: "dshd-pv-btn", title: "Forward",
            "aria-label": "Forward", disabled: !canForward, onClick: forward },
            h(Icon, { d: "M9 18l6-6-6-6" })),
          h("button", { key: "r", type: "button", className: "dshd-pv-btn", title: "Reload",
            "aria-label": "Reload", disabled: !committed && !restoreTargetRef.current, onClick: reload },
            h(Icon, { d: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15" })),
          h("form", { key: "form", className: "dshd-pv-form",
            onSubmit: (e) => { e.preventDefault(); go(draft); } },
            h("input", { ref: inputRef, className: "dshd-pv-url", value: draft, spellCheck: false,
              autoComplete: "off", placeholder: "Search or enter an address",
              "aria-label": "Address or search", onChange: (e) => setDraft(e.target.value) })),
          h("button", { type: "button", className: "dshd-pv-sources", "aria-pressed": sourcesOpen,
            onClick: () => { if (sourcesOpen) closeSources(); else { setSourcesOpen(true); probe(); } } }, "Sources"),
          sessionId ? h('button', { type: 'button', ref: serverButtonRef, className: 'dshd-pv-sources',
            'aria-label': 'Preview server', 'aria-expanded': serverOpen,
            'aria-controls': 'dshd-preview-server-' + encodeURIComponent(sessionId),
            title: 'This chat’s managed development server: ' + serverState.status,
            onClick: () => setServerOpen(value => !value) },
            h('span', { className: 'dshd-pv-server-dot', 'aria-hidden': true, 'data-status': serverState.error ? 'error' : serverState.status }), 'Server') : null,
          h("select", { key: "d", className: "dshd-pv-select", value: deviceId,
            title: device.width ? `${device.width} × ${device.height} · ${Math.round(scale * 100)}% fit` : 'Fit preview to the available space',
            "aria-label": "Device size", onChange: (e) => chooseDevice(e.target.value) },
            DEVICES.map((d) => h("option", { key: d.id, value: d.id }, d.label))),
          HAS_WEBVIEW
            ? h("button", { key: "p", type: "button", className: "dshd-pv-btn",
                title: "Select an element", "aria-label": "Select an element",
                "aria-pressed": String(picking), disabled: !committed || Boolean(failed) || loading, onClick: togglePick },
                h(Icon, { d: "M3 3l7.5 18 2.5-7.5L20.5 11z" }))
            : null,
          h("button", { key: "o", type: "button", className: "dshd-pv-btn",
            title: "Open in your browser", "aria-label": "Open in your browser",
            disabled: !committed, onClick: openExternal },
            h(Icon, { d: "M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" })),
        ),
        h("div", { className: "dshd-pv-status", role: "status", "aria-live": "polite" },
          serverState.error && serverState.status === 'unavailable' && serverOpen ? serverState.error :
          serverState.error && !serverOpen ? h('button', { type: 'button', onClick: () => setServerOpen(true) }, 'Server needs attention — view details') :
          restoring ? 'Restoring workspace preview…' : loading ? 'Loading preview…' : picking ? 'Click an element to inspect it' : failed ? 'Preview unavailable' : null),
        sessionId ? h('div', { key: 'server-panel', ref: serverPanelRef, className: 'dshd-pv-server-panel', hidden: !serverOpen,
          id: 'dshd-preview-server-' + encodeURIComponent(sessionId), role: 'region', 'aria-label': 'Preview server settings',
          onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); setServerOpen(false); serverButtonRef.current?.focus(); } } }) : null,
        diagnostics.length ? h('details', { style: { padding: '6px 16px', flex: 'none', maxHeight: '180px', overflow: 'auto' } },
          h('summary', null, `Preview errors (${diagnostics.length})`),
          h('pre', { style: { whiteSpace: 'pre-wrap', userSelect: 'text' } }, diagnostics.join('\n')),
          h('button', { type: 'button', onClick: () => {
            navigator.clipboard.writeText(diagnostics.join('\n')).then(() => setCopyStatus('Errors copied'), () => setCopyStatus('Copy failed'));
          } }, copyStatus || 'Copy errors'),
          h('button', { type: 'button', onClick: () => setDiagnostics([]) }, 'Clear errors')) : null,
        h(
          "div",
          { key: "body", ref: bodyRef, className: "dshd-pv-body" },
          committed && !failed
            ? h("div", { className: "dshd-pv-canvas", style: { ...(device.width
                ? { width: device.width * scale, height: device.height * scale, margin: 16 }
                : { position: "absolute", inset: 0 }), ...(sourcesOpen ? { visibility: 'hidden', pointerEvents: 'none' } : {}) } },
                h("div", { className: "dshd-pv-stage" + (device.width ? "" : " dshd-pv-stage-fill"), style: stageStyle || undefined }, frame)) : null,
          (!committed || failed || sourcesOpen) ? h("div", { className: "dshd-pv-empty" },
                (() => {
                  const livePorts = (discovery && discovery.ports) || [];
                  const allPages = (discovery && discovery.entries) || [];
                  const pages = allPages.filter(page => !page.needsServer);
                  const serverProjects = allPages.filter(page => page.needsServer);
                  const hasPreviewOrigin = Boolean(discovery && discovery.previewOrigin);
                  const parts = [];
                  if (sourcesOpen && committed && !failed) parts.push(h("button", { key: "close", type: "button", className: "dshd-pv-refind", onClick: closeSources }, "Back to preview"));
                  if (probeError) parts.push(h("p", { key: "probe-error", role: "alert" }, probeError));

                  // A failed load leads, with a retry — the discovery sections
                  // below then offer everything that IS reachable.
                  if (failed) {
                    let where = failed.url;
                    try { where = new URL(failed.url).host; } catch {}
                    parts.push(h("div", { key: "failed", className: "dshd-pv-find" },
                      h("h3", null, failed.workspace ? "Workspace preview unavailable" : `Couldn't reach ${where}`),
                      failed.message ? h("p", null, failed.message) : null,
                      h("p", null, failed.workspace ? "Reopen the workspace and try again, or choose another source below." : "Check that your dev server is running, then retry. You can also choose another source below."),
                      h("div", { className: "dshd-pv-chips" },
                        h("button", { type: "button", className: "dshd-pv-chip",
                          onClick: reload },
                          "Try again"))));
                  }

                  // Live dev servers the host actually found answering.
                  if (livePorts.length > 0) {
                    parts.push(h("div", { key: "live", className: "dshd-pv-find" },
                      h("h3", null, "Other local servers (not linked to this chat)"),
                      h("p", null, "Found a server answering on "
                        + (livePorts.length === 1 ? "this port" : "these ports") + ". Open it here."),
                      h("div", { className: "dshd-pv-chips" },
                        livePorts.map((port) =>
                          h("button", { key: port, type: "button", className: "dshd-pv-chip is-live",
                            onClick: () => go(`http://127.0.0.1:${port}`) },
                            h("i", { className: "dshd-pv-live-dot" }), `127.0.0.1:${port}`)))));
                  }

                  // Built-but-unserved HTML the agent may have written to disk.
                  if (pages.length > 0 && hasPreviewOrigin) {
                    parts.push(h("div", { key: "pages", className: "dshd-pv-find" },
                      h("h3", null, pages.length === 1 ? "A page in your workspace" : "Pages in your workspace"),
                      h("p", null, "Static HTML found on disk. No server needed — open it straight from the workspace."),
                      h("div", { className: "dshd-pv-chips" },
                        pages.slice(0, 8).map((page) =>
                          h("button", { key: page.path, type: "button", className: "dshd-pv-chip",
                            title: page.rel || page.name,
                            onClick: () => openWorkspacePage(page) },
                            h(Icon, { d: "M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9zM13 2v7h7" }),
                            page.rel || page.name)))));
                  }

                  if (serverProjects.length > 0) {
                    parts.push(h("div", { key: "server-projects", className: "dshd-pv-find" },
                      h("h3", null, "This project may need its dev server"),
                      h("p", null, "Start the project's dev command in Terminal, then open its local URL here. A source index.html cannot run a game's build step."),
                      h("div", { className: "dshd-pv-chips" }, serverProjects.slice(0, 3).map(page =>
                        h("button", { key: page.path, type: "button", className: "dshd-pv-chip",
                          title: page.rel || page.name, onClick: () => openWorkspacePage(page) },
                          `Open raw ${page.rel || page.name} anyway`)))));
                  }

                  // The manual path is always available, and it is the whole of
                  // the empty state when discovery found nothing.
                  parts.push(h("div", { key: "manual", className: "dshd-pv-find" },
                    h("h3", null, parts.length === 0 ? "A browser beside your chat" : "Or enter an address"),
                    h("p", null, parts.length === 0
                      ? ("Point it at your dev server as you build — http://localhost:3000 — "
                          + "or go anywhere: the address bar takes any URL, and anything else "
                          + "becomes a search."
                          + (HAS_WEBVIEW ? " Use the selector tool to inspect an element." : ""))
                      : "Your dev server, or anywhere on the web."),
                    h("div", { className: "dshd-pv-chips" },
                      COMMON_PORTS.map((port) =>
                        h("button", { key: port, type: "button", className: "dshd-pv-chip",
                          onClick: () => go(`http://localhost:${port}`) }, `:${port}`)))));

                  parts.push(h("button", { key: "refresh", type: "button",
                    className: "dshd-pv-refind", onClick: probe }, "Scan again"));

                  return parts;
                })()) : null,
        ),
        picked
          ? h("div", { key: "pick", className: "dshd-pv-pick" },
              h("div", null,
                h("code", null, picked.selector),
                h("div", { style: { marginTop: "4px", opacity: .75 } },
                  `${picked.tag} · ${picked.size} · ${picked.font}`
                  + (picked.text ? ` · "${picked.text}"` : ""))),
              h("button", { className: "dshd-pv-copy", type: "button",
                onClick: () => {
                  Promise.resolve().then(() => navigator.clipboard.writeText(picked.selector))
                    .then(() => setCopyStatus("Copied"))
                    .catch(() => setCopyStatus("Copy failed"));
                } }, copyStatus || "Copy selector"),
              h("button", { className: "dshd-pv-copy", type: "button", "aria-label": "Dismiss selected element", onClick: () => setPicked(null) }, "×"))
          : null,
      );
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          { name: "conversation.view", id: "preview", order: 20, label: () => "Preview" },
          PreviewView,
        ),
      );
    }

    exports.PreviewView = PreviewView;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
