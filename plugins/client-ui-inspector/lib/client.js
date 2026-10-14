/** The session inspector owns its portal, never the upstream React DOM. */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-inspector",
  factory: (require) => {
    const React = require("react"),
      { useState, useEffect, useRef } = React,
      h = React.createElement;
    const { createPortal } = require("react-dom");
    const { SessionMetrics } = require("@dsh-desktop/client-ui-theme-holo");
    const { FilesView } = require("@dsh-desktop/client-ui-files");
    const { references } = require("@dsh-desktop/client-ui-media");
    const { SetupPanel } = require("@dsh-desktop/development-setup");
    const { ComputerUsePanel, ComputerUseStatus } = require("@dsh-desktop/computer-use");
    const CSS = `
:where(body:not(:is([data-dshd-view=trajectory],[data-dshd-view=preview],[data-dshd-view=files]))) [data-dsh-inspector-open]{display:grid!important;grid-template-columns:minmax(0,1fr) clamp(260px,23vw,320px);grid-template-rows:auto minmax(0,1fr)}
body:is([data-dshd-view=trajectory],[data-dshd-view=preview],[data-dshd-view=files]) :is(.dshd-inspector-mount,.dshd-inspector-toggle){display:none!important}
[data-dsh-inspector-open]>:first-child{grid-column:1/-1}[data-dsh-inspector-open]>:first-child>header{grid-column:1/-1;grid-row:1}[data-dsh-inspector-open]>[data-conversation-scroll]{grid-column:1;grid-row:2;min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
.dshd-inspector-mount{grid-column:2;grid-row:2;min-height:0;overflow:auto;overscroll-behavior:contain;padding:12px 12px 12px 0;-webkit-app-region:no-drag}
/* The panel is its own inline-size container. What constrains the usage ledger is the panel's width, not the window's, so the ledger folds against this. */
.dshd-inspector{container:dsh-inspector / inline-size;border:1px solid var(--dsw-alias-border-l2);border-radius:22px;background:var(--dsw-alias-bg-layer-2);padding:0 20px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshd-inspector>details{padding:14px 0;border-top:1px solid var(--dsw-alias-border-l1)}.dshd-inspector summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}.dshd-inspector>details[open]>summary{margin-bottom:12px}.dshd-inspector .recovery summary{font-size:11px}.dshd-inspector details.recovery{display:block}.dshd-inspector details.recovery[open]>summary{margin-bottom:8px}
.dshd-inspector section{padding:16px 0}.dshd-inspector section+section{border-top:1px solid var(--dsw-alias-border-l1)}
/* One eyebrow voice and one heading-band height for every section, so the panel reads as a stack of equals instead of a pile of separate widgets. */
.dshd-inspector h3{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;margin:0 0 8px;font-size:11px;font-weight:500;letter-spacing:-.01em;color:var(--dsw-alias-label-secondary)}
.dshd-inspector button,.dshd-inspector select,.dshd-inspector input{font:inherit;color:inherit}.dshd-inspector button{cursor:pointer}.dshd-inspector button:disabled{opacity:.45;cursor:default}
/* A row keeps its text on the panel's text edge while its hover fill bleeds into the gutter — the inset that makes a list feel built rather than stacked. */
.dshd-inspector .row{display:flex;gap:8px;align-items:center;box-sizing:border-box;width:calc(100% + 16px);margin-inline:-8px;padding:5px 8px;min-height:28px;border:0;border-radius:8px;background:transparent;text-align:left;min-width:0;color:var(--dsw-alias-label-secondary);transition:background-color .12s ease,color .12s ease}
.dshd-inspector .row span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshd-inspector .row small{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.dshd-inspector svg{flex:none}.dshd-inspector .row>svg:first-child{color:var(--dsw-alias-label-tertiary);transition:color .12s ease}
.dshd-inspector button.row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshd-inspector button.row:hover>svg:first-child{color:var(--dsw-alias-label-secondary)}.dshd-inspector button.row:active{background:var(--dsw-alias-interactive-bg-active)}
/* The trailing chevron is the affordance a bare icon-and-label row was missing: it says the row opens something, and says it only under the pointer. */
.dshd-inspector .row .go{opacity:0;color:var(--dsw-alias-label-tertiary);transition:opacity .12s ease}.dshd-inspector button.row:hover .go,.dshd-inspector button.row:focus-visible .go{opacity:1}
.dshd-inspector select{max-width:100%;min-width:0;width:100%;border:0;background:transparent;padding:4px 0}.dshd-inspector option{background:var(--dsw-alias-bg-layer-2)}
.dshd-inspector .note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.6;margin:8px 0 0;overflow-wrap:anywhere}
/* Side by side while both labels fit, one per line the moment they do not: a
   button whose text wraps mid-label is the panel admitting it ran out of room. */
.dshd-inspector .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.dshd-inspector .actions button,.dshd-inspector .small-button{padding:6px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;font-size:11px;transition:background-color .12s ease,border-color .12s ease}.dshd-inspector .actions button{flex:1 1 auto;min-width:max-content;white-space:nowrap}
.dshd-inspector .actions button:hover:not(:disabled),.dshd-inspector .small-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-tertiary)}
/* A heading-row control is a 24px target, not a bordered button: at this size a border is louder than the icon it wraps. */
.dshd-inspector .icon-button{display:grid;place-items:center;width:24px;height:24px;margin-right:-6px;padding:0;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-tertiary);transition:background-color .12s ease,color .12s ease}
.dshd-inspector .icon-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
/* The workspace is one identity — a mark, the folder it points at, and what kind of environment it is — so the panel opens on a subject, not on three loose lines. */
.dshd-inspector .env{display:flex;align-items:center;gap:10px;min-width:0}
.dshd-inspector .env-mark{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dshd-inspector .env-body{display:flex;flex-direction:column;flex:1;min-width:0}
.dshd-inspector .env-name{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshd-inspector .env-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshd-inspector .changes{margin:12px -8px 0;padding-inline:8px;max-height:220px;overflow:auto;overscroll-behavior:contain}.dshd-inspector .changes .row{gap:6px;font-size:11px}.dshd-inspector .changes button.small-button{font-size:10px;padding:3px 6px}
/* Nothing in this app draws a scrollbar, so a list long enough to scroll says "more below" with a fade — and only when it is actually that long. */
.dshd-inspector .changes.overflowing{-webkit-mask-image:linear-gradient(#000 calc(100% - 24px),transparent);mask-image:linear-gradient(#000 calc(100% - 24px),transparent)}
.dshd-inspector [role=alert]{font-size:11px;line-height:1.6;color:var(--dshd-bad);margin:8px 0 0}
.dshd-inspector .good{color:var(--dshd-good)}.dshd-inspector .warn{color:var(--dshd-warn)}.dshd-inspector .bad{color:var(--dshd-bad)}
/* A closed folder used to read as three unrelated lines. The sentence, the path it names, and the action that fixes it are one card. */
.dshd-inspector .recovery{display:flex;flex-direction:column;align-items:start;gap:8px;margin:12px 0 0;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dshd-inspector .recovery .note{margin:0;color:var(--dsw-alias-label-secondary)}
.dshd-inspector .recovery .path{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
/* Session usage reports nothing until a turn has run, which left a heading standing over an empty box. */
.dshd-inspector section:not(:has(> :not(h3))){display:none}
/* Ten readings, not ten boxes. A bordered tile per number reads as ten buttons; a baseline-aligned ledger in tabular figures reads as one block. These sit a step below the panel's body text on purpose — they are reference data, not the panel's headline — and that step is also what lets two columns hold the longest pair ("First token" against a value) at the narrowest docked width. auto-fit drops to one column when even that will not fit. */
.dshd-inspector .dshd-session-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));column-gap:12px;row-gap:8px;width:auto;max-width:none;margin:0;padding:0;overflow:visible;white-space:normal}
.dshd-inspector .dshd-session-stats span{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0;min-height:0;padding:0;border:0;border-radius:0;background:none;overflow:hidden;white-space:nowrap;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.dshd-inspector .dshd-session-stats b{font-size:11px;white-space:nowrap;color:var(--dsw-alias-label-primary)}.dshd-inspector .dshd-session-stats [data-tone]::before{display:none}
/* Tone rides the value alone, and only for a reading that needs attention. */
.dshd-inspector .dshd-session-stats [data-tone]{color:var(--dsw-alias-label-tertiary);background:none}.dshd-inspector .dshd-session-stats [data-tone] b{color:var(--dsw-alias-label-primary)}
.dshd-inspector .dshd-session-stats [data-tone=warn] b{color:var(--dshd-warn)}.dshd-inspector .dshd-session-stats [data-tone=bad] b{color:var(--dshd-bad)}
.dshd-inspector-toggle{box-sizing:border-box;min-height:34px;padding:7px 12px;display:inline-flex;align-items:center;gap:7px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;font-weight:400;line-height:18px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);-webkit-app-region:no-drag;transition:background-color .15s ease,border-color .15s ease,color .15s ease}
.dshd-inspector-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}.dshd-inspector-toggle[aria-expanded=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dshd-inspector-review{width:min(860px,calc(100vw - 40px));max-height:85dvh;box-sizing:border-box;padding:24px;border:1px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);-webkit-app-region:no-drag}.dshd-inspector-review[aria-label="Computer controls"][open],.dshd-setup-dialog[open]{display:flex;flex-direction:column;gap:16px;width:min(720px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:hidden}.dshd-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-shrink:0}.dshd-inspector-review .dshd-dialog-header h2{margin:0}.dshd-dialog-body{min-height:0;overflow:auto;scrollbar-gutter:stable;padding-right:4px}.dshd-inspector-review::backdrop{background:#0008}.dshd-inspector-review h2{font-size:20px;font-weight:500;margin:0 0 18px}.dshd-inspector-review pre{font-size:12px;line-height:1.6;max-height:42dvh;overflow:auto;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.dshd-inspector-review textarea{width:100%;box-sizing:border-box;padding:12px;margin-bottom:12px;font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px}.dshd-inspector-review footer{display:flex;gap:8px;justify-content:end}.dshd-inspector-review button{padding:9px 16px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;cursor:pointer}.dshd-inspector-review p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}.dshd-inspector-review[aria-label="Workspace files"]{height:85dvh;padding:12px;display:flex;flex-direction:column}.dshd-inspector-review:not([open]){display:none}.dshd-inspector-review .file-body{min-height:0;flex:1;margin-top:12px}
.dshd-inspector :focus-visible,.dshd-inspector-toggle:focus-visible,.dshd-inspector-review :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}
:where(body:not(:is([data-dshd-view=trajectory],[data-dshd-view=preview],[data-dshd-view=files]))) [data-dsh-inspector-open][data-dsh-inspector-layout=overlay]{display:grid!important;grid-template-columns:minmax(0,1fr)}
[data-dsh-inspector-layout=overlay] .dshd-inspector-mount{position:absolute;right:8px;top:var(--dshd-header-height,100px);bottom:8px;width:min(272px,calc(100% - 16px));padding:0;z-index:30;box-shadow:var(--dshd-panel-shadow);border-radius:14px}
.dshd-inspector-close{display:none}
[data-dsh-inspector-layout=overlay] .dshd-inspector-close{display:flex;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box;width:calc(100% + 16px);margin-inline:-8px;padding:14px 8px 0;border:0;border-radius:8px;background:transparent;font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);transition:color .12s ease}
[data-dsh-inspector-layout=overlay] .dshd-inspector-close:hover{color:var(--dsw-alias-label-primary)}
@container dsh-chat (max-width:1050px){.dshd-inspector-toggle{width:34px;height:34px;justify-content:center;padding:7px}.dshd-inspector-toggle span{display:none}}
@media(max-height:720px){.dshd-inspector section{padding:12px 0}.dshd-inspector .note{line-height:1.5;margin-top:6px}.dshd-inspector .dshd-session-stats{row-gap:6px}.dshd-inspector .recovery{padding:8px;gap:6px}}
@media(prefers-reduced-motion:reduce){.dshd-inspector .row,.dshd-inspector .go,.dshd-inspector .icon-button,.dshd-inspector .small-button,.dshd-inspector .actions button,.dshd-inspector-toggle,.dshd-inspector-review button{transition:none}}
.dshd-inspector-review .diff-line{display:block;white-space:pre}.dshd-inspector-review .diff-add{color:var(--dshd-good);background:color-mix(in srgb,var(--dshd-good) 8%,transparent)}.dshd-inspector-review .diff-remove{color:var(--dshd-bad);background:color-mix(in srgb,var(--dshd-bad) 8%,transparent)}.dshd-inspector-review .diff-hunk{color:#8fa9e8}

`;
    const paths = {
      panel: "M3 4h18v16H3ZM15 4v16",
      close: "M6 6l12 12M18 6 6 18",
      git: "M6 3v14m0 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-4v4a6 6 0 0 1-6 6H6",
      changes: "M7 3h10l4 4v14H3V3Zm5 5v8m-4-4h8",
      local: "M4 4h16v12H4ZM2 20h20",
      agent: "M8 8a4 4 0 1 0 8 0 4 4 0 0 0-8 0ZM4 21v-3a8 8 0 0 1 16 0v3",
      terminal: "M3 4h18v16H3Zm4 5 3 3-3 3m6 0h4",
      file: "M4 3h10l6 6v12H4Zm10 0v6h6",
      folder: "M3 6h6l2 2h10v12H3Z",
      chevron: "m9 6 6 6-6 6",
      refresh:
        "M20 4v6h-6M4 20v-6h6M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3",
    };
    const Icon = ({ name, className }) =>
      h(
        "svg",
        {
          className,
          width: 16,
          height: 16,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("path", { d: paths[name] || paths.file }),
      );
    async function request(url, options = {}) {
      const r = await fetch(url, { credentials: "same-origin", ...options }),
        data = await r.json();
      if (!r.ok) throw Object.assign(Error(data.error || "Could not complete this action."), {code:data.code});
      return data;
    }
    // A reference can name a directory, and a directory is not a source: there
    // is no file to open, and the row it produced only ever read "tmp/". Only a
    // path that ends in a real file segment earns a row, so this returns null
    // for everything else and the caller drops it.
    function sourceName(path) {
      if (path.endsWith("/")) return null;
      return path.split("/").filter(Boolean).at(-1) || null;
    }
    function Git({ root, onFiles, reopenWorkspace }) {
      const [data, setData] = useState(null),
        [error, setError] = useState(""),
        [closed, setClosed] = useState(false),
        [busy, setBusy] = useState(false),
        [uninit, setUninit] = useState(false),
        [tick, setTick] = useState(0),
        [review, setReview] = useState(null),
        [message, setMessage] = useState(""),
        [expanded, setExpanded] = useState(false);
      const generation = useRef(0),
        dialog = useRef(null);
      useEffect(() => {
        let stopped = false;
        const timer = setInterval(() => {
          if (!stopped && !review && !busy) setTick((n) => n + 1);
        }, 15000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [review, busy]);
      useEffect(() => {
        const c = new AbortController();
        generation.current++;
        setError("");
        setClosed(false);
        setUninit(false);
        if (root)
          request("/dsh-files/git?root=" + encodeURIComponent(root), {
            signal: c.signal,
          })
            .then((d) => {
              if (!c.signal.aborted) setData(d);
            })
            .catch((e) => {
              if (!c.signal.aborted) {
                setData(null);
                const shut = e.code === 'WORKSPACE_NOT_OPEN';
                const empty = e.code === 'NOT_A_GIT_REPOSITORY' || /not a Git repository/i.test(e.message || "");
                setClosed(shut);
                setUninit(empty);
                // Closed and empty folders explain themselves in the recovery
                // cards below; keep the alert for faults with no cure.
                setError((shut && reopenWorkspace) || empty ? "" : e.message);
              }
            });
        return () => { c.abort(); generation.current++; };
      }, [root, tick]);
      async function reopen() {
        if (busy || !closed || !reopenWorkspace) return;
        const version=generation.current;
        setBusy(true);
        try {
          await reopenWorkspace(root);
          if (version === generation.current) { setClosed(false); setTick(n=>n+1); }
        } catch (e) {
          if (version === generation.current) setError(e.message || 'Could not reopen this workspace.');
        } finally {
          if (version === generation.current) setBusy(false);
        }
      }
      async function createRepo() {
        if (busy || !uninit || !root) return;
        const version = generation.current;
        setBusy(true);
        setError("");
        try {
          const next = await request("/dsh-files/git", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ root, action: "init" }),
          });
          if (generation.current === version) {
            setData(next);
            setUninit(false);
            setError("");
          }
        } catch (e) {
          if (generation.current === version) setError(e.message);
        } finally {
          if (generation.current === version) setBusy(false);
        }
      }
      useEffect(() => {
        if (review && !dialog.current.open) dialog.current.showModal();
        else if (!review && dialog.current.open) dialog.current.close();
      }, [review]);
      async function act(action, extra = {}) {
        const version = generation.current;
        setBusy(true);
        setError("");
        try {
          const next = await request("/dsh-files/git", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              root,
              revision: (review?.data || data).revision,
              action,
              ...extra,
            }),
          });
          if (generation.current === version) {
            setData(next);
            setReview(null);
            setMessage("");
          }
        } catch (e) {
          if (generation.current === version) setError(e.message);
        } finally {
          setBusy(false);
        }
      }
      return h(
        "section",
        null,
        h(
          "h3",
          null,
          root ? root.split('/').filter(Boolean).at(-1) : "Workspace",
          h(
            "button",
            {
              className: "icon-button",
              type: "button",
              title: "Refresh Git",
              "aria-label": "Refresh Git",
              disabled: busy,
              onClick: () => setTick((n) => n + 1),
            },
            h(Icon, { name: "refresh" }),
          ),
        ),
        // "Local", the folder name, and the kind of environment used to be
        // three separate lines that happened to sit next to each other. They
        // describe one thing, so they are one block: mark, subject, qualifier.
        h(
          "div",
          { className: "env", title: root || undefined },
          h("span", { className: "env-mark" }, h(Icon, { name: "local" })),
          h(
            "div",
            { className: "env-body" },
            h(
              "span",
              { className: "env-name" },
              root ? "Local workspace" : "No workspace",
            ),
            h(
              "span",
              { className: "env-meta" },
              root || "Choose a folder to use Git",
            ),
          ),
        ),
        data
          ? h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "row" },
                h(Icon, { name: "git" }),
                h(
                  "select",
                  {
                    "aria-label": "Git branch",
                    value: data.detached ? "" : data.branch || "",
                    disabled: busy || !!review,
                    onChange: (e) =>
                      setReview({
                        kind: "switch",
                        branch: e.target.value,
                        data,
                      }),
                  },
                  data.detached
                    ? h("option", { value: "" }, "Detached HEAD")
                    : null,
                  data.unborn
                    ? h(
                        "option",
                        { value: data.branch },
                        data.branch + " · no commits",
                      )
                    : null,
                  data.branches.map((b) =>
                    h("option", { key: b, value: b }, b),
                  ),
                ),
              ),
              h(
                "button",
                {
                  className: "row",
                  type: "button",
                  "aria-expanded": expanded,
                  onClick: () => setExpanded(!expanded),
                },
                h(Icon, { name: "changes" }),
                h("span", null, "Changes"),
                h(
                  "small",
                  {
                    className: data.conflicts
                      ? "bad"
                      : data.changed
                        ? "warn"
                        : "good",
                  },
                  data.changed || "Clean",
                ),
              ),
              expanded
                ? h(
                    "div",
                    // The fade is the only overflow cue this list gets, so it
                    // is applied from the row count rather than left on: a
                    // short list faded at the bottom just looks broken. Eight
                    // 28px rows is the first count that exceeds the 220px cap.
                    { className: data.files.length > 7 ? "changes overflowing" : "changes" },
                    data.files.map((f) =>
                      h(
                        "div",
                        { className: "row", key: f.path },
                        h("span", { title: f.path }, f.path),
                        h(
                          "small",
                          null,
                          f.conflict
                            ? "Conflict"
                            : f.staged
                              ? "Staged"
                              : f.untracked
                                ? "New"
                                : "Modified",
                        ),
                        h(
                          "button",
                          {
                            className: "small-button",
                            disabled: busy || f.conflict,
                            onClick: () =>
                              act(f.staged ? "unstage" : "stage", {
                                path: f.path,
                              }),
                          },
                          f.staged ? "Unstage" : "Stage",
                        ),
                      ),
                    ),
                  )
                : null,
              h(
                "div",
                { className: "actions" },
                h(
                  "button",
                  {
                    disabled: busy,
                    onClick: () => setReview({ kind: "commit", data }),
                  },
                  "Review & commit",
                ),
                h(
                  "button",
                  {
                    disabled: busy || !data.push || data.unborn,
                    onClick: () => setReview({ kind: "push", data }),
                  },
                  "Push",
                ),
              ),
              h(
                "p",
                { className: "note" },
                data.upstream
                  ? data.upstream +
                      " · " +
                      (data.ahead ?? "—") +
                      " ahead · " +
                      (data.behind ?? "—") +
                      " behind"
                  : "No tracking branch",
              ),
              data.upstream
                ? h(
                    "p",
                    { className: "note" },
                    data.pushWarning || "Remote counts reflect the last fetch.",
                  )
                : null,
            )
          : root && !error && !closed
            && !uninit
            ? h("p", { className: "note" }, "Reading repository…")
            : null,
        error ? h("p", { role: "alert" }, error) : null,
        closed && reopenWorkspace ? h("div", { className: "recovery" },
          h("p", {className:"note"}, "This workspace folder is closed. Reopen it to read Git state and workspace files."),
          h("p", {className:"path",title:root}, root),
          h("button", {type:"button",className:"small-button",disabled:busy,onClick:reopen}, busy ? "Opening…" : "Reopen workspace")) : null,
        uninit && root ? h("details", { className: "recovery" },
          h("summary", null, "Git not configured"),
          h("p", {className:"note"}, "This folder is not a Git repository yet. Create one to commit and push from here."),
          h("p", {className:"path",title:root}, root),
          h("button", {type:"button",className:"small-button",disabled:busy,onClick:createRepo}, busy ? "Creating…" : "Create Git repository")) : null,
        h(
          "dialog",
          {
            ref: dialog,
            className: "dshd-inspector-review",
            "aria-label": "Review Git action",
            onCancel: (e) => {
              e.preventDefault();
              if (!busy) setReview(null);
            },
            onClose: () => {
              if (!busy) setReview(null);
            },
          },
          review
            ? h(
                React.Fragment,
                null,
                h(
                  "h2",
                  null,
                  review.kind === "commit"
                    ? "Review staged changes"
                    : review.kind === "push"
                      ? "Push this commit"
                      : "Switch branch",
                ),
                review.kind === "commit"
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        "p",
                        null,
                        review.data.staged +
                          " staged files. Only staged changes will be committed.",
                      ),
                      h(
                        "pre",
                        null,
                        review.data.stagedDiff ? review.data.stagedDiff.split("\n").map((line, i) => h("span", {key:i,className:"diff-line " + (line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : line.startsWith("@@") ? "diff-hunk" : "")}, line || " ")) : "No staged changes. Use Changes to stage files.",
                      ),
                      h("textarea", {
                        "aria-label": "Commit message",
                        placeholder: "Describe your changes",
                        value: message,
                        onChange: (e) => setMessage(e.target.value),
                        disabled: busy,
                      }),
                    )
                  : review.kind === "push"
                    ? h(
                        "p",
                        null,
                        "Commit " +
                          review.data.head.slice(0, 12) +
                          " → " +
                          review.data.push.destination +
                          " · " +
                          review.data.push.target,
                      )
                    : h(
                        "p",
                        null,
                        "Switch to " +
                          review.branch +
                          "? Git will preserve changes or refuse if they would be overwritten.",
                      ),
                error ? h("p", { role: "alert" }, error) : null,
                h(
                  "footer",
                  null,
                  h(
                    "button",
                    { disabled: busy, onClick: () => setReview(null) },
                    "Cancel",
                  ),
                  h(
                    "button",
                    {
                      disabled:
                        busy ||
                        (review.kind === "commit" &&
                          (!message.trim() ||
                            !review.data.staged ||
                            review.data.conflicts)),
                      onClick: () =>
                        act(review.kind, {
                          message,
                          branch: review.branch,
                          confirm: review.data.head,
                        }),
                    },
                    busy
                      ? "Working…"
                      : review.kind === "commit"
                        ? "Commit staged"
                        : review.kind === "push"
                          ? "Push commit"
                          : "Switch branch",
                  ),
                ),
              )
            : null,
        ),
      );
    }
    function Inspector(props) {
      const { sessionId, useSessions, useChat, useJobs, useSessionStatus, watchJobs, openChild, refreshChildren, reopenWorkspace } = props;
      const sessions = useSessions((s) => s),
        root = sessions.byId[sessionId]?.cwd;
      const catalog = sessions.projectionsBySession?.[sessionId];
      const statuses = useSessionStatus(s => s);
      const children = catalog?.values.subagentCatalog || [];
      const nodes = useChat(s => s.legacy.nodes);
      const sources = [...new Set((nodes || []).flatMap(node => references((node.blocks || node.content || []).filter(b => b.kind === 'text' || b.type === 'text').map(b => b.text).join('\n'))).map(path => path.startsWith('/') ? path : root ? root + '/' + path : null).filter(path => path && sourceName(path)))].slice(-12);
      const jobs = useJobs(s => s.rows[sessionId]) || [];
      useEffect(() => watchJobs(sessionId), [sessionId, watchJobs]);
      const [open, setOpen] = useState(() => {
          try {
            return localStorage.getItem("dsh.inspector") !== "closed";
          } catch {
            return true;
          }
        }),
        [mount, setMount] = useState(null),
        [overlay, setOverlay] = useState(false), [drawerOpen, setDrawerOpen] = useState(false),
        [files, setFiles] = useState(false), [initialPath, setInitialPath] = useState(null), [computer, setComputer] = useState(false), [setup, setSetup] = useState(false);
      const setupDialog = useRef(null);
      useEffect(() => { if(setup&&!setupDialog.current.open)setupDialog.current.showModal();else if(!setup&&setupDialog.current.open)setupDialog.current.close(); },[setup]);
      const computerDialog = useRef(null);
      useEffect(() => { if(computer&&!computerDialog.current.open)computerDialog.current.showModal();else if(!computer&&computerDialog.current.open)computerDialog.current.close(); },[computer]);
      useEffect(() => { refreshChildren(sessionId); },[sessionId,refreshChildren]);
      const visible = overlay ? drawerOpen : open;
      const trigger = useRef(null),
        dialog = useRef(null);
      useEffect(() => {
        const root = trigger.current?.closest("[data-phase]");
        if (!root) return;
        const node = document.createElement("div");
        node.className = "dshd-inspector-mount";
        root.appendChild(node);
        setMount(node);
        const header = root.querySelector('header');
        let previous;
        const measure = () => {
          const narrow = root.clientWidth < 900;
          if (previous !== narrow) { setOverlay(narrow); setDrawerOpen(false); previous = narrow; }
          root.setAttribute('data-dsh-inspector-layout', narrow ? 'overlay' : 'docked');
          root.style.setProperty('--dshd-header-height', (header?.offsetHeight || 64) + 8 + 'px');
        };
        const observer = new ResizeObserver(measure);
        observer.observe(root); if (header) observer.observe(header); measure();
        return () => {
          observer.disconnect();
          root.removeAttribute('data-dsh-inspector-layout');
          root.style.removeProperty('--dshd-header-height');
          root.removeAttribute("data-dsh-inspector-open");
          node.remove();
        };
      }, []);
      useEffect(() => {
        const root = mount?.parentElement;
        if (!root) return;
        if (visible) root.setAttribute("data-dsh-inspector-open", "");
        else root.removeAttribute("data-dsh-inspector-open");
        mount.hidden = !visible;
        try {
          localStorage.setItem("dsh.inspector", open ? "open" : "closed");
        } catch {}
      }, [open, visible, mount]);
      useEffect(() => { if (!overlay || !drawerOpen) return; const escape=e=>{if(e.key === "Escape"){setDrawerOpen(false);trigger.current?.focus();}};window.addEventListener("keydown",escape);return()=>window.removeEventListener("keydown",escape); },[overlay,drawerOpen]);
      useEffect(() => {
        if (files && !dialog.current.open) dialog.current.showModal();
        else if (!files && dialog.current.open) dialog.current.close();
      }, [files]);
      // A heading over the words "nothing here" costs the same height as real
      // content and carries none. Callers pass a message for states worth
      // reading - loading, or a failure - and null for a settled empty list,
      // which drops the section until it has something to say.
      const section = (title, rows, empty) =>
        rows.length || empty
          ? h(
              "section",
              null,
              h("h3", null, title),
              rows.length ? rows : h("p", { className: "note" }, empty),
            )
          : null;
      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            ref: trigger,
            type: "button",
            className: "dshd-inspector-toggle",
            "aria-label": "Session sidebar",
            "aria-expanded": visible,
            title: visible ? "Close session sidebar" : "Open session sidebar",
            onClick: () => overlay ? setDrawerOpen(!drawerOpen) : setOpen(!open),
          },
          h(Icon, { name: "panel" }),
          h("span", null, "Sidebar"),
        ),
        mount && visible
          ? createPortal(
              h(
                "aside",
                {
                  className: "dshd-inspector",
                  "aria-label": "Session sidebar",
                },
                h("button", {type:"button",className:"dshd-inspector-close","aria-label":"Close session sidebar",onClick:()=>{setDrawerOpen(false);trigger.current?.focus();}}, h("span", null, "Session details"), h(Icon, {name:"close"})),
                h(Git, { key: root, root, reopenWorkspace, onFiles: () => setFiles(true) }),
                h(
                  "details",
                  null,
                  h("summary", null, "Session usage"),
                  h(SessionMetrics, props),
                ),
                section(
                  "Subagents",
                  children.map((s) =>
                    h(
                      "button",
                      {
                        className: "row",
                        key: s.id,
                        onClick: () => openChild({parentSessionId:sessionId,childSessionId:s.id,mode:s.mode}),
                      },
                      h(Icon, { name: "agent" }),
                      h("span", null, s.label || "Subagent"),
                      h("small", null, (statuses.get(s.id)?.running ?? sessions.byId[s.id]?.running) ? "Running" : "Open"),
                      h(Icon, { name: "chevron", className: "go" }),
                    ),
                  ),
                  catalog?.state === "error" ? "Could not load subagents." : !catalog || catalog.state === "loading" ? "Loading subagents…" : null,
                ),
                section(
                  "Background processes",
                  jobs.map((j) =>
                    h(
                      "div",
                      {
                        className: "row",
                        key: j.id,
                        title: j.detail || j.label,
                      },
                      h(Icon, { name: "terminal" }),
                      h("span", null, j.label || j.kind),
                      h(
                        "small",
                        {
                          className:
                            j.status === "failed"
                              ? "bad"
                              : j.status === "running"
                                ? "warn"
                                : "good",
                        },
                        j.status,
                      ),
                    ),
                  ),
                  null,
                ),
                // The heading labels a list of sources. With no sources there
                // is no list to label, and a heading over a lone "Browse"
                // action is a label for something that isn't there — so the
                // action stays and the heading is what goes.
                h(
                  "section",
                  null,
                  sources.length ? h("h3", null, "Sources & files") : null,
                  sources.slice(0,3).map(path => h('button', {key:path,className:'row',title:path,onClick:()=>{setInitialPath(path);setFiles(true)}},h(Icon,{name:'file'}),h('span',null,sourceName(path)),h(Icon,{name:'chevron',className:'go'}))),
                  h(
                    "button",
                    { className: "row browse", onClick: () => {setInitialPath(null);setFiles(true)} },
                    h(Icon, { name: "folder" }),
                    h("span", null, sources.length > 3 ? "View all files" : "Browse workspace files"),
                    h(Icon, { name: "chevron", className: "go" }),
                  ),
                ),
                h("details",null,h("summary",null,"Workspace tools"),
                  h("button",{className:"row",onClick:()=>setSetup(true)},h(Icon,{name:"local"}),h("span",null,"Development setup")),
                  h("button",{className:"row",onClick:()=>setComputer(true)},h(Icon,{name:"local"}),h("span",null,"Computer controls",h(ComputerUseStatus,{sessionId})))),
              ),
              mount,
            )
          : null,
        h('dialog',{ref:setupDialog,className:'dshd-inspector-review dshd-setup-dialog','aria-label':'Development setup',onCancel:()=>setSetup(false),onClose:()=>setSetup(false)},h('header',{className:'dshd-dialog-header'},h('h2',null,'Workspace setup'),h('button',{'aria-label':'Close development setup',onClick:()=>setSetup(false)},'Close')),h('div',{className:'dshd-dialog-body'},setup?h(SetupPanel,{initialRoot:root,embedded:true}):null)),
        h('dialog',{ref:computerDialog,className:'dshd-inspector-review','aria-label':'Computer controls',onCancel:()=>setComputer(false),onClose:()=>setComputer(false)},h('header',{className:'dshd-dialog-header'},h('h2',null,'Computer controls'),h('button',{'aria-label':'Close computer controls',onClick:()=>setComputer(false)},'Close')),h('div',{className:'dshd-dialog-body'},computer?h(ComputerUsePanel,{sessionId}):null)),
        h(
          "dialog",
          {
            ref: dialog,
            className: "dshd-inspector-review",
            "aria-label": "Workspace files",
            onCancel: () => setFiles(false),
            onClose: () => setFiles(false),
          },
          h(
            "footer",
            null,
            h("button", { onClick: () => setFiles(false) }, "Back to session"),
          ),
          files
            ? h(
                "div",
                { className: "file-body" },
                h(FilesView, {
                  initialPath,
                  standalone: true,
                  active: files,
                  sessionId,
                  useSessions,
                }),
              )
            : null,
        ),
      );
    }
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "desktop inspector style");
      ctx.slots.inject("conversation.session.header.actions", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "desktop-inspector",
            order: 100,
            inject: () => ({ hooks: { jobs: ctx.jobs.state, sessionStatus: ctx.uiSession.sessionStatus },
              watchJobs: id => ctx.jobs.watchRows(id), openChild: address => ctx.uiWorkspace.openSession(address),
              refreshChildren: id => ctx.sessions.refreshProjections(id), reopenWorkspace: path => ctx.workspaces.create({path}) }),
          },
          Inspector,
        ),
      );
    }
    return { apply, inject: ["slots", "sessions", "workspaces", "uiWorkspace", "uiSession", "jobs"] };
  },
});
