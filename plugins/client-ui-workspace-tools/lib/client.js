/** Workspace tools are available without a conversation or a model account. */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-workspace-tools",
  factory: (require) => {
    const React = require("react");
    const { useEffect, useRef, useState, useSyncExternalStore } = React;
    const { createPortal } = require("react-dom");
    const h = React.createElement;
    const { FilesView } = require("@dsh-desktop/client-ui-files");
    const { PreviewView } = require("@dsh-desktop/client-ui-preview");
    const STYLE_ID = "dshd-workspace-tools-style";
    const CSS = `
.dshd-tools-trigger{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:42px;padding:0 12px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#f9fafb);font:inherit;font-size:13px;cursor:pointer;-webkit-app-region:no-drag}
.dshd-tools-trigger.is-compact{width:42px;padding:0}
.dshd-tools-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}
.dshd-tools-trigger:focus-visible,.dshd-tools button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}
.dshd-tools{box-sizing:border-box;position:fixed;inset:0;margin:auto;width:min(1440px,calc(100vw - 48px));height:calc(100dvh - 72px);max-width:none;max-height:none;padding:0;border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:16px;background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#f9fafb);box-shadow:0 24px 100px #0005;overflow:hidden;-webkit-app-region:no-drag}
.dshd-tools::backdrop{background:#09091180;backdrop-filter:blur(5px)}
.dshd-tools-layout{height:100%;display:flex;flex-direction:column;min-height:0}
.dshd-tools-head{display:flex;align-items:center;gap:20px;flex:0 0 auto;min-height:62px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff20)}
.dshd-tools-head h2{font:500 14px/20px sans-serif;margin:0;white-space:nowrap}
.dshd-tools-tabs{display:flex;gap:4px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-module-platform,#2c2d2f)}
.dshd-tools-tabs button,.dshd-tools-close{border:0;border-radius:8px;color:inherit;background:transparent;cursor:pointer;font:500 13px/20px sans-serif;min-height:36px;padding:6px 14px}
.dshd-tools-tabs button[aria-selected=true]{background:var(--dsw-alias-bg-base,#151517);box-shadow:0 1px 4px #0002}
.dshd-tools-close{margin-left:auto;min-width:36px;padding:6px 10px}
.dshd-tools-close:hover{background:var(--dsw-alias-interactive-bg-hover,#ffffff14)}
.dshd-tools-panel{flex:1;min-width:0;min-height:0;overflow:hidden}
.dshd-tools [hidden]{display:none!important}
@media(max-width:700px){.dshd-tools{width:100vw;height:100dvh;border:0;border-radius:0}.dshd-tools-head{gap:10px;padding:10px}.dshd-tools-head h2{font-size:12px}.dshd-tools-tabs button{padding-inline:10px}}
.dshd-nav-mount{flex:none;margin:-26px 0 25px}.dshd-navigation{display:grid;gap:2px}.dshd-navigation button{display:flex;align-items:center;gap:12px;width:100%;height:38px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;font-weight:400;line-height:20px;cursor:pointer;text-align:left;-webkit-app-region:no-drag}.dshd-navigation button:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}.dshd-navigation button[aria-expanded=true]{background:var(--dsw-specific-sidebar-nav-item-active)}[class~="hHd-Xa_collapsed"] .dshd-nav-mount{margin:-12px 0 20px}.dshd-navigation.is-collapsed{justify-items:center}.dshd-navigation.is-collapsed button{justify-content:center;width:36px;padding:0}.dshd-navigation svg{flex:none}.dshd-navigation button:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:2px}
.dshd-hub{inset:0;margin:0;width:100vw;height:100dvh;max-width:none;max-height:none;padding:0;border:0;border-radius:0;background:var(--dsw-alias-bg-base,#191919);color:var(--dsw-alias-label-primary,#ededed);-webkit-app-region:no-drag}.dshd-hub::backdrop{background:var(--dsw-alias-bg-base,#191919)}.dshd-hub-layout{display:grid;grid-template-columns:240px minmax(0,1fr);height:100%}.dshd-hub-nav{padding:48px 16px 24px;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill,#090909);display:flex;flex-direction:column;gap:4px}.dshd-hub-nav>small{margin:24px 12px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px}.dshd-hub button,.dshd-hub input,.dshd-hub select,.dshd-hub textarea{font:inherit}.dshd-hub button{cursor:pointer}.dshd-hub button:disabled{opacity:.45;cursor:default}.dshd-hub button:focus-visible,.dshd-hub a:focus-visible,.dshd-hub input:focus-visible,.dshd-hub select:focus-visible,.dshd-hub textarea:focus-visible{outline:2px solid var(--dsw-alias-label-secondary);outline-offset:3px}.dshd-hub-nav button{display:flex;align-items:center;gap:10px;padding:10px 12px;border:0;border-radius:8px;background:transparent;color:inherit;font-size:14px;text-align:left}.dshd-hub-nav button:hover,.dshd-hub-nav button[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-hover,#202020)}.dshd-hub-main{overflow:auto;min-width:0;padding:56px max(28px,calc((100% - 800px)/2)) 40px}.dshd-hub-main h1{font-size:24px;font-weight:500;letter-spacing:-.7px;margin:0 0 8px}.dshd-hub-intro{margin:0 0 32px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.7}.dshd-hub-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin:24px 0}.dshd-hub label{display:grid;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}.dshd-hub-controls label:first-child{flex:1;min-width:170px}.dshd-hub select,.dshd-hub input,.dshd-hub textarea{min-height:38px;max-width:100%;box-sizing:border-box;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1e1e1e);color:var(--dsw-alias-label-primary)}.dshd-hub textarea{resize:vertical;min-height:96px;width:100%;line-height:1.5}.dshd-hub-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:8px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font-size:13px}.dshd-hub-button.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}.dshd-hub-button:hover{filter:brightness(1.12)}.dshd-hub-empty{display:grid;justify-items:center;gap:12px;padding:52px 24px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;text-align:center}.dshd-hub-empty>svg{color:var(--dsw-alias-label-tertiary);width:28px;height:28px}.dshd-hub-empty strong{font-size:15px;font-weight:500}.dshd-hub-empty p{max-width:430px;margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}.dshd-hub-list{list-style:none;padding:0;margin:0;border-top:1px solid var(--dsw-alias-border-l2)}.dshd-hub-list li{display:flex;gap:14px;align-items:start;padding:20px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dshd-hub-list li>svg{flex:none;margin-top:3px;color:var(--dsw-alias-label-secondary)}.dshd-hub-list li>div{flex:1;min-width:0}.dshd-hub-list strong,.dshd-hub-list a{font-size:14px;font-weight:500;color:inherit;line-height:1.6;overflow-wrap:anywhere;text-decoration:none}.dshd-hub-list a:hover{text-decoration:underline}.dshd-hub-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7;margin-top:5px}.dshd-hub-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}.dshd-hub [role=alert]{color:var(--dsw-alias-state-error-primary,#e57373);font-size:13px;line-height:1.6}.dshd-hub-form{display:grid;gap:16px;padding:20px;margin-bottom:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}.dshd-hub-form .dshd-hub-controls{margin:0}.dshd-hub [hidden]{display:none!important}
.dshd-git-status{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:20px;margin-bottom:24px}.dshd-git-heading{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.dshd-git-heading strong{font-size:15px;font-weight:500;overflow-wrap:anywhere}.dshd-git-badge{margin-left:auto;font-size:11px;padding:4px 8px;border:1px solid currentColor;border-radius:6px}.dshd-git-badge[data-tone=good]{color:var(--dshd-good,#73c99b)}.dshd-git-badge[data-tone=warn]{color:var(--dshd-warn,#e8b16c)}.dshd-git-badge[data-tone=bad]{color:var(--dshd-bad,#ed8790)}.dshd-git-counts{display:flex;flex-wrap:wrap;gap:16px 28px;margin:20px 0 16px}.dshd-git-counts>div{display:grid;gap:6px}.dshd-git-counts dt{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dshd-git-counts dd{font-size:20px;font-variant-numeric:tabular-nums;margin:0}.dshd-plugin-retry{display:grid;gap:16px;justify-items:start}
.dshd-plugin-on{color:var(--dshd-good,#73c99b);font-size:11px;padding:2px 7px;border:1px solid currentColor;border-radius:6px;line-height:1.4}
.dshd-hub-list .dshd-hub-note{margin-top:6px;text-align:left;max-width:none}

@media(max-width:760px){.dshd-hub-layout{grid-template-columns:180px minmax(0,1fr)}.dshd-hub-nav{padding:38px 10px 20px}.dshd-hub-main{padding:40px 22px}}@media(max-width:560px){.dshd-hub-layout{display:flex;flex-direction:column}.dshd-hub-nav{flex-direction:row;flex-wrap:wrap;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l2);gap:2px}.dshd-hub-nav>small{display:none}.dshd-hub-nav button{padding:8px;font-size:12px}.dshd-hub-main{padding:28px 18px;flex:1}.dshd-hub-list li{gap:8px}.dshd-hub-controls{gap:8px}.dshd-hub-controls select{width:100%}}
`;
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID; style.textContent = CSS; document.head.appendChild(style);
    }

    const PAGES = { plugins: "Plugins", scheduled: "Scheduled", prs: "Pull requests" };
    const ICONS = {
      plugins: "M9 3h6v4h2a3 3 0 1 1 0 6h-2v8H9v-4H7a3 3 0 1 1 0-6h2Z",
      scheduled: "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
      prs: "M6 7v10M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0-4V9a4 4 0 0 0-4-4h-2m3-3-3 3 3 3",
      back: "m10 6-6 6 6 6M4 12h16", refresh: "M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3",
      plus: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6",
      computer: "M4 5h16v10H4zM8 19h8M12 15v4", terminal: "M5 8l4 4-4 4M11 16h8",
      files: "M4 4h7l3 3h6v13H4z", preview: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
      media: "M8 6.2v11.6L19 12 8 6.2z", phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm4 17h.01",
      notify: "M6 9a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9zm4 12h4",
      trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    };
    function Icon({ name, size = 18 }) {
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: ICONS[name] }));
    }
    async function request(url, init = {}) {
      const response = await fetch(url, { credentials: "same-origin", ...init });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Request failed. Try refreshing.");
      return payload;
    }
    function useRequest(url, revision = 0) {
      const [result, setResult] = useState({ data: null, error: "", loading: true });
      useEffect(() => {
        if (!url) { setResult({ data: null, error: "", loading: false }); return; }
        const controller = new AbortController();
        setResult({ data: null, error: "", loading: true });
        request(url, { signal: controller.signal }).then(data => {
          if (!controller.signal.aborted) setResult({ data, error: "", loading: false });
        }).catch(error => { if (!controller.signal.aborted) setResult({ data: null, error: error.message, loading: false }); });
        return () => controller.abort();
      }, [url, revision]);
      return result;
    }
    const Empty = ({ icon, title, children }) => h("div", { className: "dshd-hub-empty" }, h(Icon, { name: icon }), h("strong", null, title), h("p", null, children));
    const CAPABILITIES = [
      { id: "computer-use", name: "Computer use", icon: "computer", detail: "Drive Mac apps, windows, and the browser from the agent." },
      { id: "terminal", name: "Terminal", icon: "terminal", detail: "A local shell next to Chat, Files, and Preview." },
      { id: "files", name: "Files", icon: "files", detail: "Browse, edit, and play files in the open workspace." },
      { id: "preview", name: "Preview", icon: "preview", detail: "Open HTML from the session folder in a live guest." },
      { id: "media", name: "Media", icon: "media", detail: "Play video, audio, and images inside the thread." },
      { id: "git", name: "Git", icon: "prs", detail: "Inspect changes, commit, and push from the session sidebar." },
      { id: "scheduled", name: "Scheduled", icon: "scheduled", detail: "Run a prompt once, or on a repeating timer." },
      { id: "phone", name: "Phone", icon: "phone", detail: "Mirror this live session to a phone on the same Wi-Fi." },
      { id: "notify", name: "Notifications", icon: "notify", detail: "Dock badge and OS alerts when a turn needs you." },
    ];
    const SKIP_PLUGIN_TABS = new Set(["all", "configurable", "plugins", "general", "workspace-hub"]);
    function extraPluginTabs(slots) {
      const extras = [];
      try {
        for (const entry of (slots && slots.entries ? slots.entries("settings.plugins.tab") : []) || []) {
          const id = entry.options && entry.options.id;
          if (!id || SKIP_PLUGIN_TABS.has(id) || CAPABILITIES.some(item => item.id === id)) continue;
          const raw = entry.options.label;
          const name = typeof raw === "function" ? raw() : (raw || id);
          extras.push({ id, name, icon: "plugins", detail: "Configurable plugin settings for this workspace." });
        }
      } catch (_) {}
      return extras;
    }
    function Plugins({ error, onConfigure, slots }) {
      const items = CAPABILITIES.concat(extraPluginTabs(slots));
      return h(React.Fragment, null,
        h("div", { className: "dshd-hub-controls" },
          h("button", { type: "button", className: "dshd-hub-button primary", onClick: onConfigure }, "Open plugin settings")),
        error ? h("p", { role: "alert" }, error) : null,
        h("ul", { className: "dshd-hub-list", "aria-label": "Installed capabilities" },
          items.map(item => h("li", { key: item.id },
            h(Icon, { name: item.icon || "plugins" }),
            h("div", null, h("strong", null, item.name),
              h("p", { className: "dshd-hub-note" }, item.detail),
              h("div", { className: "dshd-hub-meta" }, h("span", { className: "dshd-plugin-on" }, "On")))))));
    }
    let lastPullRequestRoot = "";
    function GitStatus({ git, repository, remoteName }) {
      const label = git.detached ? "Detached HEAD" : git.branch;
      return h("section", { className: "dshd-git-status", "aria-label": "Local Git status" },
        h("div", { className: "dshd-git-heading" }, h(Icon, { name: "prs" }), h("strong", null, label),
          h("span", { className: "dshd-git-badge", "data-tone": git.conflicts ? "bad" : git.changed ? "warn" : "good" },
            git.conflicts ? git.conflicts + " conflicts" : git.changed ? git.changed + " changed" : "Working tree clean")),
        h("div", { className: "dshd-hub-meta" }, repository ? h("span", null, repository + " · " + remoteName) : null,
          git.unborn ? h("span", null, "No commits yet") : null,
          git.upstream ? h("span", null, "Tracking " + git.upstream) : h("span", null, "No tracking branch")),
        h("dl", { className: "dshd-git-counts" },
          [["Staged", git.staged], ["Unstaged", git.unstaged], ["Untracked", git.untracked],
            ["Ahead", git.ahead], ["Behind", git.behind]].map(([name, value]) => h("div", { key: name },
              h("dt", null, name), h("dd", null, value === null ? "—" : value)))),
        h("p", { className: "dshd-hub-note" }, "Local status · ahead/behind uses the last fetched remote state."));
    }
    function PullRequests() {
      const [revision, refresh] = useState(0);
      const roots = useRequest("/dsh-files/roots", revision);
      const [root, setRoot] = useState("");
      const [state, setState] = useState("open");
      useEffect(() => {
        if (!roots.data) return;
        const items = roots.data.roots || [];
        const paths = items.map(item => item.canonicalPath || item.path);
        const next = paths.includes(root) ? root : paths.includes(lastPullRequestRoot) ? lastPullRequestRoot : paths[0] || "";
        setRoot(next); lastPullRequestRoot = next;
      }, [roots.data]);
      const result = useRequest(root ? "/dsh-files/pull-requests?root=" + encodeURIComponent(root) + "&state=" + state : null, revision);
      const busy = roots.loading || result.loading;
      return h(React.Fragment, null,
        h("div", { className: "dshd-hub-controls" },
          h("label", null, "Workspace", h("select", { value: root, onChange: e => { setRoot(e.target.value); lastPullRequestRoot = e.target.value; }, disabled: roots.loading },
            h("option", { value: "", disabled: true }, "Choose a workspace"), (roots.data?.roots || []).map(item => h("option", { key: item.id, value: item.canonicalPath || item.path }, item.title || item.path.split("/").pop())))),
          h("label", null, "Status", h("select", { value: state, onChange: e => setState(e.target.value) }, ["open", "merged", "closed"].map(id => h("option", { key: id, value: id }, id[0].toUpperCase() + id.slice(1))))),
          h("button", { type: "button", className: "dshd-hub-button", disabled: busy, onClick: () => refresh(n => n + 1) }, h(Icon, { name: "refresh", size: 15 }), "Refresh")),
        roots.error || result.error ? h("p", { role: "alert" }, roots.error || result.error) : null,
        result.data?.git ? h(GitStatus, { git: result.data.git, repository: result.data.repository, remoteName: result.data.remoteName }) : null,
        busy ? h("p", { role: "status", className: "dshd-hub-note" }, "Checking Git and pull requests…")
          : result.data?.unavailable ? h(Empty, { icon: "prs", title: result.data.git ? "GitHub pull requests unavailable" : "Git needs attention" }, result.data.unavailable)
            : result.data?.items.length ? h(React.Fragment, null,
              h("ul", { className: "dshd-hub-list" }, result.data.items.map(item => h("li", { key: item.number }, h(Icon, { name: "prs" }),
                h("div", null, h("a", { href: item.url, target: "_blank", rel: "noopener noreferrer" }, item.title),
                  h("div", { className: "dshd-hub-meta" }, h("span", null, "#" + item.number), h("span", null, item.author), item.isDraft ? h("span", null, "Draft") : null,
                    h("span", null, item.head + " → " + item.base)))))),
              result.data.items.length >= result.data.limit ? h("p", { className: "dshd-hub-note" }, "Showing the 50 most recent results.") : null)
              : !roots.error && !result.error ? h(Empty, { icon: "prs", title: root ? "No " + state + " pull requests" : "Choose your project" }, root ? "Pull requests for this workspace will appear here." : "Add a Git project to Workspaces to check its status and pull requests.") : null);
    }
    function Scheduled() {
      const [revision, refresh] = useState(0);
      const sessions = useRequest("/dsh-workspace/sessions", revision);
      const [session, setSession] = useState("");
      const [creating, setCreating] = useState(false);
      const [prompt, setPrompt] = useState("");
      const [kind, setKind] = useState("every");
      const [minutes, setMinutes] = useState("60");
      const [pendingDelete, setPendingDelete] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const lifetime = useRef(null);
      useEffect(() => { lifetime.current = new AbortController(); return () => lifetime.current.abort(); }, []);
      useEffect(() => { if (!session && sessions.data?.sessions.length) setSession((sessions.data.sessions.find(item => item.live) || sessions.data.sessions[0]).id); }, [sessions.data]);
      const result = useRequest(session ? "/dsh-workspace/schedules?session=" + encodeURIComponent(session) : null, revision);
      async function change(operation, id) {
        if (busy) return;
        setBusy(true); setError(""); setNotice("");
        try {
          await request("/dsh-workspace/schedules", { method: "POST", headers: { "content-type": "application/json" }, signal: lifetime.current.signal,
            body: JSON.stringify({ operation, session, id, prompt, kind, minutes: Number(minutes) }) });
          if (lifetime.current.signal.aborted) return;
          setCreating(false); setPrompt(""); setPendingDelete(null); setNotice(operation === "create" ? "Schedule saved." : "Schedule removed."); refresh(n => n + 1);
        } catch (failure) { if (!lifetime.current.signal.aborted) setError(failure.message); }
        finally { if (!lifetime.current.signal.aborted) setBusy(false); }
      }
      return h(React.Fragment, null,
        h("div", { className: "dshd-hub-controls" },
          h("label", null, "Conversation", h("select", { value: session, disabled: busy || sessions.loading, onChange: e => { setSession(e.target.value); setCreating(false); setPendingDelete(null); setError(""); setNotice(""); } },
            h("option", { value: "", disabled: true }, "Choose a conversation"), (sessions.data?.sessions || []).map(item => h("option", { key: item.id, value: item.id }, item.title)))),
          h("button", { type: "button", className: "dshd-hub-button", disabled: busy || result.loading, onClick: () => refresh(n => n + 1) }, h(Icon, { name: "refresh", size: 15 }), "Refresh"),
          h("button", { type: "button", className: "dshd-hub-button primary", disabled: busy || !result.data?.manageable, onClick: () => setCreating(value => !value) }, h(Icon, { name: "plus", size: 15 }), "New schedule")),
        h("p", { className: "dshd-hub-note" }, "Tasks run in this conversation using its model and access settings. Keep DSH open and the conversation active. Repeating tasks run at most once every 5 minutes."),
        sessions.data?.hasMore ? h("p", { className: "dshd-hub-note" }, "Showing your 100 most recent conversations.") : null,
        result.data?.message ? h("p", { className: "dshd-hub-note" }, result.data.message) : null,
        error || sessions.error || result.error ? h("p", { role: "alert" }, error || sessions.error || result.error) : null,
        notice ? h("p", { role: "status", className: "dshd-hub-note" }, notice) : null,
        creating ? h("form", { className: "dshd-hub-form", onSubmit: e => { e.preventDefault(); void change("create"); } },
          h("label", null, "What should DSH do?", h("textarea", { value: prompt, autoFocus: true, required: true, maxLength: 8000, disabled: busy, placeholder: "Check the test results and summarize anything that needs attention…", onChange: e => setPrompt(e.target.value) })),
          h("div", { className: "dshd-hub-controls" }, h("label", null, "When", h("select", { value: kind, disabled: busy, onChange: e => setKind(e.target.value) }, h("option", { value: "every" }, "Repeat every"), h("option", { value: "after" }, "Run once after"))),
            h("label", null, "Minutes", h("input", { type: "number", value: minutes, required: true, min: kind === "every" ? 5 : 1, max: 525600, step: 1, disabled: busy, onChange: e => setMinutes(e.target.value) })),
            h("button", { type: "button", className: "dshd-hub-button", disabled: busy, onClick: () => setCreating(false) }, "Cancel"),
            h("button", { type: "submit", className: "dshd-hub-button primary", disabled: busy || !prompt.trim() }, busy ? "Saving…" : "Save schedule"))) : null,
        result.loading && session ? h("p", { role: "status", className: "dshd-hub-note" }, "Loading schedules…")
          : result.data?.items.length ? h("ul", { className: "dshd-hub-list" }, result.data.items.map(item => h("li", { key: item.id }, h(Icon, { name: "scheduled" }),
            h("div", null, h("strong", null, item.prompt), h("div", { className: "dshd-hub-meta" },
              h("span", null, item.kind === "every" ? "Every " + item.everySeconds / 60 + " min" : "One time"),
              h("span", null, (result.data.live ? "Next: " : "Inactive · due: ") + new Date(item.scheduledAt).toLocaleString()),
              item.state === "overdue" ? h("span", null, "Overdue") : null)),
            pendingDelete === item.id ? h("div", null,
              h("button", { type: "button", className: "dshd-hub-button", disabled: busy, onClick: () => change("delete", item.id) }, "Remove schedule"),
              h("button", { type: "button", className: "dshd-hub-button", disabled: busy, onClick: () => setPendingDelete(null) }, "Keep"))
              : h("button", { type: "button", className: "dshd-hub-button", "aria-label": "Remove schedule: " + item.prompt.slice(0, 60), disabled: busy || !result.data.manageable, onClick: () => setPendingDelete(item.id) }, h(Icon, { name: "trash", size: 15 })))))
            : !sessions.loading && !sessions.error && !result.error ? h(Empty, { icon: "scheduled", title: "Make time for what’s next" }, session ? "Create a task to run once or repeat in this conversation." : "Start a conversation first, then schedule a task here.") : null);
    }

    function apply(ctx) {
      // Scoped to this plugin registration, not window globals or session state.
      let state = { open: false, tab: "files", visited: [], hub: null, pluginError: "" };
      const listeners = new Set();
      const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
      const snapshot = () => state;
      const select = (tab) => {
        stopSettingsWait();
        if (tab !== "files" && tab !== "preview") return;
        state = { ...state, open: true, hub: null, tab, visited: [...new Set([...state.visited, tab])] };
        listeners.forEach(fn => fn());
      };
      const close = () => { state = { ...state, open: false }; listeners.forEach(fn => fn()); };
      let stopSettingsWait = () => {};
      const openPlugins = () => {
        stopSettingsWait();
        const trigger = document.querySelector('button[class~="VOzbGW_trigger"]');
        if (!trigger) return false;
        const succeed = () => {
          stopSettingsWait();
          state = { ...state, hub: null, pluginError: "" };
          listeners.forEach(fn => fn());
          return true;
        };
        // Prefer the visible "Plugins" label. Extra settings.section occupants
        // (including this hub's own mount) used to desync cell index vs registry
        // length, which left the sidebar item on an empty retry screen.
        const select = () => {
          const cells = [...document.querySelectorAll('[class~="VOzbGW_navList"] [class~="VOzbGW_navCell"], [class~="VOzbGW_navList"]>[class~="VOzbGW_navCell"]')];
          if (!cells.length) return false;
          const labeled = cells.find(cell => (cell.textContent || "").replace(/\s+/g, " ").trim() === "Plugins");
          if (labeled) { labeled.click(); return succeed(); }
          const entries = ctx.slots.entries("settings.section").slice().sort((a, b) => (a.options.order || 0) - (b.options.order || 0));
          const index = entries.findIndex(entry => entry.options.id === "plugins");
          if (index >= 0 && cells[index]) { cells[index].click(); return succeed(); }
          return false;
        };
        if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
        if (select()) return true;
        const observer = new MutationObserver(() => { select(); });
        const timeout = setTimeout(() => {
          stopSettingsWait();
          state = { ...state, hub: "plugins", pluginError: "Plugin settings could not be opened. Try again once the app has connected." };
          listeners.forEach(fn => fn());
        }, 5000);
        stopSettingsWait = () => { observer.disconnect(); clearTimeout(timeout); stopSettingsWait = () => {}; };
        observer.observe(document.body, { childList: true, subtree: true });
        return true;
      };
      const navigate = (page) => {
        stopSettingsWait();
        state = { ...state, open: false, pluginError: "", hub: Object.hasOwn(PAGES, page) ? page : null };
        listeners.forEach(fn => fn());
      };
      ctx.effect(() => () => stopSettingsWait(), "workspace navigation: settings bridge");

      function Navigation({ wide = true }) {
        ensureStyle();
        const current = useSyncExternalStore(subscribe, snapshot);
        const origin = useRef(null);
        const [anchor, setAnchor] = useState(null);
        useEffect(() => {
          // The upstream sidebar exposes only a footer extension slot. Own a
          // separate portal mount before Workspaces, without replacing its
          // React-managed navigation or moving any of its elements.
          const column = origin.current?.closest('[class~="hHd-Xa_root"]');
          const region = column?.querySelector('[class~="hHd-Xa_regionArea"]');
          if (!region) return;
          const mount = document.createElement("div"); mount.className = "dshd-nav-mount";
          column.insertBefore(mount, region); setAnchor(mount);
          return () => mount.remove();
        }, []);
        const content = h("nav", { className: "dshd-navigation" + (wide ? "" : " is-collapsed"), "aria-label": "App navigation" },
          Object.entries(PAGES).filter(([id]) => id !== "plugins").map(([id, label]) => h("button", { key: id, type: "button", title: label, "aria-label": label,
            "aria-haspopup": "dialog", "aria-expanded": current.hub === id, onClick: () => navigate(id) }, h(Icon, { name: id }), wide ? h("span", null, label) : null)));
        return h(React.Fragment, null, h("span", { ref: origin, hidden: true }), anchor ? createPortal(content, anchor) : content);
      }

      function HubPanel() {
        const current = useSyncExternalStore(subscribe, snapshot);
        const dialog = useRef(null);
        useEffect(() => {
          const element = dialog.current;
          if (current.hub && !element.open) element.showModal();
          if (!current.hub && element.open) element.close();
        }, [current.hub]);
        useEffect(() => () => { if (dialog.current?.open) dialog.current.close(); }, []);
        return h("dialog", { ref: dialog, className: "dshd-hub", "aria-labelledby": "dshd-hub-title",
          onCancel: e => { e.preventDefault(); navigate(null); }, onClose: () => { if (snapshot().hub) navigate(null); } },
          current.hub ? h("div", { className: "dshd-hub-layout" },
            h("nav", { className: "dshd-hub-nav", "aria-label": "Workspace pages" },
              h("button", { type: "button", onClick: () => navigate(null) }, h(Icon, { name: "back", size: 16 }), "Back to app"),
              h("small", null, "Workspace"), Object.entries(PAGES).map(([id, label]) => h("button", { key: id, type: "button", "aria-current": current.hub === id ? "page" : undefined, onClick: () => navigate(id) }, h(Icon, { name: id }), label))),
            h("main", { className: "dshd-hub-main" }, h("h1", { id: "dshd-hub-title" }, PAGES[current.hub]),
              h("p", { className: "dshd-hub-intro" }, current.hub === "plugins" ? "Configure the capabilities that power your workspace."
                : current.hub === "scheduled" ? "Let DSH pick things up at the right time." : "Keep your project’s reviews within reach."),
              current.hub === "plugins" ? h(Plugins, { error: current.pluginError, slots: ctx.slots, onConfigure: () => {
                  if (!openPlugins()) {
                    state = { ...state, pluginError: "Plugin settings could not be opened. Try again once the app has connected." };
                    listeners.forEach(fn => fn());
                  }
                } })
                : h(current.hub === "scheduled" ? Scheduled : PullRequests, { key: current.hub }))) : null);
      }

      function Launcher({ wide = true, tab }) {
        ensureStyle();
        const current = useSyncExternalStore(subscribe, snapshot);
        const label = tab === "files" ? "Open files" : tab === "preview" ? "Open preview" : "Open workspace tools";
        return h("button", { type: "button", className: "dshd-tools-trigger" + (wide ? "" : " is-compact"),
          title: label, "aria-label": label, "aria-haspopup": "dialog",
          "aria-expanded": current.open && (!tab || current.tab === tab), onClick: () => select(tab || current.tab) },
          h("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, "aria-hidden": true },
            tab === "files" ? h("path", { d: "M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM3 11h18" })
              : h(React.Fragment, null, h("rect", { x: 3, y: 4, width: 18, height: 16, rx: 3 }), h("path", { d: tab === "preview" ? "M3 9h18M6 6.5h.1M9 6.5h.1" : "M3 9h18M9 9v11" }))),
          wide ? h("span", null, "Files & Preview") : null);
      }

      function HomeActions() {
        return h(React.Fragment, null, h(Launcher, { wide: false, tab: "files" }), h(Launcher, { wide: false, tab: "preview" }));
      }

      function Panel() {
        ensureStyle();
        const current = useSyncExternalStore(subscribe, snapshot);
        const dialog = useRef(null);
        const filesTab = useRef(null);
        const previewTab = useRef(null);
        useEffect(() => {
          const element = dialog.current;
          if (current.open && !element.open) {
            element.showModal();
            (current.tab === "files" ? filesTab : previewTab).current?.focus();
          }
          if (!current.open && element.open) element.close();
        }, [current.open, current.tab]);
        useEffect(() => () => { if (dialog.current?.open) dialog.current.close(); }, []);
        function keyDown(event) {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? "files" : event.key === "End" ? "preview"
            : current.tab === "files" ? "preview" : "files";
          select(next);
          (next === "files" ? filesTab : previewTab).current?.focus();
        }
        return h("dialog", { ref: dialog, className: "dshd-tools", "aria-labelledby": "dshd-tools-title",
          onCancel: (event) => { event.preventDefault(); close(); }, onClose: close },
          h("div", { className: "dshd-tools-layout" },
            h("header", { className: "dshd-tools-head" },
              h("h2", { id: "dshd-tools-title" }, "Workspace tools"),
              h("div", { className: "dshd-tools-tabs", role: "tablist", "aria-label": "Workspace tool", onKeyDown: keyDown },
                ["files", "preview"].map(id => h("button", { key: id, ref: id === "files" ? filesTab : previewTab,
                  type: "button", role: "tab", id: "dshd-tools-tab-" + id, "aria-controls": "dshd-tools-panel-" + id,
                  "aria-selected": current.tab === id, tabIndex: current.tab === id ? 0 : -1, onClick: () => select(id) },
                  id === "files" ? "Files" : "Preview"))),
              h("button", { type: "button", className: "dshd-tools-close", "aria-label": "Close workspace tools", title: "Back to app · Esc", onClick: close },
                h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d: "m10 6-6 6 6 6M4 12h16" })),
                h("span", null, "Back"))),
            ["files", "preview"].map(id => h("section", { key: id, id: "dshd-tools-panel-" + id,
              className: "dshd-tools-panel", role: "tabpanel", "aria-labelledby": "dshd-tools-tab-" + id,
              hidden: current.tab !== id },
              current.visited.includes(id) ? h(id === "files" ? FilesView : PreviewView,
                { standalone: true, active: current.open && current.tab === id }) : null))));
      }
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
        { name: "sidebar.footer.action", id: "workspace-navigation", order: -10 }, Navigation));
      ctx.slots.inject("desktop.home.actions", () => ctx.slots.register(
        { name: "desktop.home.actions", id: "workspace-tools", order: 0 }, HomeActions));
      ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "workspace-tools", order: 10 }, Panel));
      ctx.slots.inject("settings.section", () => ctx.slots.inject("shell.overlay", () => ctx.slots.register(
        { name: "shell.overlay", id: "workspace-hub", order: 11 }, HubPanel)));
    }
    return { apply, inject: ["slots"] };
  },
});
