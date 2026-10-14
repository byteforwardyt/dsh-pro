window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-media",
  factory: (require) => {
    const React = require("react"),
      { useState, useEffect, useRef } = React,
      h = React.createElement;
    const family = (path) =>
      /\.(mp4|mov|webm|m4v|mkv|ogv)$/i.test(path)
        ? "video"
        : /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus)$/i.test(path)
          ? "audio"
          : /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(path)
            ? "image"
            : /\.pdf$/i.test(path)
              ? "pdf"
              : "file";
    const raw = (path) => "/dsh-files/raw?path=" + encodeURIComponent(path);
    const label = (path) => path.split("/").at(-1);
    // Accept explicit local paths only. External media is never fetched automatically.
    function references(text) {
      const out = [];
      for (const match of String(text || '').matchAll(/\]\((?:<([^<>\n]+)>|([^()\n]+))\)|`([^`\n]+)`/g)) {
        let path = match[1] || match[2] || match[3];
        if (match[1] || match[2]) { try { path = decodeURIComponent(path); } catch { continue; } }
        if (path.includes('\0') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) continue;
        if (family(path) !== 'file' && (path.startsWith('/') || !path.startsWith('../'))) out.push(path);
      }
      return [...new Set(out)].slice(0,20);
    }
    const draftReferences = (text) =>
      [
        ...String(text || "").matchAll(
          /\[Attachment: [^\n]*?\]\(<([^<>\n]+)>\)/g,
        ),
      ]
        .map((m) => {
          try {
            return { path: decodeURIComponent(m[1]), token: m[0] };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    const encodedPath = (path) =>
      path.split("/").map(encodeURIComponent).join("/");
    function absoluteMediaPath(path, root) {
      if (typeof path !== 'string' || family(path) === 'file') return null;
      const absolute = path.startsWith('/') ? path : root && root.startsWith('/') ? root.replace(/\/+$/, '') + '/' + path : null;
      if (!absolute) return null;
      const parts = [];
      for (const part of absolute.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') parts.pop();
        else parts.push(part);
      }
      return '/' + parts.join('/');
    }
    function resolvedMediaPaths(paths, root) {
      return [...new Set(paths.map((path) => absoluteMediaPath(path, root)).filter(Boolean))].slice(0, 12);
    }
    // One mark per kind of failure, because "cannot show this" covers four very
    // different situations: a closed folder for access, a struck-through file
    // for a path that no longer resolves, an eye with a slash for a file that
    // is there but will not decode, a warning for a fault we could not
    // classify, and a clock while the check is still in flight.
    const STATE_MARKS = {
      checking: "M12 3a9 9 0 1 0 9 9M12 7v5l3.5 2",
      denied: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
      missing: "M4 3h10l6 6v12H4Zm10 0v6h6M3 2l18 20",
      unavailable: "M12 4 2.5 20h19ZM12 10v4m0 3h.01",
      decode: "M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Zm9-2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM3 3l18 18",
    };
    const HEVC_MARKS = ["hvc1", "hev1", "dvh1", "hvcC"].map((code) =>
      Uint8Array.from([...code].map((ch) => ch.charCodeAt(0))),
    );
    function containsHevcMark(bytes) {
      const hay = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
      for (let i = 0; i <= hay.length - 4; i += 1) {
        for (const needle of HEVC_MARKS) {
          if (hay[i] === needle[0] && hay[i + 1] === needle[1] && hay[i + 2] === needle[2] && hay[i + 3] === needle[3]) return true;
        }
      }
      return false;
    }
    async function probeHevc(url, signal) {
      try {
        const response = await fetch(url, {
          method: "GET",
          credentials: "same-origin",
          headers: { Range: "bytes=0-65535" },
          signal,
        });
        if (!response.ok) return false;
        return containsHevcMark(await response.arrayBuffer());
      } catch {
        return false;
      }
    }
    const StateMark = ({ status }) =>
      h(
        "svg",
        {
          width: 26,
          height: 26,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.4,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        h("path", { d: STATE_MARKS[status] || STATE_MARKS.unavailable }),
      );
    const CSS = `.dshd-attach-button{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;background:transparent;border:0;border-radius:7px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease}.dshd-attach-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshd-attach-button:disabled{opacity:.5}.dshd-media-error{color:var(--dshd-bad);font-size:12px}.dshd-media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));gap:12px;margin:16px 0;max-width:100%}.dshd-media-card{display:flex;flex-direction:column;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);min-width:0;transition:border-color .12s ease}.dshd-media-card figcaption{margin-top:auto}.dshd-media-card:hover{border-color:var(--dsw-alias-border-l3)}.dshd-media-card figcaption{display:flex;align-items:center;gap:10px;padding:9px 12px;font-size:12px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--dsw-alias-border-l1)}.dshd-media-card figcaption>span{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.dshd-media-card a{flex:none;padding:4px 8px;border-radius:7px;color:var(--dsw-alias-label-tertiary);font-size:11px;text-decoration:none;transition:background-color .12s ease,color .12s ease}.dshd-media-card a:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshd-media-card img,.dshd-media-card video{display:block;width:100%;max-height:360px;object-fit:contain;background:#0000000a}.dshd-media-card audio{display:block;width:calc(100% - 24px);margin:12px}.dshd-media-card iframe{display:block;width:100%;height:400px;border:0}.dshd-media-card p{font-size:12px;line-height:1.6;padding:0 12px;color:var(--dsw-alias-label-secondary)}.dshd-media-state{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:30px 16px;text-align:center}.dshd-media-state p{margin:0;padding:0;max-width:38ch}.dshd-media-state svg{color:var(--dsw-alias-label-tertiary)}.dshd-media-card[data-status=denied] .dshd-media-state svg,.dshd-media-card[data-status=decode] .dshd-media-state svg{color:var(--dshd-warn)}.dshd-media-card[data-status=missing] .dshd-media-state svg,.dshd-media-card[data-status=unavailable] .dshd-media-state svg{color:var(--dshd-bad)}.dshd-media-rail{display:flex;gap:8px;overflow-x:auto;overscroll-behavior-x:contain;max-width:800px;margin:8px auto;padding:0 16px;-webkit-mask-image:linear-gradient(90deg,transparent,#000 16px,#000 calc(100% - 16px),transparent);mask-image:linear-gradient(90deg,transparent,#000 16px,#000 calc(100% - 16px),transparent)}.dshd-media-draft{display:flex;gap:6px;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:4px 5px 4px 10px;font-size:11px;white-space:nowrap;background:var(--dsw-alias-bg-layer-1);transition:border-color .12s ease}.dshd-media-draft:hover{border-color:var(--dsw-alias-border-l3)}.dshd-media-draft button{background:transparent;border:0;color:inherit;cursor:pointer;font:inherit;padding:0}.dshd-media-draft button+button{display:grid;place-items:center;width:19px;height:19px;border-radius:6px;color:var(--dsw-alias-label-tertiary);transition:background-color .12s ease,color .12s ease}.dshd-media-draft button+button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dshd-media-draft span{max-width:180px;overflow:hidden;text-overflow:ellipsis}.dshd-media-dialog{width:min(860px,calc(100vw - 32px));max-height:85dvh;padding:16px;border:1px solid var(--dsw-alias-border-l3);border-radius:16px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);-webkit-app-region:no-drag}.dshd-media-dialog::backdrop{background:#0008}.dshd-media-dialog>button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 14px;background:transparent;cursor:pointer}.dshd-media-dialog figure{margin-top:12px}.dshd-media-dialog:not([open]){display:none}.dshd-media-card :focus-visible,.dshd-media-draft :focus-visible,.dshd-attach-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}@media(prefers-reduced-motion:reduce){.dshd-media-card,.dshd-media-card a,.dshd-media-draft,.dshd-media-draft button,.dshd-attach-button{transition:none}}`;
    function MediaCard({ path, workspaceRoot, reopenWorkspace, onOpen }) {
      const [state, setState] = useState({path,status:'checking'}),
        [attempt, setAttempt] = useState(0),
        [opening, setOpening] = useState(false),
        generation = useRef(0),
        kind = family(path);
      const url = raw(path);
      useEffect(() => {
        const controller=new AbortController(), version=++generation.current;
        const timer=setTimeout(()=>controller.abort(),8000);
        const update=(status)=>{
          if (version===generation.current) setState({path,status,version});
        };
        setOpening(false);update('checking');
        fetch(url,{method:'HEAD',credentials:'same-origin',signal:controller.signal})
          .then(response=>update(response.ok?'ready':response.status===403?'denied':response.status===404?'missing':'unavailable'))
          .catch(()=>update('unavailable')).finally(()=>clearTimeout(timer));
        return()=>{generation.current++;controller.abort();clearTimeout(timer)};
      },[path,attempt]);
      const status=state.path===path?state.status:'checking';
      const canReopen=status==='denied' && typeof reopenWorkspace==='function'
        && workspaceRoot?.startsWith('/') && workspaceRoot!=='/'
        && path.startsWith(workspaceRoot.replace(/\/+$/,'')+'/');
      async function reopen() {
        if (opening || !canReopen) return;
        const version=generation.current;setOpening(true);
        try {
          await reopenWorkspace(workspaceRoot);
          if (version===generation.current) setAttempt(n=>n+1);
        } catch (error) {
          if (version===generation.current) setState({path,status:'denied',version,message:error.message || 'Could not reopen this workspace.'});
        } finally { if (version===generation.current) setOpening(false); }
      }
      const mediaFailed=()=>{
        const version=generation.current;
        if (state.version!==version) return;
        setState({...state,status:'decode'});
        if (kind!=='video') return;
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),4000);
        probeHevc(url,controller.signal).then((hevc)=>{
          clearTimeout(timer);
          if (hevc && generation.current===version) setState((current)=>current.path===path && current.status==='decode' ? {...current,hevc:true} : current);
        });
      };
      const messages={
        checking:'Checking file…',
        denied:'This workspace is closed or the file is outside the opened workspace. Reopen its project folder to preview it.',
        missing:'This file was moved, deleted, or is no longer available at this path.',
        unavailable:'Could not load this file. Check the app connection and retry.',
        decode: state.hevc
          ? 'This video uses HEVC, which this app cannot play. Download it to open in QuickTime or another player.'
          : 'This file could not be previewed. Retry, or download it to open with another app.',
      };
      return h(
        "figure",
        { className: "dshd-media-card", "data-status": status },
        // A file that cannot be shown is a state, not a stray sentence: the
        // mark says which kind of problem it is, the sentence says what
        // happened, and the actions sit under both on the same centred axis.
        status !== 'ready'
          ? h(
              "div",
              { className: "dshd-media-state" },
              h(StateMark, { status }),
              h("p", { role: "status" }, state.message || messages[status]),
              status !== 'checking' ? h('div',{className:'dshd-media-recovery'},
                canReopen ? h('button',{type:'button',title:workspaceRoot,disabled:opening,onClick:reopen},opening?'Opening…':'Reopen workspace') : null,
                h('button',{type:'button',disabled:opening,onClick:()=>setAttempt(n=>n+1)},'Retry')) : null,
            )
          : kind === "video" || kind === "audio"
            ? h(kind, {
                src: url,
                controls: true,
                preload: "auto",
                playsInline: true,
                onError: mediaFailed,
              })
            : kind === "image"
              ? onOpen
                ? h('button', {type:'button',className:'dshd-media-image-button',onClick:()=>onOpen(path),'aria-label':'View '+label(path)+' larger in chat'},
                    h("img", {src:url,alt:label(path),loading:"lazy",onError:mediaFailed}))
                : h("img", {src:url,alt:label(path),loading:"lazy",onError:mediaFailed})
              : kind === "pdf"
                ? h("iframe", { src: url, title: label(path) })
                : h("p", null, "File attachment · download to open."),
        h(
          "figcaption",
          null,
          h("span", { title: path }, label(path)),
          status==='ready'||status==='decode' ? h("a", { href: url, download: label(path) }, "Download") : null,
        ),
      );
    }
    function DraftRail({ useInput, inputActions, useSessions, sessionId, reopenWorkspace }) {
      const workspaceRoot=useSessions(s=>s.byId[sessionId]?.cwd);
      const input = useInput((s) => s),
        entries = draftReferences(input?.draft),
        [preview, setPreview] = useState(null),
        dialog = useRef(null);
      useEffect(() => {
        if (preview && !dialog.current.open) dialog.current.showModal();
        else if (!preview && dialog.current.open) dialog.current.close();
      }, [preview]);
      return h(
        React.Fragment,
        null,
        entries.length
          ? h(
              "div",
              { className: "dshd-media-rail", "aria-label": "Attached files" },
              entries.map(({ path, token }) =>
                h(
                  "div",
                  { className: "dshd-media-draft", key: path },
                  h(
                    "button",
                    {
                      title: "Preview " + label(path),
                      onClick: () => setPreview(path),
                    },
                    h("span", null, label(path)),
                  ),
                  h(
                    "button",
                    {
                      "aria-label": "Remove " + label(path),
                      onClick: () =>
                        inputActions.setDraft(input.draft.replace(token, "")),
                    },
                    "×",
                  ),
                ),
              ),
            )
          : null,
        h(
          "dialog",
          {
            ref: dialog,
            className: "dshd-media-dialog",
            "aria-label": "Attachment preview",
            onCancel: () => setPreview(null),
            onClose: () => setPreview(null),
          },
          h("button", { onClick: () => setPreview(null) }, "Back to message"),
          preview ? h(MediaCard, { path: preview, workspaceRoot, reopenWorkspace }) : null,
        ),
      );
    }
    function Attach({
      sessionId,
      useSessions,
      useInput,
      inputActions,
      blocks,
    }) {
      const root = useSessions((s) => s.byId[sessionId]?.cwd),
        input = useInput((s) => s),
        latest = useRef(input),
        picker = useRef(null),
        button = useRef(null),
        pending = useRef(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState("");
      latest.current = input;
      useEffect(() => () => pending.current?.abort(), [sessionId, root]);
      async function upload(files) {
        if (!root || pending.current) return;
        const previousBlock = blocks.storeFor(sessionId).getSnapshot();
        if (previousBlock) {
          setError(previousBlock.reason);
          return;
        }
        const block = { reason: "Uploading attachments…" };
        blocks.set(sessionId, block);
        const release = () => {
          if (blocks.storeFor(sessionId).getSnapshot()?.reason === block.reason)
            blocks.set(sessionId, undefined);
        };
        const controller = new AbortController();
        pending.current = controller;
        setBusy(true);
        setError("");
        try {
          for (const file of files) {
            if (file.size > 100 * 1024 * 1024)
              throw Error(file.name + " exceeds the 100 MB limit.");
            const r = await fetch(
              "/dsh-files/upload?root=" +
                encodeURIComponent(root) +
                "&name=" +
                encodeURIComponent(file.name),
              {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": "application/octet-stream" },
                body: file,
                signal: controller.signal,
              },
            );
            const data = await r.json();
            if (!r.ok) throw Error(data.error || "Upload failed.");
            if (controller.signal.aborted) return;
            const before = latest.current.draft || "";
            const safeName = file.name.replace(/[\[\]<>\r\n]/g, "_");
            const draft = before +
                "\n[Attachment: " +
                safeName +
                "](<" +
                encodedPath(data.path) +
                ">)";
            inputActions.setDraft(draft);
            latest.current = { ...latest.current, draft };
          }
        } catch (e) {
          if (!controller.signal.aborted) setError(e.message);
        } finally {
          release();
          if (pending.current === controller) {
            pending.current = null;
            setBusy(false);
          }
        }
      }
      useEffect(() => {
        const area = button.current?.closest("[data-phase]");
        if (!area) return;
        const drop = (e) => {
          const files = [...(e.dataTransfer?.files || [])];
          if (!files.length || files.every((f) => f.type.startsWith("image/")))
            return;
          e.preventDefault();
          e.stopImmediatePropagation();
          upload(files);
        };
        const drag = (e) => {
          if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
        };
        area.addEventListener("drop", drop, true);
        area.addEventListener("dragover", drag, true);
        return () => {
          area.removeEventListener("drop", drop, true);
          area.removeEventListener("dragover", drag, true);
        };
      }, [root, sessionId]);
      return h(
        React.Fragment,
        null,
        h(
          "button",
          {
            ref: button,
            type: "button",
            className: "dshd-attach-button",
            disabled: !root || busy,
            title:
              "Add files to this workspace and reference them in your message · up to 100 MB each",
            "aria-label": "Attach files",
            onClick: () => picker.current.click(),
          },
          h(
            "svg",
            {
              width: 16,
              height: 16,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.6,
              "aria-hidden": true,
            },
            h("path", {
              d: "m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2m-3 14 7-7",
            }),
          ),
          busy ? "Uploading…" : "Attach",
        ),
        h("input", {
          ref: picker,
          type: "file",
          multiple: true,
          hidden: true,
          onChange: (e) => {
            const files = [...e.target.files];
            e.target.value = "";
            upload(files);
          },
        }),
        busy ? h('button', {type:'button',className:'dshd-attach-button',onClick:()=>pending.current?.abort()}, 'Cancel upload') : null,
        error
          ? h("span", { className: "dshd-media-error", role: "alert" }, error)
          : null,
      );
    }
    const definition = {
      kind: "desktop-media",
      match: (event) =>
        event.type === "turn/start"
          ? { id: String(event.data.turn), role: "start" }
          : event.type === "assistant/message"
            ? { id: String(event.data.turn), role: "update" }
            : null,
      start: (_c, m) => ({ turn: m.event.data.turn, paths: [] }),
      update: (c, m) => ({
        ...c.state,
        paths: [
          ...c.state.paths,
          ...references(
            m.event.data.message?.content
              ?.filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n"),
          ).map((path) => ({ path, seq: m.event.seq })),
        ],
      }),
      buildLocationData: (c, scope) =>
        scope !== "turn" || !c.state
          ? null
          : {
              kind: "turn",
              turn: c.state.turn,
              key: "desktop-media",
              value: { paths: c.state.paths },
            },
    };
    function selectMedia(owner) {
      const paths = [
        ...(owner.turn.data.get("desktop-media")?.paths || []),
        ...(owner.turn.data.get("deliverables")?.produced || []),
      ]
        .filter((p) => p.seq <= owner.seq)
        .map((p) => p.path)
        .filter((path) => family(path) !== 'file');
      return paths.length ? [...new Set(paths)] : null;
    }
    function Output(props) {
      const { useSessions, sessionId, reopenWorkspace } = props;
      // 0.2 turnTail is a list slot: it passes the owner, not `matched`.
      const matched = selectMedia(props) || [];
      const root = useSessions((s) => s.byId[sessionId]?.cwd);
      const paths = resolvedMediaPaths(matched, root);
      const [preview, setPreview] = useState(null);
      const dialog = useRef(null);
      useEffect(() => {
        if (preview && !dialog.current.open) dialog.current.showModal();
        else if (!preview && dialog.current.open) dialog.current.close();
      }, [preview]);
      return h(
        React.Fragment,
        null,
        paths.length ? h("div",{className:"dshd-media-grid"},paths.map((path) =>
          h(MediaCard,{key:path,path,workspaceRoot:root,reopenWorkspace,onOpen:setPreview}))) : null,
        h('dialog',{ref:dialog,className:'dshd-media-dialog dshd-media-lightbox','aria-label':'Image preview',onCancel:()=>setPreview(null),onClose:()=>setPreview(null)},
          h('button',{type:'button',onClick:()=>setPreview(null)},'Back to message'),
          preview ? h(MediaCard,{path:preview,workspaceRoot:root,reopenWorkspace}) : null),
      );
    }
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = CSS + '.dshd-media-recovery{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;padding:0}.dshd-media-recovery button{font:inherit;font-size:11px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color .12s ease,border-color .12s ease}.dshd-media-recovery button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-tertiary)}.dshd-media-recovery button:disabled{opacity:.5;cursor:default}.dshd-media-image-button{display:block;width:100%;padding:0;border:0;background:transparent;cursor:zoom-in}.dshd-media-image-button img{width:100%}.dshd-media-image-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:-3px}.dshd-media-lightbox{width:min(1200px,calc(100vw - 32px));max-height:90dvh;overflow:auto}.dshd-media-lightbox .dshd-media-card img{max-height:calc(90dvh - 110px)}';
        document.head.appendChild(style);
        return () => style.remove();
      }, "desktop media styles");
      ctx.uiConversation.events.register(definition);
      ctx.slots.inject("conversation.input.left", () =>
        ctx.slots.register(
          {
            name: "conversation.input.left",
            id: "desktop-attachments",
            order: -10,
            inject: () => ({ blocks: ctx.conversation.blocks }),
          },
          Attach,
        ),
      );
      ctx.slots.inject("conversation.input.dock", () =>
        ctx.slots.register(
          {
            name: "conversation.input.dock",
            id: "desktop-attachment-rail",
            order: -10,
            inject: () => ({reopenWorkspace:path=>ctx.workspaces.create({path})}),
          },
          DraftRail,
        ),
      );
      ctx.slots.inject("conversation.chat.turnTail", () =>
        ctx.slots.register(
          {
            name: "conversation.chat.turnTail",
            id: "desktop-media",
            priority: 20,
            select: selectMedia,
            inject: () => ({reopenWorkspace:path=>ctx.workspaces.create({path})}),
          },
          Output,
        ),
      );
    }
    return {
      apply,
      inject: ["slots", "uiConversation", "conversation", "workspaces"],
      references,
      draftReferences,
      family,
      selectMedia,
      absoluteMediaPath,
      resolvedMediaPaths,
    };
  },
});
