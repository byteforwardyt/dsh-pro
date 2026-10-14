/**
 * Files view — browser half.
 *
 * A file browser, editor and media player beside Chat, Trajectory and Preview.
 *
 * The harness does not publish its filesystem to the browser: `ctx.fs` is a
 * complete seam in the host process, and the only file-shaped thing the page
 * can reach is `fileReferences/list`, which returns twenty relative paths with
 * no metadata because it backs `@file` autocomplete. So this view talks to
 * `@dsh-desktop/host-files-api` on `/dsh-files` instead.
 *
 * Two constraints from the app's own CSP shape what is drawn here:
 *   - `media-src` is `'self' blob:`. Audio and video still point at a real
 *     URL on this origin so Range seeking works; blob: is not used as a
 *     substitute for the byte route.
 *   - `object-src 'none'` rules out <embed>/<object>, so a PDF is framed.
 *
 * Highlighting is the page's own shiki, reached through the CodeBlock primitive
 * rather than by bundling a second highlighter. Editing uses that same renderer
 * beneath a native text field, preserving selection, input methods and undo.
 * Both layers use the current draft and identical typography. The primitives
 * module is an undocumented seed with no typings: when it moves, this degrades
 * to an uncoloured <pre> instead of a blank pane.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/client-ui-files",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useRef, useCallback, useEffect, useMemo, useSyncExternalStore } = React;
    const h = React.createElement;

    const API = "/dsh-files";
    const LAST_FILE = "dshd.files.last";
    const LAST_ROOT = "dshd.files.root";

    // Fast editor state stays in memory; private host backups survive restarts.
    // Neither file contents nor backup contents go into browser localStorage.
    const FILE_MEMORY = { docs: {}, drafts: {}, pending: {}, backups: {} };
    const fileListeners = new Set();
    const subscribeFiles = (listener) => { fileListeners.add(listener); return () => fileListeners.delete(listener); };
    function useFileState(key) {
      const value = useSyncExternalStore(subscribeFiles, () => FILE_MEMORY[key]);
      const update = useCallback((next) => {
        FILE_MEMORY[key] = typeof next === "function" ? next(FILE_MEMORY[key]) : next;
        fileListeners.forEach((listener) => listener());
      }, [key]);
      return [value, update];
    }

    const backupJobs = new Map();
    function backupState(path, change) {
      FILE_MEMORY.backups = { ...FILE_MEMORY.backups,
        [path]: { ...FILE_MEMORY.backups[path], ...change } };
      fileListeners.forEach((listener) => listener());
    }
    // Coalesce edits behind one request per file. Capture text AND its baseline
    // together; a file save may advance the baseline while this request runs.
    function queueBackup(path) {
      const base = FILE_MEMORY.docs[path];
      if (base?.kind !== "text") return;
      const text = FILE_MEMORY.drafts[path];
      const snapshot = text !== undefined && text !== base.text
        ? { text, base: { text: base.text, version: base.version } } : null;
      let job = backupJobs.get(path);
      if (!job) { job = { running: false }; backupJobs.set(path, job); }
      job.next = snapshot;
      job.queued = true;
      if (job.running) return;
      if (FILE_MEMORY.pending[path] === "discard") return;
      if (!FILE_MEMORY.backups[path]?.loaded) return;
      job.running = true;
      backupState(path, { state: "saving", error: null });
      (async () => {
        try {
          let last = null;
          while (job.queued) {
            const draft = job.next;
            last = draft;
            job.queued = false;
            const result = await api("/draft", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ path, draft, revision: FILE_MEMORY.backups[path].revision }),
            });
            backupState(path, { revision: result.revision });
          }
          backupState(path, { state: last === null ? "idle" : "saved" });
        } catch (error) {
          backupState(path, { state: "error", error: error.message });
        } finally {
          job.running = false;
        }
      })();
    }

    async function readBackup(path) {
      if (FILE_MEMORY.backups[path]?.loaded) return null;
      try {
        const result = await api("/draft?path=" + encodeURIComponent(path));
        backupState(path, { loaded: true, revision: result.draft?.revision ?? null,
          state: result.draft ? "saved" : "idle", error: null });
        return result.draft;
      } catch (error) {
        backupState(path, { loaded: false, state: "error", error: error.message });
        return null;
      }
    }

    async function retryBackup(path) {
      if (!FILE_MEMORY.backups[path]?.loaded) {
        try {
          const result = await api("/draft?path=" + encodeURIComponent(path));
          const existing = result.draft;
          // A failed initial read must not become permission to replace a backup
          // we never showed. Matching records can follow a lost HTTP response.
          if (existing && (existing.text !== FILE_MEMORY.drafts[path]
            || existing.base.version !== FILE_MEMORY.docs[path]?.version
            || existing.base.text !== FILE_MEMORY.docs[path]?.text)) {
            throw new Error("A different saved draft already exists. It has been preserved for recovery when you reopen the app");
          }
          backupState(path, { loaded: true, revision: existing?.revision ?? null });
        } catch (error) {
          backupState(path, { state: "error", error: error.message });
          return;
        }
      }
      queueBackup(path);
    }

    /* ── File-type marks ───────────────────────────────────────────────────
     * One drawing system, not a grab-bag: every glyph is a 24x24 stroke icon
     * sharing the same document silhouette, so a directory listing reads as one
     * set rather than a row of clashing logos. The type is carried by what sits
     * inside the page outline plus a colour, so the eye can sort a long list by
     * hue before it reads a single filename.
     *
     * Deliberately not brand logos. A folder of JS, TS and JSON should look like
     * three documents, not three advertisements — and vendor marks would clash
     * with the provider marks the Accounts panel legitimately uses to identify
     * who you are signed in to.
     */
    const PAGE = "M6 3.6h7.2L18.6 9v11.4a1.8 1.8 0 0 1-1.8 1.8H6a1.8 1.8 0 0 1-1.8-1.8V5.4A1.8 1.8 0 0 1 6 3.6Z";
    const FOLD = "M13.2 3.6V9h5.4";

    const TYPES = {
      folder: { whole: "M3.2 6.6a1.8 1.8 0 0 1 1.8-1.8h3.9l2 2h7.9a1.8 1.8 0 0 1 1.8 1.8v8.8a1.8 1.8 0 0 1-1.8 1.8H5a1.8 1.8 0 0 1-1.8-1.8Z", hue: "#7aa2f7" },
      folderOpen: { whole: "M3.2 6.6a1.8 1.8 0 0 1 1.8-1.8h3.9l2 2h7.9a1.8 1.8 0 0 1 1.8 1.8v1.4H3.2Z M3.4 10h17.4l-1.9 8a1.8 1.8 0 0 1-1.75 1.4H5.05A1.8 1.8 0 0 1 3.3 18Z", hue: "#7aa2f7" },
      // Markup: angle brackets.
      html: { body: "M9.4 12.6 7.6 14.4l1.8 1.8 M14.2 12.6l1.8 1.8-1.8 1.8", hue: "#e5834a" },
      // Stylesheet: a droplet, for paint.
      css: { body: "M11.8 12.2c1.6 1.7 2.6 2.9 2.6 4.1a2.6 2.6 0 0 1-5.2 0c0-1.2 1-2.4 2.6-4.1Z", hue: "#56b6c2" },
      // Script: a terminal caret.
      js: { body: "M8.6 13.2l2 2-2 2 M12.6 17.2h3.2", hue: "#e5c07b" },
      ts: { body: "M8.4 13.4h4 M10.4 13.4v4 M14 17.4c1.4 0 2-.5 2-1.2 0-1.4-2.6-.9-2.6-2.2 0-.6.5-1 1.5-1", hue: "#61afef" },
      // Data: braces.
      json: { body: "M10.4 12.6c-1 0-1.3.5-1.3 1.4s0 1.3-.9 1.3c.9 0 .9.4.9 1.3s.3 1.4 1.3 1.4 M13.4 12.6c1 0 1.3.5 1.3 1.4s0 1.3.9 1.3c-.9 0-.9.4-.9 1.3s-.3 1.4-1.3 1.4", hue: "#98c379" },
      // Prose: text rules.
      md: { body: "M8 13.6h8 M8 16.2h5.4", hue: "#c8ccd4" },
      text: { body: "M8 13.4h8 M8 16h8 M8 18.4h4.6", hue: "#9aa0aa" },
      // Image: horizon and sun.
      image: { body: "M8 17.6l2.4-2.6 1.7 1.8 1.5-1.2 2 2 M9.6 13.2h.01", hue: "#c678dd" },
      // A single eighth note. The two-note version turned to mush at 24px.
      audio: { body: "M14.6 12.4v4.4 M14.6 12.4c1.2.3 1.9 1 2.1 2 M14.6 16.8a1.6 1.6 0 1 1-3.2 0 1.6 1.6 0 0 1 3.2 0Z", hue: "#56b6c2" },
      video: { body: "M10.2 12.8l5 2.9-5 2.9Z", hue: "#e06c75" },
      // A bookmark ribbon, not letters. "PDF" set inside a 24px page is
      // unreadable at list size and clipped at icon size; a shape survives both.
      pdf: { body: "M9.8 12.8h4.4v5.6l-2.2-1.6-2.2 1.6Z", hue: "#e5834a" },
      archive: { body: "M11.4 5v2 M12.6 7v2 M11.4 9v2 M12.6 11v2 M11 14.6h2v2.6h-2Z", hue: "#d19a66" },
      font: { body: "M8.6 17.8l2.6-5.2 2.6 5.2 M9.7 16h3", hue: "#abb2bf" },
      lock: { body: "M9.6 17.8v-2.2a2.4 2.4 0 0 1 4.8 0v2.2Z M8.8 15.6h6.4", hue: "#e5c07b" },
      binary: { body: "M8.6 13.2h1.6v4.4H8.6Z M13.4 13.2H15v4.4h-1.6Z", hue: "#7f8894" },
    };

    /** Extension -> type. */
    const BY_EXT = {
      html: "html", htm: "html", xml: "html", svg: "image", vue: "html", jsx: "js", tsx: "ts",
      css: "css", scss: "css", sass: "css", less: "css",
      js: "js", mjs: "js", cjs: "js", ts: "ts", mts: "ts", cts: "ts",
      json: "json", jsonc: "json", yaml: "json", yml: "json", toml: "json", ini: "json", env: "json",
      md: "md", markdown: "md", mdx: "md", rst: "md",
      txt: "text", log: "text", csv: "text", tsv: "text",
      png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image",
      bmp: "image", ico: "image", icns: "image", tiff: "image",
      mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", flac: "audio", ogg: "audio",
      oga: "audio", opus: "audio",
      mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video", m4v: "video", ogv: "video",
      pdf: "pdf",
      zip: "archive", tar: "archive", gz: "archive", tgz: "archive", bz2: "archive",
      rar: "archive", "7z": "archive", dmg: "archive",
      woff: "font", woff2: "font", ttf: "font", otf: "font", eot: "font",
      pem: "lock", key: "lock", crt: "lock", cer: "lock", p8: "lock", p12: "lock",
      node: "binary", wasm: "binary", so: "binary", dylib: "binary", exe: "binary", bin: "binary",
    };

    /** Filenames that mean more than their extension does. */
    const BY_NAME = {
      "package.json": "json", "tsconfig.json": "ts", ".gitignore": "text",
      license: "text", "readme.md": "md", dockerfile: "text", makefile: "text",
    };

    function classify(name, isDirectory) {
      if (isDirectory) return "folder";
      const lower = String(name || "").toLowerCase();
      if (BY_NAME[lower]) return BY_NAME[lower];
      const dot = lower.lastIndexOf(".");
      if (dot <= 0) return "text";
      return BY_EXT[lower.slice(dot + 1)] || "text";
    }

    /** Families the app renders rather than edits. */
    const MEDIA = { image: 1, audio: 1, video: 1, pdf: 1 };

    /** Shiki language ids, for the read-only highlighted view. */
    const LANGS = {
      html: "html", htm: "html", xml: "xml", vue: "vue", svg: "xml",
      css: "css", scss: "scss", sass: "sass", less: "less",
      js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
      ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
      json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml",
      md: "markdown", markdown: "markdown", mdx: "markdown",
      sh: "shellscript", bash: "shellscript", zsh: "shellscript",
      py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
      c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
      swift: "swift", kt: "kotlin", sql: "sql",
    };

    function languageOf(name) {
      const lower = String(name || "").toLowerCase();
      const dot = lower.lastIndexOf(".");
      if (dot <= 0) return undefined;
      return LANGS[lower.slice(dot + 1)];
    }

    /** One file-type mark. */
    function FileIcon(props) {
      const spec = TYPES[props.type] || TYPES.text;
      const shared = {
        fill: "none",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      };
      const parts = spec.whole
        ? [h("path", Object.assign({ key: "w", d: spec.whole, stroke: spec.hue }, shared))]
        : [
            h("path", Object.assign({ key: "p", d: PAGE, stroke: "currentColor", opacity: 0.42 }, shared)),
            h("path", Object.assign({ key: "f", d: FOLD, stroke: "currentColor", opacity: 0.42 }, shared)),
            h("path", Object.assign({ key: "b", d: spec.body, stroke: spec.hue }, shared)),
          ];
      return h(
        "svg",
        { className: "dshd-fl-icon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
        parts,
      );
    }

    /** A caret for the tree disclosure. */
    function Caret(props) {
      return h(
        "svg",
        {
          className: "dshd-fl-caret" + (props.open ? " is-open" : ""),
          viewBox: "0 0 24 24",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", {
          d: "M9.5 7l5 5-5 5",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    /* ── Toolbar marks ─────────────────────────────────────────────────────
     * Drawn on the same 24x24 stroke grid as the file marks so the bar reads as
     * one set, and monochrome so nothing competes with the file name it sits
     * beside. */
    const TOOLS = {
      sidebar: "M4.6 6.4a1.8 1.8 0 0 1 1.8-1.8h11.2a1.8 1.8 0 0 1 1.8 1.8v11.2a1.8 1.8 0 0 1-1.8 1.8H6.4a1.8 1.8 0 0 1-1.8-1.8Z M9.9 4.6v14.8",
      search: "M10.9 4.8a6.1 6.1 0 1 0 0 12.2 6.1 6.1 0 0 0 0-12.2Z M15.3 15.3 19.4 19.4",
      findText: "M4.9 7.2h9.4 M4.9 11.2h6.2 M4.9 15.2h4.2 M15.6 13.2a3.1 3.1 0 1 0 0 6.2 3.1 3.1 0 0 0 0-6.2Z M17.9 18.5 20.2 20.8",
      history: "M4.9 12a7.1 7.1 0 1 0 2.1-5 M4.7 5.6v3.6h3.6 M12 8.6V12l2.6 1.6",
      copy: "M9.2 9.4a1.8 1.8 0 0 1 1.8-1.8h6.2a1.8 1.8 0 0 1 1.8 1.8v6.2a1.8 1.8 0 0 1-1.8 1.8H11a1.8 1.8 0 0 1-1.8-1.8Z M15.2 7.6V6.4a1.8 1.8 0 0 0-1.8-1.8H6.9a1.8 1.8 0 0 0-1.8 1.8v6.5a1.8 1.8 0 0 0 1.8 1.8h1.3",
      reload: "M19.1 12a7.1 7.1 0 1 1-2.1-5 M19.3 5v3.6h-3.6",
    };

    /** One toolbar mark. */
    function ToolIcon(props) {
      return h("svg", { className: "dshd-fl-toolicon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" },
        h("path", {
          d: TOOLS[props.name],
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }));
    }

    /* One metric, shared by every layer that has to line up: the field, the
     * gutter beside it, the highlighter under it and the match layer over it.
     * Kerning and ligatures are off on all four, and letter spacing is pinned
     * rather than inherited — a field that takes the shell's tracking while
     * the overlay forces its own drifts a fraction of a pixel per column, and
     * by the eightieth character the colour sits under the wrong letters. */
    const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;"
      + "line-height:20px;letter-spacing:normal;word-spacing:normal;font-kerning:none;"
      + "font-variant-ligatures:none;font-feature-settings:normal;tab-size:2";
    /* The highlighter primitive sets its own type, so the shared metric has to
     * outrank it declaration by declaration. */
    const important = (rules) => rules.split(";").map((rule) => rule + "!important").join(";");

    /* ── Styles ────────────────────────────────────────────────────────────
     * Tokens first, with literal fallbacks: this pane is composed into the
     * harness's own shell, and a missing alias should degrade to something
     * legible rather than to a white-on-white pane. */
    const CSS = [
      "body[data-dshd-view=files] [class~=wSkVaW_root] [class~=wSkVaW_viewArea]{flex:1 1 0%;min-height:0;overflow:hidden}",
      ".dshd-fl{display:flex;flex:1 1 0%;height:auto;min-height:0;box-sizing:border-box;",
      "background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#f9fafb)}",

      /* left column */
      ".dshd-fl-side{flex:0 0 auto;width:264px;min-width:180px;max-width:460px;display:flex;",
      "flex-direction:column;min-height:0;",
      "border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-fl-sidehead{display:flex;align-items:center;gap:6px;padding:10px 8px 10px 12px;flex:0 0 auto;",
      "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-fl-root{flex:1 1 auto;min-width:0;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "padding:5px 8px;border-radius:8px;color:inherit;cursor:pointer;",
      "border:1px solid transparent;background:transparent;text-overflow:ellipsis;",
      "transition:background-color .1s var(--ds-ease-in-out,ease)}",
      ".dshd-fl-root:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-fl-tree{flex:1 1 auto;min-height:0;overflow:auto;padding:0;outline:none}.dshd-fl-tree-space{position:relative;margin:6px 6px 14px}.dshd-fl-tree:focus-visible [data-active=true]{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:-2px}",

      /* one row */
      ".dshd-fl-row{display:flex;align-items:center;gap:6px;width:100%;border:none;cursor:pointer;",
      "background:transparent;color:inherit;text-align:left;border-radius:7px;",
      "padding:4px 8px 4px 0;font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "transition:background-color .1s var(--ds-ease-in-out,ease)}",
      ".dshd-fl-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-fl-row[aria-selected=\"true\"]{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12))}",
      ".dshd-fl-row:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:-2px}",
      ".dshd-fl-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshd-fl-dirty{flex:0 0 auto;width:7px;height:7px;border-radius:50%;",
      "background:var(--dsw-alias-state-business-primary,#679efe)}",
      ".dshd-fl-icon{flex:0 0 auto;width:17px;height:17px}",
      ".dshd-fl-caret{flex:0 0 auto;width:14px;height:14px;opacity:.5;",
      "transition:transform .12s var(--ds-ease-in-out,ease)}",
      ".dshd-fl-caret.is-open{transform:rotate(90deg)}",
      ".dshd-fl-nocaret{flex:0 0 auto;width:14px}",

      /* right column */
      ".dshd-fl-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0}",
      ".dshd-fl-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;flex:0 0 auto;min-height:49px;",
      "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-fl-crumbs{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:4px;",
      "font:var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-secondary,rgba(249,250,251,.62));",
      "overflow:hidden;white-space:nowrap;direction:rtl;text-align:left}",
      ".dshd-fl-crumbs>span{direction:ltr}",
      ".dshd-fl-crumbs b{color:var(--dsw-alias-label-primary,#f9fafb);font-weight:500}",
      ".dshd-fl-btn{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;cursor:pointer;",
      "height:30px;padding:0 12px;border-radius:15px;color:inherit;",
      "font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "border:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.16));background:transparent;",
      "transition:background-color .1s var(--ds-ease-in-out,ease),opacity .1s ease}",
      ".dshd-fl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-fl-btn:disabled{opacity:.35;cursor:default}",
      ".dshd-fl-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}",
      ".dshd-fl-btn.is-primary{background:var(--dsw-alias-state-business-primary,#679efe);border-color:transparent;color:#fff}",
      ".dshd-fl-btn.is-primary:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-state-business-primary,#679efe)}",
      ".dshd-fl-seg{display:inline-flex;flex:0 0 auto;border-radius:15px;padding:2px;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f)}",
      ".dshd-fl-seg button{border:none;background:transparent;color:inherit;cursor:pointer;",
      "height:26px;padding:0 12px;border-radius:13px;font:var(--dsw-font-xs-13,13px/20px sans-serif)}",
      ".dshd-fl-seg button[aria-pressed=\"true\"]{background:var(--dsw-alias-bg-base,#151517)}",
      ".dshd-fl-seg button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:-2px}",

      /* content area */
      ".dshd-fl-body{flex:1 1 auto;min-height:0;overflow:auto;position:relative}",
      /* The editor is a gutter and a field sharing one metric: both must use
         the same font, size, line-height and top padding or the numbers walk
         away from their lines as the file scrolls. The gutter does not scroll
         itself — it is slaved to the textarea's scrollTop, because a textarea
         scrolls internally and nothing else can share that scroller. */
      ".dshd-fl-editwrap{position:relative;display:flex;height:100%;min-height:0}",
      ".dshd-fl-editor{display:flex;flex-direction:column;height:100%;min-height:0}.dshd-fl-editor>.dshd-fl-editwrap{flex:1;min-height:120px;height:auto}.dshd-fl-find{flex:0 0 auto;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff20);font:13px/1.5 system-ui}.dshd-fl-find-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dshd-fl-find-row+.dshd-fl-find-row{margin-top:8px}.dshd-fl-find input[type=text]{min-width:100px;flex:1;padding:8px 10px;background:var(--dsw-alias-bg-base,#151517);color:inherit;border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:8px;font:inherit}.dshd-fl-find label{display:inline-flex;gap:5px;align-items:center}.dshd-fl-find [role=status],.dshd-fl-find [role=alert]{margin:8px 0 0}.dshd-fl-find [role=alert]{color:var(--dsw-alias-state-error-primary,#f25a5a)}.dshd-fl-find input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}",
      ".dshd-fl-gutter{flex:0 0 auto;margin:0;padding:16px 10px 16px 0;overflow:hidden;",
      "text-align:right;user-select:none;color:var(--dsw-alias-label-tertiary,rgba(249,250,251,.42));",
      "padding-bottom:34px;",
      "border-right:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-fl-edit{display:block;box-sizing:border-box;flex:1 1 auto;min-width:0;height:100%;resize:none;border:none;outline:none;",
      "padding:16px 18px;color:inherit;background:transparent;white-space:pre}",
      /* The caret's own row, drawn beneath the text. `wrap: off` is what makes
         the arithmetic safe: one logical line is one 20px row, so the band is
         placed rather than measured, and it rides the same scroll offset as
         the highlighter. */
      ".dshd-fl-activeline{position:absolute;left:0;right:0;top:0;height:20px;pointer-events:none;",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.055))}",
      /* Hidden, not stale: while the overlay is catching up the field shows its
         own uncoloured text, which is honest, rather than colours belonging to
         the characters that were there a moment ago. */
      ".dshd-fl-syntax.is-lagging{visibility:hidden}",
      ".dshd-fl-textarea{position:relative;flex:1;min-width:0;min-height:0;height:100%}.dshd-fl-textarea>.dshd-fl-edit{position:relative;width:100%}.dshd-fl-match-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none}.dshd-fl-match-layer pre{margin:0;padding:16px 18px;white-space:pre;tab-size:2;color:transparent;font:13px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.dshd-fl-match-layer mark{color:transparent;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#679efe) 28%,transparent);outline:1px solid var(--dsw-alias-state-business-primary,#679efe);border-radius:2px}",
      ".dshd-fl-syntax{position:absolute;inset:0;overflow:hidden;pointer-events:none}.dshd-fl-syntax>div{width:max-content;min-width:100%}.dshd-fl-syntax .md-code-block{border:0!important;border-radius:0!important;background:transparent!important;margin:0!important;padding:0!important}.dshd-fl-syntax .md-code-block>div:first-child{display:none}.dshd-fl-syntax pre,.dshd-fl-syntax code{font:13px/20px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace!important;tab-size:2;white-space:pre!important;letter-spacing:normal!important;background:transparent!important;text-shadow:none!important}.dshd-fl-syntax pre{margin:0!important;padding:16px 18px!important;overflow:visible!important;border:0!important}.dshd-fl-syntax code{padding:0!important;display:block}.dshd-fl-syntax span{font-style:normal!important;font-weight:400!important}.dshd-fl-textarea.is-highlighted>.dshd-fl-edit{color:transparent;caret-color:var(--dsw-alias-label-primary,#eee);-webkit-text-fill-color:transparent}.dshd-fl-textarea.is-highlighted>.dshd-fl-edit::selection{background:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}.dshd-fl-editor-status{display:flex;gap:16px;padding:5px 14px;border-top:1px solid var(--dsw-alias-border-l1);font:11px/18px ui-monospace,monospace;color:var(--dsw-alias-label-tertiary)}",
      ".dshd-fl-pre{margin:0;padding:16px 18px;white-space:pre;overflow:auto;",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:20px}",
      /* Every layer of the edit surface in one declaration block, so they
         cannot be changed apart. Placed after the three rules above on purpose:
         it has to outrank their `font` shorthands, and the highlighter's is
         !important — and a shorthand resets kerning and ligatures even when it
         names the same face, which is exactly how an overlay ends up a fraction
         of a pixel per column away from the characters it is colouring. */
      ".dshd-fl-gutter,.dshd-fl-edit,.dshd-fl-match-layer pre,.dshd-fl-pre{" + MONO + "}",
      ".dshd-fl-syntax pre,.dshd-fl-syntax code{" + important(MONO) + "}",
      /* View mode gets the same gutter, wrapped around the plain <pre> — one
         scroller for both, so no synchronisation is needed at all. */
      ".dshd-fl-viewwrap{display:flex;height:100%;min-height:0;overflow:auto}",
      ".dshd-fl-viewwrap .dshd-fl-gutter{overflow:visible;flex-shrink:0}",
      ".dshd-fl-viewwrap .dshd-fl-pre{flex:1 1 auto;overflow:visible}",
      ".dshd-fl-code{padding:12px}",
      /* The primitive draws its own header bar; inside a full-height pane the
         chat's max-height would clip a long file to a scroll-less stub. */
      ".dshd-fl-code .md-code-block{max-height:none}",
      /* ReadBlock ships a banner with a hardcoded-Chinese copy button and a
         duplicate filename; drop it and keep the numbered body. */
      ".dshd-fl-code [class*=\"banner\"]{display:none}",

      /* media */
      ".dshd-fl-stage{display:flex;align-items:center;justify-content:center;height:100%;padding:24px;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f)}",
      ".dshd-fl-stage img{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;",
      /* A checkerboard, so a transparent PNG reads as transparent rather than
         as whatever the pane behind it happens to be. */
      "background-image:linear-gradient(45deg,rgba(255,255,255,.06) 25%,transparent 25%),",
      "linear-gradient(-45deg,rgba(255,255,255,.06) 25%,transparent 25%),",
      "linear-gradient(45deg,transparent 75%,rgba(255,255,255,.06) 75%),",
      "linear-gradient(-45deg,transparent 75%,rgba(255,255,255,.06) 75%);",
      "background-size:16px 16px;background-position:0 0,0 8px,8px -8px,-8px 0}",
      ".dshd-fl-stage video{max-width:100%;max-height:100%;border-radius:8px;background:#000}",
      ".dshd-fl-audio{display:flex;flex-direction:column;align-items:center;gap:18px;width:100%;max-width:460px}",
      ".dshd-fl-audio audio{width:100%}",
      ".dshd-fl-audio .dshd-fl-icon{width:64px;height:64px}",
      ".dshd-fl-frame{width:100%;height:100%;border:none;background:#fff}",

      /* states */
      ".dshd-fl-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;",
      "gap:10px;height:100%;padding:32px;text-align:center;",
      "color:var(--dsw-alias-label-secondary,rgba(249,250,251,.62));",
      "font:var(--dsw-font-sm-14,14px/22px sans-serif)}",
      ".dshd-fl-empty .dshd-fl-icon{width:40px;height:40px;opacity:.6}",
      ".dshd-fl-empty b{color:var(--dsw-alias-label-primary,#f9fafb);font-weight:500;font-size:15px}",
      ".dshd-fl-note{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 14px;",
      "font:var(--dsw-font-xs-13,13px/20px sans-serif);",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f);",
      "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-fl-note.is-error{color:var(--dsw-alias-state-error,#f56c6c)}",
      ".dshd-fl-note button{margin-left:auto}",
      ".dshd-fl-meta{flex:0 0 auto;font:var(--dsw-font-xs-12,12px/18px sans-serif);",
      "color:var(--dsw-alias-label-tertiary,rgba(249,250,251,.42))}",

      /* Composer stays on Files. Theme-holo parks it under the pane instead of
         overlaying the editor, keyed on the same body attribute. */
      ".dshd-fl{container-type:inline-size;min-width:0}",
      ".dshd-fl-side{width:230px;min-width:160px;background:var(--dsw-alias-bg-layer-1,#19191b)}",
      ".dshd-fl-side[hidden]{display:none}.dshd-fl-bar{min-height:52px;gap:8px;flex-wrap:wrap}",
      ".dshd-fl-row{min-height:32px}.dshd-fl-btn{min-height:30px;border-radius:7px}",
      /* Secondary actions are marks, not words: five labelled pills across the
         top of a file read as a settings screen, and the words survive in the
         accessible name and the tooltip where a dense toolbar keeps them. */
      ".dshd-fl-btn.is-icon{width:30px;padding:0;justify-content:center;border-color:transparent;",
      "color:var(--dsw-alias-label-secondary,rgba(249,250,251,.62))}",
      ".dshd-fl-btn.is-icon:hover:not(:disabled){color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-fl-btn.is-icon[aria-pressed=\"true\"]{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.12));",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-fl-toolicon{width:17px;height:17px;flex:0 0 auto}",
      ".dshd-fl-tools{display:flex;align-items:center;gap:2px;flex:0 0 auto;margin-left:auto}",
      /* The open file's own unsaved mark, next to its name rather than only in
         the tree, so the state is where the eye already is. */
      ".dshd-fl-crumbs .dshd-fl-dirty{display:inline-block;margin-left:7px;vertical-align:1px}",
      /* One status line for the whole pane, along the bottom where an editor
         puts it, instead of a second band under the toolbar. */
      ".dshd-fl-editor-status{align-items:center;min-height:26px;gap:14px;",
      "border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));",
      "background:var(--dsw-alias-bg-layer-1,#19191b)}",
      ".dshd-fl-editor-status .dshd-fl-state{margin-left:auto;text-align:right}",
      ".dshd-fl-editor-status .dshd-fl-state.is-dirty{color:var(--dsw-alias-state-business-primary,#679efe)}",
      ".dshd-fl-note{flex-wrap:wrap}.dshd-fl-note button{margin-left:0}",
      "@container(max-width:650px){.dshd-fl-side{width:180px;min-width:140px}.dshd-fl-bar .dshd-fl-crumbs{flex-basis:100%;order:-1}.dshd-fl-editor-status{gap:10px}.dshd-fl-editor-status span:nth-child(3){display:none}}",
      "@media(max-width:520px){.dshd-fl{flex-direction:column}.dshd-fl-side{width:100%;min-width:0;max-width:none;flex:0 1 auto;max-height:28%;min-height:100px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2,#ffffff20)}.dshd-fl-main{width:100%}}",
      ".dshd-recovery{height:100%;overflow:auto;padding:20px;box-sizing:border-box;font:13px/1.5 system-ui}.dshd-recovery h2{font-size:18px;margin:0}.dshd-recovery h3{font-size:14px;overflow-wrap:anywhere}.dshd-recovery-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0}.dshd-recovery-list{display:grid;gap:6px;margin:16px 0}.dshd-recovery-item{text-align:left;padding:10px 12px!important;height:auto!important;display:grid;gap:4px}.dshd-recovery-item small{opacity:.65;overflow-wrap:anywhere}.dshd-recovery-compare{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:12px}.dshd-recovery label{display:block;min-width:0}.dshd-recovery textarea{display:block;width:100%;box-sizing:border-box;min-height:220px;resize:vertical;margin:8px 0;padding:12px;background:var(--dsw-alias-bg-base,#151517);color:inherit;border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:8px;font:12px/1.6 monospace}.dshd-recovery input{box-sizing:border-box;width:100%;padding:9px;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:8px}.dshd-recovery [role=alert]{color:var(--dsw-alias-state-error-primary,#f25a5a)}",
      ".dshd-file-search{padding:20px;overflow:auto;font:13px/1.5 system-ui}.dshd-file-search h2{margin:0;font-size:18px}.dshd-file-search-tools{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.dshd-file-search input{box-sizing:border-box;width:100%;padding:11px 12px;background:var(--dsw-alias-bg-base,#151517);color:inherit;border:1px solid var(--dsw-alias-border-l2,#ffffff20);border-radius:10px;font:inherit}.dshd-file-search-list{display:grid;gap:4px;margin:12px 0}.dshd-file-search-item{display:flex;gap:10px;align-items:center;width:100%;padding:10px 12px;border:1px solid transparent;border-radius:10px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit}.dshd-file-search-item[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover,#ffffff12);border-color:var(--dsw-alias-border-l2,#ffffff20)}.dshd-file-search-item>span{display:grid;min-width:0;gap:2px}.dshd-file-search-item small{opacity:.65;overflow-wrap:anywhere}.dshd-file-search-item strong{overflow-wrap:anywhere;font-weight:500}.dshd-file-search input:focus-visible,.dshd-file-search-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}.dshd-file-search [role=alert]{color:var(--dsw-alias-state-error-primary,#f25a5a)}.dshd-file-search-help{font-size:12px;opacity:.65}",
    ].join("");

    const STYLE_ID = "dshd-files-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const el = document.createElement("style");
      el.id = STYLE_ID;
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /* ── Talking to /dsh-files ─────────────────────────────────────────── */

    async function api(path, init) {
      const response = await fetch(API + path, Object.assign({ credentials: "same-origin" }, init));
      let payload = null;
      try { payload = await response.json(); } catch { /* non-JSON error body */ }
      if (!response.ok) {
        const error = new Error((payload && payload.error) || "request failed");
        error.status = response.status;
        error.code = payload && payload.code;
        error.missing = payload?.missing === true;
        throw error;
      }
      return payload;
    }

    const rawUrl = (path) => API + "/raw?path=" + encodeURIComponent(path);

    /** Basename without pulling in a path module. */
    function baseName(path) {
      const trimmed = String(path || "").replace(/\/+$/, "");
      const cut = trimmed.lastIndexOf("/");
      return cut < 0 ? trimmed : trimmed.slice(cut + 1);
    }

    function formatBytes(size) {
      if (typeof size !== "number" || size < 0) return "";
      if (size < 1024) return size + " B";
      if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + " KB";
      if (size < 1024 * 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + " MB";
      return (size / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    }

    /* The page's own highlighter, reached through the primitives seed.
     *
     * That module is a private, undocumented, untyped table baked into the
     * prebuilt frontend: there is no package, no .d.ts and no changelog, and its
     * props were recovered by reading minified source. A harness bump can rename
     * any of it with nothing at build time to warn us, and the failure mode
     * would be a blank pane. So it is resolved once, defensively, and every use
     * falls back to an uncoloured <pre> — the path that will actually run one
     * day, and therefore the one that has to work. */
    let CodeBlock = null;
    let ReadBlock = null;
    try {
      const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
      if (primitives && typeof primitives.CodeBlock === "function") CodeBlock = primitives.CodeBlock;
      if (primitives && typeof primitives.ReadBlock === "function") ReadBlock = primitives.ReadBlock;
    } catch { CodeBlock = null; ReadBlock = null; }

    /* ── The tree ──────────────────────────────────────────────────────── */

    const TREE_ROW_HEIGHT = 32;
    let treeSequence = 0;

    // Flatten only expanded branches. DOM rows are windowed below, but every
    // loaded entry remains navigable; no arbitrary file-count cutoff is used.
    function treeRows(props) {
      const rows = [], byPath = new Map();
      const stack = [{ path: props.path, depth: 0, index: 0 }];
      while (stack.length) {
        const frame = stack[stack.length - 1], entries = props.dirs[frame.path];
        if (!entries?.length) {
          rows.push({ path: frame.path, depth: frame.depth,
            message: entries === null ? "Unable to load. Use Refresh to retry." : entries === undefined ? "Loading…" : "Empty" });
          stack.pop(); continue;
        }
        if (frame.index >= entries.length) { stack.pop(); continue; }
        const position = ++frame.index, entry = entries[position - 1];
        byPath.set(entry.path, rows.length);
        rows.push({ entry, depth: frame.depth, parent: frame.path, position, size: entries.length });
        if (entry.type === "directory" && props.open.has(entry.path))
          stack.push({ path: entry.path, depth: frame.depth + 1, index: 0 });
      }
      return { rows, byPath };
    }

    function TreeLevel(props) {
      const container = useRef(null);
      const revealCurrent = useRef(null);
      const identity = useRef(null);
      if (!identity.current) identity.current = "dshd-files-tree-" + ++treeSequence;
      const [focusPath, setFocusPath] = useState(null);
      const [viewport, setViewport] = useState({ top: 0, height: 400 });
      const typed = useRef({ text: "", time: 0 });
      const selection = useRef({ value: null, pending: null });
      const model = useMemo(() => treeRows(props), [props.path, props.dirs, props.open]);
      const { rows, byPath } = model;
      let focusIndex = byPath.get(focusPath);
      if (focusIndex === undefined && focusPath) {
        // If a refresh removed a focused descendant, keep its nearest visible
        // ancestor active rather than leaving a dangling accessibility ID.
        let parent = focusPath;
        while (parent.includes("/")) {
          parent = parent.slice(0, parent.lastIndexOf("/"));
          if (byPath.has(parent)) { focusIndex = byPath.get(parent); break; }
        }
      }
      if (focusIndex === undefined) focusIndex = rows.findIndex(row => row.entry);
      const focused = rows[focusIndex];
      const syncViewport = useCallback(() => {
        const field = container.current;
        if (!field) return;
        const top = field.scrollTop || 0, height = field.clientHeight || 400;
        setViewport(previous => previous.top === top && previous.height === height ? previous : { top, height });
      }, []);
      useEffect(() => {
        syncViewport();
        const observer = new ResizeObserver(() => {
          if (container.current?.clientHeight) revealCurrent.current?.();
          syncViewport();
        });
        if (container.current) observer.observe(container.current);
        return () => observer.disconnect();
      }, [syncViewport]);
      const reveal = index => {
        const field = container.current;
        if (!field || index < 0) return;
        const top = index * TREE_ROW_HEIGHT + 6, bottom = top + TREE_ROW_HEIGHT;
        const scroll = field.scrollTop || 0, height = field.clientHeight || 400;
        if (top < scroll) field.scrollTop = top;
        else if (bottom > scroll + height) field.scrollTop = Math.max(0, bottom - height);
        syncViewport();
      };
      const move = index => {
        if (!rows[index]?.entry) return;
        setFocusPath(rows[index].entry.path); reveal(index);
      };
      revealCurrent.current = () => reveal(focusIndex);
      useEffect(() => {
        const requested = selection.current.request !== props.revealRequest;
        if (selection.current.value !== props.selected || requested) {
          selection.current = { value: props.selected, request: props.revealRequest,
            pending: requested && props.revealRequest ? props.revealRequest.path : props.selected };
        }
        const index = byPath.get(selection.current.pending);
        if (index !== undefined) { selection.current.pending = null; move(index); }
        // A shorter refresh/collapsed branch can clamp the native scroller.
        syncViewport();
      }, [props.selected, props.revealRequest, model, syncViewport]);
      const activate = row => {
        if (!row?.entry) return;
        if (row.entry.type === "directory") props.onToggle(row.entry.path);
        else props.onOpen(row.entry);
      };
      const onKeyDown = event => {
        if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || !focused?.entry) return;
        let target = focusIndex, handled = true;
        const page = Math.max(1, Math.floor(viewport.height / TREE_ROW_HEIGHT));
        switch (event.key) {
          case "ArrowDown": target++; break;
          case "ArrowUp": target--; break;
          case "Home": target = 0; break;
          case "End": target = rows.length - 1; break;
          case "PageDown": target = Math.min(rows.length - 1, target + page); break;
          case "PageUp": target = Math.max(0, target - page); break;
          case "ArrowRight":
            if (focused.entry.type === "directory") {
              if (!props.open.has(focused.entry.path)) props.onToggle(focused.entry.path);
              else if (rows[target + 1]?.entry && rows[target + 1].depth > focused.depth) target++;
            }
            break;
          case "ArrowLeft":
            if (focused.entry.type === "directory" && props.open.has(focused.entry.path)) props.onToggle(focused.entry.path);
            else target = byPath.get(focused.parent) ?? target;
            break;
          case "Enter": case " ": activate(focused); break;
          default:
            handled = event.key.length === 1;
            if (handled) {
              const now = Date.now(), key = event.key.toLocaleLowerCase();
              const previous = now - typed.current.time < 800 ? typed.current.text : "";
              const query = previous === key ? key : previous + key;
              typed.current = { text: query, time: now };
              for (let offset = query.length > 1 ? 0 : 1; offset <= rows.length; offset++) {
                const index = (focusIndex + offset) % rows.length;
                if (rows[index].entry?.name.toLocaleLowerCase().startsWith(query)) { target = index; break; }
              }
            }
        }
        if (!handled) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key.length !== 1) typed.current = { text: "", time: 0 };
        const direction = target < focusIndex ? -1 : 1;
        while (target >= 0 && target < rows.length && !rows[target].entry) target += direction;
        if (target >= 0 && target < rows.length) move(target);
      };
      const first = Math.max(0, Math.min(rows.length - 1, Math.floor(viewport.top / TREE_ROW_HEIGHT)) - 6);
      const last = Math.min(rows.length, first + Math.ceil(viewport.height / TREE_ROW_HEIGHT) + 13);
      const visible = Array.from({ length: last - first }, (_, index) => first + index);
      // Keep the active descendant mounted even when the user scrolls it away.
      if (focusIndex >= 0 && !visible.includes(focusIndex)) visible.push(focusIndex);
      visible.sort((a, b) => a - b);
      return h("div", { className: "dshd-fl-tree", role: "tree", "aria-label": "Workspace files", tabIndex: 0,
        ref: container, onScroll: syncViewport, onKeyDown,
        "aria-activedescendant": focusIndex >= 0 ? identity.current + "-" + focusIndex : undefined },
        h("div", { className: "dshd-fl-tree-space", style: { height: rows.length * TREE_ROW_HEIGHT } },
          visible.map(index => {
            const row = rows[index], entry = row.entry;
            const style = { position: "absolute", top: index * TREE_ROW_HEIGHT, height: TREE_ROW_HEIGHT,
              boxSizing: "border-box", paddingLeft: 8 + row.depth * 14 };
            if (!entry) return h("div", { key: row.path + "//status", className: "dshd-fl-row", role: "status", style },
              h("span", { className: "dshd-fl-name", title: row.message }, row.message));
            const isDirectory = entry.type === "directory", open = props.open.has(entry.path);
            return h("button", { key: entry.path, id: identity.current + "-" + index, type: "button", tabIndex: -1,
              className: "dshd-fl-row", role: "treeitem", "aria-level": row.depth + 1,
              "aria-posinset": row.position, "aria-setsize": row.size,
              "aria-selected": props.selected === entry.path ? "true" : "false",
              "aria-expanded": isDirectory ? String(open) : undefined,
              "data-active": focusIndex === index ? "true" : undefined,
              style, title: entry.name,
              onClick: () => { move(index); container.current?.focus({ preventScroll: true }); activate(row); } },
              isDirectory ? h(Caret, { open }) : h("span", { className: "dshd-fl-nocaret" }),
              h(FileIcon, { type: isDirectory ? (open ? "folderOpen" : "folder") : classify(entry.name, false) }),
              h("span", { className: "dshd-fl-name" }, entry.name),
              props.dirtyPaths.has(entry.path) ? h("span", { className: "dshd-fl-dirty", title: "Unsaved changes" }) : null);
          })));
    }

    /* ── Line numbers ──────────────────────────────────────────────────── */

    /**
     * One right-aligned column of line numbers, as a single text node.
     *
     * A div per line would be 50k elements for a big log; one string in a <pre>
     * is one text node however long the file gets. Width follows the digit
     * count so 9-line files do not carry five-digit whitespace.
     */
    function Gutter(props) {
      const lines = useMemo(() => {
        let count = 1;
        const text = props.text || "";
        for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
        let out = "1";
        for (let n = 2; n <= count; n += 1) out += "\n" + n;
        return { body: out, digits: String(count).length };
      }, [props.text]);
      return h("pre", {
        className: "dshd-fl-gutter",
        ref: props.gutterRef,
        "aria-hidden": "true",
        style: { width: "calc(" + Math.max(2, lines.digits) + "ch + 22px)" },
      }, lines.body);
    }

    /**
     * The edit surface: a gutter slaved to the textarea's internal scroll.
     *
     * `wrap: off` is what makes the numbers honest — with soft wrapping a
     * logical line can occupy several visual rows and every number below it
     * drifts. Long lines scroll horizontally instead, which is what code
     * editors do.
     */
    const EDITOR_LIMIT = 2 * 1024 * 1024;
    /* Colouring costs about 5ms per kilobyte and the whole document is
     * retokenised for one keystroke, so the field's responsiveness is a
     * function of file size: measured at 76ms a key over 300 lines, 253ms over
     * 1100 and 807ms over 3600. Past SYNTAX_SYNC the overlay is driven by a
     * copy that only catches up when typing stops, and past SYNTAX_LIMIT there
     * is no overlay at all — even a settled pass would freeze the pane for the
     * best part of a second every time the typist paused. */
    const SYNTAX_LIMIT = 60000;
    const SYNTAX_SYNC = 4000;
    const wordCharacter = /[\p{L}\p{N}_]/u;
    function wholeMatch(text, start, end) {
      const before = start > 1 && /[\uDC00-\uDFFF]/.test(text[start - 1]) ? text.slice(start - 2, start) : text[start - 1] || "";
      const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)) : "";
      return !wordCharacter.test(before) && !wordCharacter.test(after);
    }
    function literalPattern(query, matchCase) {
      return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
    }
    // Count and locate matches without allocating one object per match in a
    // large file. Patterns are escaped literals, never user-supplied regex.
    function scanMatches(text, query, matchCase, wholeWord, anchor) {
      let count = 0, units = 0, first = null, lastStart = 0, lastEnd = 0, chosenStart = 0, chosenEnd = 0, chosenIndex = 0;
      if (!query) return { count, units, current: null };
      const pattern = literalPattern(query, matchCase);
      let match;
      while ((match = pattern.exec(text))) {
        const start = match.index, end = start + match[0].length;
        if (wholeWord && !wholeMatch(text, start, end)) continue;
        count++; units += match[0].length;
        if (!first) first = { start, end, index: count };
        lastStart = start; lastEnd = end;
        if (anchor.direction > 0 ? !chosenIndex && start >= anchor.position : start < anchor.position) {
          chosenStart = start; chosenEnd = end; chosenIndex = count;
        }
      }
      return { count, units, current: chosenIndex ? { start: chosenStart, end: chosenEnd, index: chosenIndex }
        : anchor.direction > 0 ? first : count ? { start: lastStart, end: lastEnd, index: count } : null };
    }

    function EditorPane(props) {
      const gutterRef = useRef(null);
      const editorRef = useRef(null);
      const highlightRef = useRef(null);
      const syntaxRef = useRef(null);
      const caretRef = useRef(null);
      const caretLine = useRef(1);
      const [cursor, setCursor] = useState({line:1,column:1,selected:0});
      // The band under the caret's row, placed from the line number and the
      // field's own scroll offset — both exact while `wrap: off` keeps one
      // logical line on one 20px row. Written to the node rather than to a
      // style prop, like the two overlay transforms below it, so a keystroke
      // does not re-render the band's position on every character.
      const trackCaret = useCallback((line, scrollTop) => {
        caretLine.current = line;
        if (caretRef.current) caretRef.current.style.transform = "translateY(" + (16 + (line - 1) * 20 - scrollTop) + "px)";
      }, []);
      // Deliberately unkeyed: React owns none of that transform, so it has to
      // be restored after every render, including the first.
      useEffect(() => { trackCaret(caretLine.current, editorRef.current?.scrollTop || 0); });
      const language = languageOf(baseName(props.path));
      const colourable = Boolean(CodeBlock && language && props.draft.length <= SYNTAX_LIMIT);
      // Small files are coloured on the keystroke, as before. Larger ones feed
      // the overlay a copy that settles after the typing does, and the overlay
      // is hidden while it lags rather than shown out of date: the field's own
      // text is transparent underneath it, so a colour layer a few characters
      // behind would be read as the file itself. A file with no overlay at all
      // counts as live — deferring a copy nothing reads would still cost a
      // timer and a re-render on every keystroke.
      const live = !colourable || props.draft.length <= SYNTAX_SYNC;
      const [settled, setSettled] = useState(props.draft);
      useEffect(() => {
        if (live) return;
        const timer = setTimeout(() => setSettled(props.draft), 140);
        return () => clearTimeout(timer);
      }, [props.draft, live]);
      const source = live ? props.draft : settled;
      const syntax = colourable && source === props.draft;
      // Held by reference so a keystroke that has not changed `source` cannot
      // walk into the highlighter at all — React skips a child element it is
      // handed twice, and that skip is the whole saving.
      const highlight = useMemo(() => (colourable ? h(CodeBlock, { code: source + "\n", lang: language }) : null),
        [colourable, source, language]);
      const findRef = useRef(null);
      const applying = useRef(false);
      // Editing/undo must not reselect a match on every draft update. Only
      // explicit find navigation resumes automatic selection and scrolling.
      const revealRequested = useRef(true);
      const [findOpen, setFindOpen] = useState(false);
      const [replaceOpen, setReplaceOpen] = useState(false);
      const [query, setQuery] = useState("");
      const [replacement, setReplacement] = useState("");
      const [matchCase, setMatchCase] = useState(false);
      const [wholeWord, setWholeWord] = useState(false);
      const [anchor, setAnchor] = useState({ position: 0, direction: 1 });
      const [message, setMessage] = useState(null);
      const [lastReplacement, setLastReplacement] = useState(null);
      useEffect(() => {
        if (!props.findRequest?.id) return;
        revealRequested.current = true;
        const field = editorRef.current;
        if (document.activeElement === field && field.selectionEnd > field.selectionStart) {
          const selected = props.draft.slice(field.selectionStart, field.selectionEnd);
          if (selected.length <= 512 && !selected.includes("\n")) setQuery(selected);
        }
        setFindOpen(true); setReplaceOpen(Boolean(props.findRequest.replace));
        setAnchor({ position: field?.selectionStart || 0, direction: 1 });
      }, [props.findRequest]);
      useEffect(() => { if (findOpen) findRef.current?.focus(); }, [findOpen, props.findRequest]);
      const result = useMemo(() => scanMatches(props.draft, findOpen ? query : "", matchCase, wholeWord, anchor),
        [props.draft, findOpen, query, matchCase, wholeWord, anchor]);
      const revealMatch = useCallback(() => {
        if (!findOpen || !result.current || !editorRef.current) return;
        const field = editorRef.current, { start, end } = result.current;
        if (revealRequested.current) field.setSelectionRange?.(start, end);
        // Measure the mirror: tabs, fallback fonts and wide Unicode glyphs do
        // not occupy one fixed-width cell per JavaScript string character.
        const mirror = highlightRef.current;
        const marker = mirror?.querySelector("mark");
        if (marker && revealRequested.current) {
          const matchBox = marker.getBoundingClientRect(), mirrorBox = mirror.getBoundingClientRect();
          field.scrollTop = Math.max(0, matchBox.top - mirrorBox.top - field.clientHeight / 2);
          field.scrollLeft = Math.max(0, matchBox.left - mirrorBox.left - field.clientWidth / 2);
        }
        if (revealRequested.current) trackCaret(props.draft.slice(0, start).split("\n").length, field.scrollTop);
        if (gutterRef.current) gutterRef.current.scrollTop = field.scrollTop;
        if (highlightRef.current) highlightRef.current.style.transform = `translate(${-field.scrollLeft}px,${-field.scrollTop}px)`;
        if (syntaxRef.current) syntaxRef.current.style.transform = `translate(${-field.scrollLeft}px,${-field.scrollTop}px)`;
      }, [result, findOpen, props.draft, trackCaret]);
      useEffect(() => {
        revealMatch();
        const field = editorRef.current;
        if (!field || !findOpen) return;
        const observer = new ResizeObserver(revealMatch);
        observer.observe(field);
        return () => observer.disconnect();
      }, [revealMatch, findOpen]);
      const navigate = direction => {
        if (!result.current) return;
        revealRequested.current = true;
        setAnchor({ direction, position: direction > 0 ? result.current.end : result.current.start });
        setMessage(null);
      };
      const closeFind = () => { setFindOpen(false); editorRef.current?.focus(); };
      const writeDraft = (next, start = 0, end = props.draft.length, inserted = next) => {
        const field = editorRef.current;
        // Chromium's native insertion keeps Cmd/Ctrl+Z history. The explicit
        // Revert control remains available when that browser API is absent.
        if (field && field.value === props.draft && typeof document.execCommand === "function") {
          field.focus({ preventScroll: true }); field.setSelectionRange(start, end);
          applying.current = true;
          try { document.execCommand("insertText", false, inserted); } catch { /* controlled-input fallback below */ }
          finally { applying.current = false; }
        }
        props.onDraft(next);
      };
      const replace = all => {
        if (!result.current || !query) return;
        const before = props.draft, current = result.current;
        const projected = all ? before.length - result.units + result.count * replacement.length
          : before.length - (current.end - current.start) + replacement.length;
        if (projected > EDITOR_LIMIT) { setMessage({ error: true, text: "Replacement would exceed the 2 MiB editor limit. Use a smaller replacement." }); return; }
        const next = all ? before.replace(literalPattern(query, matchCase), (value, offset) =>
          wholeWord && !wholeMatch(before, offset, offset + value.length) ? value : replacement)
          : before.slice(0, current.start) + replacement + before.slice(current.end);
        if (new TextEncoder().encode(next).length > EDITOR_LIMIT) { setMessage({ error: true, text: "Replacement would exceed the 2 MiB editor limit. Use a smaller replacement." }); return; }
        if (next === before) { setMessage({ text: "The text already matches the replacement." }); return; }
        revealRequested.current = true;
        writeDraft(next, all ? 0 : current.start, all ? before.length : current.end, all ? next : replacement);
        setLastReplacement({ before, after: next });
        setAnchor({ position: all ? 0 : current.start + replacement.length, direction: 1 });
        setMessage({ text: (all ? result.count : 1) + " replacement" + (all && result.count !== 1 ? "s" : "") + " made in your draft. Save to write the file." });
      };
      const onScroll = useCallback((event) => {
        if (gutterRef.current) gutterRef.current.scrollTop = event.target.scrollTop;
        if (highlightRef.current) highlightRef.current.style.transform = `translate(${-event.target.scrollLeft}px,${-event.target.scrollTop}px)`;
        if (syntaxRef.current) syntaxRef.current.style.transform = `translate(${-event.target.scrollLeft}px,${-event.target.scrollTop}px)`;
        trackCaret(caretLine.current, event.target.scrollTop);
      }, [trackCaret]);
      const onKeyDown = event => {
        if (event.key === "Escape" && findOpen) { event.preventDefault(); event.stopPropagation(); closeFind(); }
        else props.onKeyDown(event);
      };
      return h("div", { className: "dshd-fl-editor", onKeyDown },
        findOpen ? h("section", { className: "dshd-fl-find", "aria-label": "Find and replace in file" },
          h("div", { className: "dshd-fl-find-row" },
            h("input", { type: "text", ref: findRef, "aria-label": "Find text", placeholder: "Find text…", maxLength: 512, value: query,
              onChange: event => { revealRequested.current = true; setQuery(event.target.value); setAnchor({ position: 0, direction: 1 }); setMessage(null); },
              onKeyDown: event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); navigate(event.shiftKey ? -1 : 1); } } }),
            h("button", { type: "button", className: "dshd-fl-btn", disabled: !result.count, onClick: () => navigate(-1), "aria-label": "Previous match" }, "↑"),
            h("button", { type: "button", className: "dshd-fl-btn", disabled: !result.count, onClick: () => navigate(1), "aria-label": "Next match" }, "↓"),
            h("button", { type: "button", className: "dshd-fl-btn", onClick: closeFind, "aria-label": "Close find" }, "×")),
          h("div", { className: "dshd-fl-find-row" },
            h("label", null, h("input", { type: "checkbox", checked: matchCase, onChange: event => { revealRequested.current = true; setMatchCase(event.target.checked); setAnchor({ position: 0, direction: 1 }); } }), "Match case"),
            h("label", null, h("input", { type: "checkbox", checked: wholeWord, onChange: event => { revealRequested.current = true; setWholeWord(event.target.checked); setAnchor({ position: 0, direction: 1 }); } }), "Whole word"),
            h("button", { type: "button", className: "dshd-fl-btn", "aria-expanded": replaceOpen, onClick: () => setReplaceOpen(value => !value) }, "Replace")),
          replaceOpen ? h("div", { className: "dshd-fl-find-row" },
            h("input", { type: "text", "aria-label": "Replace with", placeholder: "Replace with…", value: replacement, onChange: event => setReplacement(event.target.value),
              onKeyDown: event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); replace(false); } } }),
            h("button", { type: "button", className: "dshd-fl-btn", disabled: !result.count, onClick: () => replace(false) }, "Replace match"),
            h("button", { type: "button", className: "dshd-fl-btn", disabled: !result.count, onClick: () => replace(true) }, "Replace all")) : null,
          h("p", { role: "status" }, !query ? "Type to find text in this file." : result.count ? result.current.index + " of " + result.count + (result.count === 1 ? " match" : " matches") : "No matches."),
          message ? h("p", { role: message.error ? "alert" : "status" }, message.text) : null,
          lastReplacement ? h("button", { type: "button", className: "dshd-fl-btn", disabled: props.draft !== lastReplacement.after,
            onClick: () => { if (props.draft !== lastReplacement.after) return; writeDraft(lastReplacement.before); setLastReplacement(null); setMessage({ text: "Last replacement reverted." }); } }, "Revert last replacement") : null) : null,
        h("div", { className: "dshd-fl-editwrap" },
        h("div", { className: "dshd-fl-activeline", ref: caretRef, "aria-hidden": true }),
        h(Gutter, { text: props.draft, gutterRef }),
        h("div", { className: "dshd-fl-textarea" + (syntax ? " is-highlighted" : "") },
        colourable ? h("div", { className: "dshd-fl-syntax" + (syntax ? "" : " is-lagging"), "aria-hidden": true, inert: true },
          h("div", { ref: syntaxRef }, highlight)) : null,
        findOpen && result.current ? h("div", { className: "dshd-fl-match-layer", "aria-hidden": true },
          h("pre", { ref: highlightRef }, props.draft.slice(0, result.current.start),
            h("mark", null, props.draft.slice(result.current.start, result.current.end)), props.draft.slice(result.current.end))) : null,
        h("textarea", {
          ref: editorRef,
          className: "dshd-fl-edit",
          value: props.draft,
          wrap: "off",
          spellCheck: false,
          autoCapitalize: "off",
          autoCorrect: "off",
          "aria-label": "Contents of " + baseName(props.path),
          onChange: (event) => { if (!applying.current) { revealRequested.current = false; setMessage(null); props.onDraft(event.target.value); } },
          onScroll,
          onSelect: event => {
            const field = event.target;
            // The end you are steering, not the end you started from: selecting
            // backwards up a file used to leave the readout on the anchor,
            // reporting a line the caret had left.
            const caret = field.selectionDirection === "backward" ? field.selectionStart : field.selectionEnd;
            const before = field.value.slice(0, caret);
            const lines = before.split("\n");
            setCursor({line:lines.length,column:Array.from(lines.at(-1)).length+1,
              selected:Array.from(field.value.slice(field.selectionStart,field.selectionEnd)).length});
            trackCaret(lines.length, field.scrollTop || 0);
          },
        }))),
        h("div", { className: "dshd-fl-editor-status" },
          h("span", null, language || "Plain text"),
          h("span", null, `Ln ${cursor.line}, Col ${cursor.column}`
            + (cursor.selected ? ` · ${cursor.selected} selected` : "")),
          h("span", null, "UTF-8"),
          language && props.draft.length > SYNTAX_LIMIT ? h("span", null, "Large file · syntax colors paused") : null,
          props.status
            ? h("span", { className: "dshd-fl-state" + (props.dirty ? " is-dirty" : ""), role: "status", "aria-live": "polite" }, props.status)
            : null));
    }

    /* ── The right-hand pane ───────────────────────────────────────────── */

    function Viewer(props) {
      const doc = props.doc;
      if (!doc) {
        return h("div", { className: "dshd-fl-empty" },
          h(FileIcon, { type: "folder" }),
          h("b", null, "No file open"),
          h("span", null, "Pick a file on the left to read it, edit it, or play it."));
      }

      const family = classify(baseName(doc.path), false);

      if (doc.kind === "too-large") {
        return h("div", { className: "dshd-fl-empty" },
          h(FileIcon, { type: family }),
          h("b", null, baseName(doc.path)),
          h("span", null, formatBytes(doc.size) + " is past what this editor will open."),
          h("span", null, "Large files are better handled by asking the agent to work on them."));
      }

      if (doc.kind === "media") {
        const url = rawUrl(doc.path);
        if (family === "image") {
          return h("div", { className: "dshd-fl-stage" }, h("img", { src: url, alt: baseName(doc.path) }));
        }
        if (family === "video") {
          // A real URL, not an object URL: the window policy allows same-origin
          // media and blob:, and this route is the same-origin Range source.
          return h("div", { className: "dshd-fl-stage" },
            h("video", { src: url, controls: true, preload: "auto", playsInline: true }));
        }
        if (family === "audio") {
          return h("div", { className: "dshd-fl-stage" },
            h("div", { className: "dshd-fl-audio" },
              h(FileIcon, { type: "audio" }),
              h("div", { className: "dshd-fl-meta" }, baseName(doc.path)),
              h("audio", { src: url, controls: true, preload: "auto" })));
        }
        if (family === "pdf") {
          // object-src is 'none', so <embed>/<object> are out; frame-src allows
          // 'self', so the built-in viewer is reached through an iframe.
          return h("iframe", { className: "dshd-fl-frame", src: url, title: baseName(doc.path) });
        }
      }

      if (doc.kind === "binary") {
        return h("div", { className: "dshd-fl-empty" },
          h(FileIcon, { type: family }),
          h("b", null, baseName(doc.path)),
          h("span", null, "Not a text file" + (doc.size ? " · " + formatBytes(doc.size) : "") + "."),
          h("a", { className: "dshd-fl-btn", href: rawUrl(doc.path), target: "_blank", rel: "noreferrer" }, "Open bytes"));
      }

      if (props.mode === "edit") {
        return h(EditorPane, {
          key: doc.path,
          draft: props.draft,
          path: doc.path,
          onDraft: props.onDraft,
          onKeyDown: props.onKeyDown,
          findRequest: props.findRequest,
          status: props.status,
          dirty: props.dirty,
        });
      }

      const lang = languageOf(baseName(doc.path));
      // ReadBlock is the chat's own numbered, highlighted file view — the one
      // primitive that already draws line numbers. Kept behind a size cap:
      // building a row object per line and highlighting them all is editor
      // work, and past a few thousand lines the plain path is the honest one.
      if (ReadBlock) {
        const rows = props.draft.split("\n");
        if (rows.length <= 4000) {
          return h("div", { className: "dshd-fl-code" },
            h(ReadBlock, {
              label: baseName(doc.path),
              lines: rows.map((text, index) => ({ number: index + 1, text })),
              totalLines: rows.length,
              lang,
              maxLines: rows.length,
            }));
        }
      }
      if (CodeBlock) {
        return h("div", { className: "dshd-fl-code" },
          h(CodeBlock, { code: props.draft, lang, copyLabel: "Copy", copiedLabel: "Copied" }));
      }
      // No highlighter reachable: plain text, but still numbered — the gutter
      // shares the <pre>'s scroller here, so nothing needs syncing.
      return h("div", { className: "dshd-fl-viewwrap" },
        h(Gutter, { text: props.draft }),
        h("pre", { className: "dshd-fl-pre" }, props.draft));
    }

    let searchSequence = 0;
    function FileSearch({ root, active = true, onOpen, onClose }) {
      const [query, setQuery] = useState("");
      const [result, setResult] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState("");
      const [refresh, setRefresh] = useState(0);
      const [selected, setSelected] = useState(0);
      const inputRef = useRef(null);
      const selectedRef = useRef(null);
      const id = useRef(null);
      if (!id.current) id.current = "dshd-file-search-" + ++searchSequence;
      const refreshed = useRef(-1);
      useEffect(() => { setQuery(""); setResult(null); setSelected(0); refreshed.current = -1; }, [root]);
      useEffect(() => {
        if (!root) { setLoading(false); setResult(null); return; }
        if (!active) return;
        let live = true;
        const controller = new AbortController();
        setLoading(true); setError(""); setResult(null); setSelected(0);
        const timer = setTimeout(() => {
          const rescan = refreshed.current !== refresh;
          refreshed.current = refresh;
          api("/search?root=" + encodeURIComponent(root) + "&q=" + encodeURIComponent(query)
            + (rescan ? "&refresh=1" : ""), { signal: controller.signal })
            .then(value => { if (live) setResult(value); })
            .catch(reason => { if (live && !controller.signal.aborted) setError(reason.message); })
            .finally(() => { if (live) setLoading(false); });
        }, query ? 150 : 0);
        return () => { live = false; clearTimeout(timer); controller.abort(); };
      }, [root, query, refresh, active]);
      const entries = result?.root === root ? result.entries || [] : [];
      useEffect(() => { selectedRef.current?.scrollIntoView?.({ block: "nearest" }); }, [selected, result]);
      const choose = entry => {
        if (loading || !entry) return;
        if (entry.type === "directory") {
          setQuery(entry.relativePath.replace(/\/+$/, "") + "/");
          inputRef.current?.focus();
        } else onOpen({ path: entry.path, name: baseName(entry.path) });
      };
      const onKeyDown = event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        else if (event.target !== inputRef.current) return;
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (entries.length) setSelected(index => (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length);
        } else if (event.key === "Enter") { event.preventDefault(); choose(entries[selected]); }
      };
      return h("section", { className: "dshd-file-search", "aria-label": "Find a workspace file", onKeyDown },
        h("h2", null, "Find a file"),
        h("p", null, "Search this workspace by name, or enter a folder path to narrow the results."),
        h("div", { className: "dshd-file-search-tools" },
          h("button", { type: "button", className: "dshd-fl-btn", onClick: onClose }, "Back to files"),
          h("button", { type: "button", className: "dshd-fl-btn", disabled: loading, onClick: () => setRefresh(value => value + 1) }, "Refresh search")),
        h("input", { ref: inputRef, autoFocus: true, role: "combobox", "aria-label": "File name or path", "aria-autocomplete": "list",
          "aria-expanded": true, "aria-controls": id.current, "aria-activedescendant": entries[selected] ? id.current + "-" + selected : undefined,
          placeholder: "Search files…", disabled: !root, maxLength: 256, value: query, onChange: event => setQuery(event.target.value) }),
        error ? h("p", { role: "alert" }, "Could not search files: " + error) : null,
        h("p", { role: "status" }, !root ? "No workspace available. Choose a workspace to search its files." : loading ? "Finding files…" : error ? "Use Refresh search to retry." : entries.length ? entries.length + (entries.length === 1 ? " result" : " results") : "No matching files or folders."),
        h("div", { className: "dshd-file-search-list", role: "listbox", id: id.current, "aria-label": "Matching files and folders" },
          entries.map((entry, index) => h("button", { type: "button", role: "option", id: id.current + "-" + index, key: entry.path,
            ref: index === selected ? selectedRef : undefined,
            className: "dshd-file-search-item", "aria-selected": index === selected, onClick: () => choose(entry),
            onMouseEnter: () => setSelected(index) },
            h(FileIcon, { type: entry.type === "directory" ? "folder" : classify(baseName(entry.path), false) }),
            h("span", null, h("strong", null, baseName(entry.path) + (entry.type === "directory" ? "/" : "")),
              h("small", null, entry.relativePath))))),
        h("p", { className: "dshd-file-search-help" }, "↑ ↓ to choose · Enter to open · Esc to close. Up to 50 results from 50,000 indexed paths; narrow larger projects by folder. .git and node_modules are excluded."));
    }

    async function readDraftInventory(onBatch, signal) {
      const response = await fetch(API + "/drafts/stream", { credentials: "same-origin", signal });
      if (!response.ok) throw new Error("Draft scan request failed (" + response.status + ").");
      if (!response.body?.getReader) throw new Error("This browser cannot stream recovery results.");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", finished = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            if (end > 1024 * 1024) throw new Error("Invalid draft inventory response.");
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            if (!line) continue;
            const batch = JSON.parse(line);
            if (batch.error) throw new Error(batch.error);
            if (!Array.isArray(batch.drafts) || typeof batch.done !== "boolean"
              || !Number.isInteger(batch.scanned) || batch.scanned < 0
              || !Number.isInteger(batch.unreadable) || batch.unreadable < 0 || batch.unreadable > batch.scanned
              || batch.drafts.some(entry => !entry || typeof entry.path !== "string" || !entry.path
                || typeof entry.root !== "string" || typeof entry.revision !== "string"
                || typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))
                || !Number.isInteger(entry.bytes) || entry.bytes < 0)) throw new Error("Invalid draft inventory response.");
            signal.throwIfAborted();
            onBatch(batch); finished = batch.done;
          }
          if (buffer.length > 1024 * 1024) throw new Error("Invalid draft inventory response.");
          if (done) break;
        }
        if (!finished || buffer.trim()) throw new Error("Draft scan was interrupted. Refresh to finish loading backups.");
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }

    function RecoveryPanel({ active = true, onOpen, onDiscard, onClose }) {
      const [inventory, setInventory] = useState(null);
      const [refresh, setRefresh] = useState(0);
      const [query, setQuery] = useState("");
      const [page, setPage] = useState(0);
      const scan = useRef(null);
      const reviewRegion = useRef(null);
      const [review, setReview] = useState(null);
      const [loading, setLoading] = useState(false);
      const [actionBusy, setBusy] = useState(false);
      const [reading, setReading] = useState(false);
      const busy = actionBusy || reading;
      const [confirm, setConfirm] = useState(false);
      const [error, setError] = useState("");
      const [message, setMessage] = useState("");
      const request = useRef(0);
      useEffect(() => {
        if (!active) return;
        let live = true;
        const controller = new AbortController(), records = new Map();
        scan.current = controller;
        setLoading(true); setInventory(null); setPage(0); setError("");
        readDraftInventory(batch => {
          if (!live) return;
          for (const entry of batch.drafts) records.set(entry.path, entry);
          const drafts = Array.from(records.values());
          if (batch.done) drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.path.localeCompare(b.path));
          setInventory({ ...batch, drafts });
        }, controller.signal)
          .catch(reason => { if (live) setError(controller.signal.aborted
            ? "Scan stopped. Loaded drafts remain available; refresh to check the remaining backups."
            : "Could not finish listing drafts: " + reason.message); })
          .finally(() => { if (live) setLoading(false); });
        return () => { live = false; controller.abort(); request.current += 1; setReading(false); };
      }, [active, refresh]);
      useEffect(() => { if (review) reviewRegion.current?.focus(); }, [review]);
      async function inspect(entry) {
        const id = ++request.current;
        setReview(null); setConfirm(false); setError(""); setMessage(""); setReading(true);
        const [saved, disk] = await Promise.allSettled([
          api("/draft?path=" + encodeURIComponent(entry.path)), api("/read?path=" + encodeURIComponent(entry.path)),
        ]);
        if (id !== request.current) return;
        setReading(false);
        if (saved.status === "rejected" || !saved.value.draft) {
          setError(saved.status === "rejected" ? saved.reason.message : "This backup no longer exists. Refresh the list.");
          return;
        }
        setReview({ entry, saved: saved.value.draft, disk: disk.status === "fulfilled" ? disk.value : null,
          diskError: disk.status === "rejected" ? disk.reason.message : "" });
      }
      async function act(kind) {
        if (!review || busy) return;
        setBusy(true); setError(""); setMessage("");
        try {
          if (kind === "open") await onOpen({ ...review.saved, root: review.entry.root });
          else {
            await onDiscard(review.saved);
            setReview(null); setConfirm(false); setRefresh(value => value + 1);
            setMessage("Draft discarded. The project file has not been changed.");
          }
        } catch (reason) { setError(reason.message); }
        finally { setBusy(false); }
      }
      const entries = useMemo(() => (inventory?.drafts || []).filter(entry => entry.path.toLowerCase().includes(query.toLowerCase())), [inventory?.drafts, query]);
      const pages = Math.max(1, Math.ceil(entries.length / 50));
      const currentPage = Math.min(page, pages - 1);
      const visibleEntries = entries.slice(currentPage * 50, (currentPage + 1) * 50);
      const changed = review?.disk?.kind === "text" && (review.disk.version !== review.saved.base.version || review.disk.text !== review.saved.base.text);
      return h("section", { className: "dshd-recovery", "aria-label": "Draft recovery" },
        h("h2", null, "Recover your work"),
        h("p", null, "Saved drafts from your available workspaces. Opening a draft does not change the project file."),
        h("div", { className: "dshd-recovery-actions" },
          h("button", { type: "button", className: "dshd-fl-btn", onClick: onClose, disabled: busy }, "Back to files"),
          h("button", { type: "button", className: "dshd-fl-btn", onClick: () => setRefresh(value => value + 1), disabled: busy || loading }, "Refresh drafts"),
          loading ? h("button", { type: "button", className: "dshd-fl-btn", onClick: () => scan.current?.abort() }, "Stop scanning") : null),
        error ? h("p", { role: "alert" }, error) : null,
        message ? h("p", { role: "status" }, message) : null,
        inventory?.unreadable ? h("p", { role: "status" }, "Some backup records could not be read. They have been preserved.") : null,
        h("input", { type: "search", "aria-label": "Find a saved draft", placeholder: "Find a saved draft…", value: query, onChange: event => { setQuery(event.target.value); setPage(0); } }),
        loading ? h("p", { role: "status" }, "Scanning backups… " + (inventory?.scanned || 0) + " checked. Search covers loaded drafts until scanning finishes.") : null,
        !loading && inventory?.done && !entries.length ? h("p", null, query ? "No drafts match this search." : "No saved drafts in your available workspaces.") : null,
        entries.length ? h("div", { className: "dshd-recovery-actions", "aria-label": "Draft list pages" },
          h("button", { type: "button", className: "dshd-fl-btn", disabled: currentPage === 0 || busy, onClick: () => setPage(currentPage - 1) }, "Previous drafts"),
          h("span", { role: "status" }, "Page " + (currentPage + 1) + " of " + pages + " · " + entries.length + (inventory?.done ? " " : " loaded ") + (entries.length === 1 ? "draft" : "drafts")),
          h("button", { type: "button", className: "dshd-fl-btn", disabled: currentPage + 1 >= pages || busy, onClick: () => setPage(currentPage + 1) }, "Next drafts")) : null,
        h("div", { className: "dshd-recovery-list" }, visibleEntries.map(entry =>
          h("button", { type: "button", key: entry.path, className: "dshd-fl-btn dshd-recovery-item", disabled: busy,
            "aria-label": "Review draft: " + entry.path, onClick: () => inspect(entry) },
            h("strong", null, baseName(entry.path)), h("small", null, entry.path),
            h("small", null, new Date(entry.updatedAt).toLocaleString() + " · " + formatBytes(entry.bytes))))),
        busy ? h("p", { role: "status" }, "Working…") : null,
        review ? h("div", { ref: reviewRegion, tabIndex: -1, role: "region", "aria-label": "Review saved draft" },
          h("h3", null, review.entry.path),
          h("p", null, changed ? "The disk file changed since this draft began. Saving the draft will require resolving that conflict."
            : review.disk?.kind === "text" ? "The disk file still matches this draft's starting version."
            : "The current disk file could not be read as text. Your draft is still available."),
          review.diskError ? h("p", { role: "status" }, "Disk read: " + review.diskError) : null,
          h("div", { className: "dshd-recovery-compare" },
            h("label", null, "Saved draft", h("textarea", { readOnly: true, "aria-label": "Saved draft contents", value: review.saved.text })),
            review.disk?.kind === "text" ? h("label", null, "Current disk file", h("textarea", { readOnly: true, "aria-label": "Current disk contents", value: review.disk.text })) : null),
          h("details", null, h("summary", null, "Original file when editing began"),
            h("textarea", { readOnly: true, "aria-label": "Original file contents", value: review.saved.base.text })),
          h("div", { className: "dshd-recovery-actions" },
            h("button", { type: "button", className: "dshd-fl-btn is-primary", disabled: busy, onClick: () => act("open") }, "Open draft in editor"),
            h("button", { type: "button", className: "dshd-fl-btn", disabled: busy, onClick: async () => {
              try { await window.navigator.clipboard.writeText(review.saved.text); setMessage("Saved draft copied."); }
              catch { setError("Could not copy the draft. You can select its text above."); }
            } }, "Copy saved draft"),
            h("button", { type: "button", className: "dshd-fl-btn", disabled: busy, onClick: () => setConfirm(true) }, "Discard…")),
          confirm ? h("div", null, h("p", null, "Discard this saved draft and matching editor changes? The project file will stay as it is."),
            h("div", { className: "dshd-recovery-actions" },
              h("button", { type: "button", className: "dshd-fl-btn", disabled: busy, onClick: () => act("discard") }, "Discard saved draft"),
              h("button", { type: "button", className: "dshd-fl-btn", disabled: busy, onClick: () => setConfirm(false) }, "Keep draft"))) : null) : null);
    }

    /* ── The view ──────────────────────────────────────────────────────── */

    function FilesView({ standalone = false, active = true, sessionId, useSessions, initialPath } = {}) {
      ensureStyle();
      const sessionCwd = useSessions ? useSessions(state => sessionId ? state.byId[sessionId]?.cwd : undefined) : undefined;
      const rootSession = useRef(null);

      const [roots, setRoots] = useState([]);
      const [root, setRoot] = useState(null);
      const [refresh, setRefresh] = useState(0);
      const [dirs, setDirs] = useState({});
      const [treeReveal, setTreeReveal] = useState(null);
      const directoryRequests = useRef(new Map());
      const [open, setOpen] = useState(() => new Set());
      const [selected, setSelected] = useState(null);
      // The latest selection, readable inside an in-flight async callback whose
      // captured `selected` is stale — used so a slow read of file A cannot act
      // on the UI after the user has moved to file B.
      const selectedRef = useRef(null);
      useEffect(() => { selectedRef.current = selected; }, [selected]);
      /** path -> what is on disk, as last read. */
      const [docs, setDocs] = useFileState("docs");
      /** path -> what the editor holds. Kept per path so switching files and
       *  coming back does not silently discard an edit. */
      const [drafts, setDrafts] = useFileState("drafts");
      const [mode, setMode] = useState("view");
      const [findRequest, setFindRequest] = useState(null);
      const [note, setNote] = useState(null);
      const [pending, setPending] = useFileState("pending");
      const [backups] = useFileState("backups");
      const backup = backups[selected];
      const busy = Boolean(pending[selected]);
      const [showTree, setShowTree] = useState(true);
      const [recoveryOpen, setRecoveryOpen] = useState(false);
      const [searchOpen, setSearchOpen] = useState(false);
      const searchTrigger = useRef(null);
      const searchWasOpen = useRef(false);
      useEffect(() => {
        if (searchOpen) searchWasOpen.current = true;
        else if (searchWasOpen.current) { searchWasOpen.current = false; searchTrigger.current?.focus(); }
      }, [searchOpen]);
      // A recovery navigation must not depend on persisted preferences. The
      // root effect clears selection before opening the new project's file.
      const recoverySelection = useRef(null);
      const setFileBusy = useCallback((path, operation) => {
        setPending((previous) => { const next = { ...previous }; if (operation) next[path] = operation; else delete next[path]; return next; });
      }, [setPending]);
      const dirtyPaths = useMemo(() => new Set(Object.keys(drafts).filter((path) =>
        docs[path]?.kind === "text" && drafts[path] !== docs[path].text)), [docs, drafts]);

      // Claim the composer's space while this view is mounted, and give it back
      // on the way out — including on unmount from a tab switch, which is the
      // path that would otherwise leave the chat with no input box.
      useEffect(() => {
        if (standalone) return;
        document.body.setAttribute("data-dshd-view", "files");
        return () => {
          if (document.body.getAttribute?.("data-dshd-view") === "files")
            document.body.removeAttribute("data-dshd-view");
        };
      }, [standalone]);

      const doc = selected ? docs[selected] : null;
      const draft = selected && drafts[selected] !== undefined
        ? drafts[selected]
        : (doc && doc.kind === "text" ? doc.text : "");
      const dirty = Boolean(doc && doc.kind === "text" && drafts[selected] !== undefined
        && drafts[selected] !== doc.text);

      const loadDir = useCallback(async (path) => {
        const request = {};
        directoryRequests.current.set(path, request);
        try {
          const payload = await api("/list?path=" + encodeURIComponent(path));
          if (directoryRequests.current.get(path) !== request) return;
          setDirs((previous) => Object.assign({}, previous, { [path]: payload.entries }));
        } catch (error) {
          if (directoryRequests.current.get(path) !== request) return;
          setDirs((previous) => Object.assign({}, previous, { [path]: null }));
          setNote({ kind: "error", message: "Could not read " + baseName(path) + ": " + error.message });
        } finally {
          if (directoryRequests.current.get(path) === request) directoryRequests.current.delete(path);
        }
      }, []);
      useEffect(() => () => directoryRequests.current.clear(), []);

      // Retained tools must discover workspace changes when shown again. Keep
      // the current project when it is still available, including its editor.
      useEffect(() => {
        if (!active) return;
        let live = true;
        api("/roots").then((payload) => {
          if (!live) return;
          const items = [];
          for (const item of payload.roots || []) {
            const path = item.canonicalPath || item.path;
            const existing = items.find(root => root.path === path);
            if (existing) existing.aliases.push(item.path);
            else items.push({ ...item, path, aliases: [item.path] });
          }
          setRoots(items);
          let saved = null;
          try { saved = window.localStorage.getItem(LAST_ROOT); } catch { /* private mode */ }
          const matches = (item, path) => item.path === path || item.aliases.includes(path);
          const sessionChanged = rootSession.current?.id !== sessionId || rootSession.current?.cwd !== sessionCwd;
          rootSession.current = { id: sessionId, cwd: sessionCwd };
          const contextual = items.find(item => matches(item, sessionCwd))
            || items.filter(item => [item.path,...item.aliases].some(path => sessionCwd?.startsWith(path.replace(/\/+$/, "") + "/")))
              .sort((a,b) => b.path.length-a.path.length)[0];
          setRoot(previous => ((sessionChanged || !previous) && contextual
            || items.find(item => matches(item, previous)) || contextual
            || items.find(item => matches(item, saved)) || items[0])?.path || null);
        }).catch((error) => {
          if (!live) return;
          setNote({ kind: "error", message: "Files are unavailable: " + error.message });
        });
        return () => { live = false; };
      }, [active, refresh, sessionId, sessionCwd]);

      // The chosen root's listing, and a clean slate for everything below it —
      // including the open file, which belonged to the previous root and would
      // otherwise stay shown and editable while absent from the new tree.
      useEffect(() => {
        try {
          if (root) window.localStorage.setItem(LAST_ROOT, root);
        } catch { /* private mode */ }
        directoryRequests.current.clear();
        setDirs({});
        setOpen(new Set());
        selectedRef.current = null;
        setSelected(null);
        setNote(null);
      }, [root]);

      useEffect(() => {
        if (!active || !root) return;
        loadDir(root);
        open.forEach(path => { if (path.startsWith(root.replace(/\/+$/, "") + "/")) loadDir(path); });
        // Refresh the current expanded folders on activation, not on each toggle.
      }, [active, root, refresh, loadDir]);

      const toggleDir = useCallback((path) => {
        setOpen((previous) => {
          const next = new Set(previous);
          if (next.has(path)) next.delete(path);
          else { next.add(path); }
          return next;
        });
        setDirs((previous) => {
          if (previous[path] === undefined) loadDir(path);
          return previous;
        });
      }, [loadDir]);

      const revealFile = useCallback((path, workspaceRoot, reset = false) => {
        const base = workspaceRoot?.replace(/\/+$/, "");
        if (!workspaceRoot || !path.startsWith(base + "/")) return;
        setTreeReveal({ path });
        const parts = path.slice(base.length + 1).split("/"); parts.pop();
        let parent = base;
        const parents = parts.map(part => (parent += "/" + part));
        setOpen(previous => new Set([...(reset ? [] : previous), ...parents]));
        parents.forEach(loadDir);
      }, [loadDir]);

      const openFile = useCallback(async (entry) => {
        setFindRequest(null);
        selectedRef.current = entry.path;
        setSelected(entry.path);
        setMode("view");
        setNote(null);
        try { window.localStorage.setItem(LAST_FILE, entry.path); } catch { /* private mode */ }

        // Media is decided from the name, not by reading it: asking the seam for
        // the text of an mp4 would round-trip the whole file only to be told it
        // is not UTF-8.
        const family = classify(entry.name || baseName(entry.path), false);
        if (MEDIA[family]) {
          setDocs((previous) => Object.assign({}, previous,
            { [entry.path]: { kind: "media", path: entry.path, size: entry.size } }));
          return;
        }
        if (FILE_MEMORY.pending[entry.path]) return;
        if (FILE_MEMORY.docs[entry.path] && FILE_MEMORY.drafts[entry.path] !== undefined) {
          setMode("edit");
          return;
        }

        setFileBusy(entry.path, "read");
        try {
          const recovered = await readBackup(entry.path);
          if (recovered) {
            setDocs((previous) => ({ ...previous, [entry.path]: {
              kind: "text", path: entry.path, text: recovered.base.text, version: recovered.base.version,
              size: new TextEncoder().encode(recovered.base.text).length,
            } }));
            setDrafts((previous) => ({ ...previous, [entry.path]: recovered.text }));
            if (selectedRef.current === entry.path) {
              setMode("edit");
              setNote({ kind: "ok", message: "Recovered your unsaved draft. The disk file has not been changed." });
            }
            return;
          }
          const payload = await api("/read?path=" + encodeURIComponent(entry.path));
          setDocs((previous) => Object.assign({}, previous, { [entry.path]: payload }));
          // Text opens ready to type. An editor that opens read-only and asks
          // for a second click before it will take a character is the single
          // thing that made this pane feel like a viewer; anything the harness
          // will not let us edit still opens in the reading view.
          //
          // Only touch the shared view mode if this file is still the selected
          // one. A slow read resolving after the user switched to another file
          // and started editing would otherwise yank them out of the editor.
          if (selectedRef.current === entry.path) setMode(payload.kind === "text" ? "edit" : "view");
        } catch (error) {
          // name is absent on the session-restore path (openFile({ path });
          // fall back to the basename so the message never says "undefined".
          const label = entry.name || baseName(entry.path);
          if (selectedRef.current === entry.path) {
            setNote({ kind: "error", message: "Could not open " + label + ": " + error.message });
          }
        } finally {
          setFileBusy(entry.path, null);
        }
      }, [setDocs, setDrafts, setFileBusy]);

      // Reopen the file from last time once the root is known, so the view
      // returns where it was left rather than to an empty pane. Placed after
      // openFile so its declaration is initialised; guarded to this root so
      // switching projects does not resurrect a file from another one.
      useEffect(() => {
        if (!root) return;
        let last = initialPath || recoverySelection.current;
        recoverySelection.current = null;
        if (!last) {
          try { last = window.localStorage.getItem(LAST_FILE); } catch { /* private mode */ }
        }
        if (!last) return;
        const base = root.replace(/\/+$/, "");
        if (last.startsWith(base + "/")) {
          revealFile(last, root, true);
          openFile({ path: last });
        }
        // Intentionally keyed on root only: this is a per-root restore, not a
        // reaction to every selection change.
        // eslint-disable-next-line
      }, [root]);

      const save = useCallback(async (force, createOnly = false) => {
        if (!selected || !doc || doc.kind !== "text" || FILE_MEMORY.pending[selected]) return;
        const text = FILE_MEMORY.drafts[selected];
        if (text === undefined) return;
        setFileBusy(selected, "write");
        setNote(null);
        try {
          const payload = await api("/write", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: selected, text, version: force ? undefined : FILE_MEMORY.docs[selected].version,
              createOnly: createOnly || undefined }),
          });
          setDocs((previous) => Object.assign({}, previous,
            { [selected]: { kind: "text", path: selected, text, version: payload.version, size: new TextEncoder().encode(text).length } }));
          // Drop the draft ONLY if it still equals what we just wrote. A write
          // is async, and keystrokes typed while it was in flight live in
          // drafts[selected] now — deleting unconditionally discarded them and
          // reverted the textarea to the saved text. Keep the newer draft (it
          // stays dirty) so nothing the user typed is lost.
          setDrafts((previous) => {
            if (previous[selected] !== text) return previous;
            const next = Object.assign({}, previous); delete next[selected]; return next;
          });
          queueBackup(selected);
          if (payload.operation === "create") loadDir(selected.slice(0, selected.lastIndexOf("/")) || "/");
          // No banner for a save that worked. The button falls back to a
          // disabled "Saved", the mark beside the file name goes out and the
          // status line goes quiet — three places already say it, and a fourth
          // that has to be dismissed pushes the file down the pane every time
          // anyone presses the shortcut.
        } catch (error) {
          if (selectedRef.current !== selected) return;
          if (error.code === "FS_STALE_VERSION") {
            // The agent works in this same directory and can rewrite a file
            // while it is open here. The guarded write is what turns that from
            // a silent clobber into a question.
            setNote({ kind: "error", message: error.missing
              ? "This file was removed from disk. Your edits are still in the editor; recreate the file to save them."
              : "This file changed on disk since you opened it.", stale: true, missing: error.missing });
          } else {
            setNote({ kind: "error", message: "Could not save: " + error.message });
          }
        } finally {
          setFileBusy(selected, null);
        }
      }, [selected, doc, drafts, setDocs, setDrafts, setFileBusy, loadDir]);

      const reload = useCallback(async () => {
        if (!selected || FILE_MEMORY.pending[selected]) return;
        const previousDraft = FILE_MEMORY.drafts[selected];
        setFileBusy(selected, "read");
        try {
          const payload = await api("/read?path=" + encodeURIComponent(selected));
          setDocs((previous) => Object.assign({}, previous, { [selected]: payload }));
          setDrafts((previous) => { if (previous[selected] !== previousDraft) return previous; const next = Object.assign({}, previous); delete next[selected]; return next; });
          queueBackup(selected);
          if (selectedRef.current === selected) setNote(null);
        } catch (error) {
          if (selectedRef.current === selected) setNote({ kind: "error", message: "Could not reload: " + error.message });
        } finally {
          setFileBusy(selected, null);
        }
      }, [selected, setDocs, setDrafts, setFileBusy]);

      function differentEditorDraft(record) {
        const base = FILE_MEMORY.docs[record.path];
        const text = FILE_MEMORY.drafts[record.path];
        return text !== undefined && text !== base?.text
          && (text !== record.text || base?.text !== record.base.text || base?.version !== record.base.version);
      }
      function checkRecoveryOperation(record) {
        if (FILE_MEMORY.pending[record.path] || backupJobs.get(record.path)?.running) {
          throw new Error("This file is still saving or loading. Wait for it to finish and try again.");
        }
        if (differentEditorDraft(record)) {
          throw new Error("The editor has different unsaved changes for this file. Save or copy those edits before opening or discarding this backup.");
        }
      }
      async function restoreRecovery(record) {
        checkRecoveryOperation(record);
        const path = record.path;
        setDocs(previous => ({ ...previous, [path]: { kind: "text", path, ...record.base,
          size: new TextEncoder().encode(record.base.text).length } }));
        setDrafts(previous => ({ ...previous, [path]: record.text }));
        backupState(path, { loaded: true, revision: record.revision, state: "saved", error: null });
        try { window.localStorage.setItem(LAST_FILE, path); } catch {}
        if (root !== record.root) {
          recoverySelection.current = path;
          setRoot(record.root);
        } else revealFile(path, record.root);
        selectedRef.current = path; setSelected(path); setMode("edit");
        setNote({ kind: "ok", message: "Recovered your unsaved draft. The disk file has not been changed." });
        setRecoveryOpen(false);
      }
      async function discardRecovery(record) {
        checkRecoveryOperation(record);
        const path = record.path;
        setFileBusy(path, "discard");
        let discarded = false;
        try {
          await api("/draft", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ path, draft: null, revision: record.revision }) });
          discarded = true;
          backupState(path, { loaded: true, revision: null, state: "idle", error: null });
          // Typing in another retained editor during the request stays intact.
          if (!differentEditorDraft(record)) {
            setDocs(previous => { const next = { ...previous }; delete next[path]; return next; });
            setDrafts(previous => { const next = { ...previous }; delete next[path]; return next; });
            backupJobs.delete(path);
            if (selectedRef.current === path) { selectedRef.current = null; setSelected(null); setNote(null); }
          }
        } finally {
          setFileBusy(path, null);
          if (discarded && FILE_MEMORY.drafts[path] !== undefined) queueBackup(path);
        }
      }

      // The key event the in-view handler already took, so the window-level
      // fallback below can tell its own save apart from a second one.
      const handledKey = useRef(null);
      const onKeyDown = useCallback((event) => {
        handledKey.current = event.nativeEvent || event;
        if (!recoveryOpen && !searchOpen && doc?.kind === "text"
          && ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" || event.ctrlKey && event.key.toLowerCase() === "h")) {
          event.preventDefault(); event.stopPropagation(); setMode("edit");
          setFindRequest(previous => ({ path: selected, id: (previous?.id || 0) + 1, replace: event.altKey || event.key.toLowerCase() === "h" }));
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
          event.preventDefault(); event.stopPropagation(); setRecoveryOpen(false); setSearchOpen(true);
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          // Only take the key when there is a write to make. This handler sits
          // on the whole view, so without the guard a clean file, a dialog on
          // top, or the tree with nothing open all swallowed Cmd+S for a save
          // that then no-opped, and the shell never saw the press.
          if (!dirty || recoveryOpen || searchOpen) return;
          event.preventDefault();
          // Bound on both the textarea and the wrapper div (so Cmd+S works in
          // view mode too). Without this, a save in the editor fires the
          // handler twice as the event bubbles — two writes with the same
          // version, the second failing the version guard and popping a false
          // "changed on disk" conflict. Stop it at the first handler.
          event.stopPropagation();
          save(false);
        }
      }, [save, dirty, recoveryOpen, searchOpen, doc, selected]);

      // Save belongs to whichever file is open, not to whichever element holds
      // focus. Coming back to this tab leaves focus on the body, where the
      // handler above never sees the key and the keystroke falls through to the
      // shell. Bound only while this view is the visible one and only while
      // there is something to write, so it takes the key from nothing else, and
      // skipped for the event the in-view handler already served so one press
      // can never send two writes against the same version.
      useEffect(() => {
        if (!active || !dirty || recoveryOpen || searchOpen) return;
        const onDocumentKey = (event) => {
          if (handledKey.current === event) return;
          if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
          if (String(event.key).toLowerCase() !== "s") return;
          event.preventDefault();
          save(false);
        };
        document.addEventListener("keydown", onDocumentKey);
        return () => document.removeEventListener("keydown", onDocumentKey);
      }, [active, dirty, recoveryOpen, searchOpen, save]);

      const crumbs = useMemo(() => {
        if (!selected || !root) return null;
        const relative = selected.startsWith(root) ? selected.slice(root.length).replace(/^\//, "") : selected;
        const parts = relative.split("/").filter(Boolean);
        const leaf = parts.pop();
        return h("div", { className: "dshd-fl-crumbs", title: selected },
          h("span", null, parts.length ? parts.join(" / ") + " / " : "", h("b", null, leaf || baseName(selected)),
            dirty ? h("span", { className: "dshd-fl-dirty", title: "Unsaved changes" }) : null));
      }, [selected, root, dirty]);

      const editable = Boolean(doc && doc.kind === "text");

      /** A toolbar action: a mark, with its words in the accessible name. */
      const tool = (name, label, hint, onClick, extra) => h("button", Object.assign({
        type: "button", className: "dshd-fl-btn is-icon", "aria-label": label, title: hint, onClick,
      }, extra), h(ToolIcon, { name }));

      // One line along the bottom of the editor rather than a second band under
      // the toolbar restating it. Silent when the file is clean: a permanent
      // row announcing that nothing has happened is noise, not status.
      const editorStatus = busy ? (pending[selected] === "write" ? "Saving…" : "Reading…")
        : dirty ? (backup?.state === "saving" ? "Unsaved · backing up draft"
          : backup?.state === "saved" ? "Unsaved · draft backed up"
          : "Unsaved · ⌘ / Ctrl + S to save")
        : null;

      return h("div", { className: "dshd-fl" + (showTree ? "" : " is-tree-hidden"), onKeyDown },
        h("div", { className: "dshd-fl-side", hidden: !showTree },
          h("div", { className: "dshd-fl-sidehead" },
            roots.length > 1
              ? h("select", {
                  className: "dshd-fl-root",
                  value: root || "",
                  "aria-label": "Workspace",
                  onChange: (event) => setRoot(event.target.value),
                }, roots.map((item) => h("option", { key: item.path, value: item.path }, item.title)))
              : h("div", { className: "dshd-fl-root", title: root || "" }, root ? baseName(root) : "No workspace"),
            h("button", {
              type: "button",
              className: "dshd-fl-btn",
              onClick: () => setRefresh(value => value + 1),
              title: "Reload the tree",
            }, "Refresh")),
          root
              ? h(TreeLevel, {
                  key: root, path: root, dirs, open, selected, revealRequest: treeReveal,
                  dirtyPaths,
                  onToggle: toggleDir, onOpen: entry => { setRecoveryOpen(false); setSearchOpen(false); return openFile(entry); },
                })
              : h("div", { className: "dshd-fl-empty" },
                  h("b", null, "No workspace is open"),
                  h("span", null, "Choose a project folder to browse its files."),
                  h("button", { type: "button", className: "dshd-fl-btn", onClick: () => {
                    const add = document.querySelector('button[aria-label="Add workspace"], button[aria-label="添加工作区"]');
                    if (add) add.click();
                  } }, "Choose a project folder"))),

        h("div", { className: "dshd-fl-main" },
          searchOpen ? h(FileSearch, { root, active,
            onClose: () => setSearchOpen(false), onOpen: entry => {
              setSearchOpen(false);
              revealFile(entry.path, root); openFile(entry);
            } }) : recoveryOpen ? h(RecoveryPanel, { active, onOpen: restoreRecovery, onDiscard: discardRecovery,
            onClose: () => setRecoveryOpen(false) }) : h(React.Fragment, null,
          h("div", { className: "dshd-fl-bar" },
            tool("sidebar", "Toggle file explorer", showTree ? "Hide the file explorer" : "Show the file explorer",
              () => setShowTree((value) => !value), { "aria-pressed": showTree }),
            crumbs || h("div", { className: "dshd-fl-crumbs" }, h("span", null, "Files")),
            doc && doc.size ? h("span", { className: "dshd-fl-meta" }, formatBytes(doc.size)) : null,
            h("div", { className: "dshd-fl-tools" },
            tool("search", "Find file", "Find a file (⌘ / Ctrl + P)", () => setSearchOpen(true),
              { ref: searchTrigger, disabled: !root }),
            editable ? tool("findText", "Find in file", "Find text (⌘ / Ctrl + F)",
              () => { setMode("edit"); setFindRequest(previous => ({ path: selected, id: (previous?.id || 0) + 1 })); }) : null,
            editable ? tool("reload", "Reload",
              dirty ? "Save your changes before reloading" : "Read the latest version from disk", reload,
              { disabled: busy || dirty }) : null,
            doc && doc.kind === "text"
              ? h("button", {
                  type: "button",
                  className: "dshd-fl-btn is-icon",
                  "aria-label": "Copy",
                  title: "Copy the file's contents",
                  onClick: () => {
                    // writeText is async — awaiting the promise is what makes the
                    // "Copied." note honest. The old sync form reported success
                    // even when the write rejected (permission, no clipboard),
                    // and the rejection surfaced as an unhandled promise.
                    Promise.resolve()
                      .then(() => window.navigator.clipboard.writeText(draft))
                      .then(() => setNote({ kind: "ok", message: "Copied." }))
                      .catch((error) => setNote({ kind: "error", message: "Could not copy: " + (error && error.message ? error.message : "clipboard unavailable") }));
                  },
                }, h(ToolIcon, { name: "copy" }))
              : null,
            tool("history", "Recover drafts", "Reopen a draft backup saved on this computer",
              () => setRecoveryOpen(true))),
            editable
              ? h("div", { className: "dshd-fl-seg", role: "group", "aria-label": "View or edit" },
                  h("button", {
                    type: "button", "aria-pressed": mode === "view" ? "true" : "false",
                    onClick: () => setMode("view"),
                  }, "View"),
                  h("button", {
                    type: "button", "aria-pressed": mode === "edit" ? "true" : "false",
                    disabled: pending[selected] === "read",
                    onClick: () => setMode("edit"),
                  }, "Edit"))
              : null,
            editable
              ? h("button", {
                  type: "button",
                  className: "dshd-fl-btn is-primary",
                  disabled: !dirty || busy,
                  onClick: () => save(false),
                }, pending[selected] === "write" ? "Saving…" : dirty ? "Save changes" : "Saved")
              : null),

          note
            ? h("div", { role: note.kind === "error" ? "alert" : "status", className: "dshd-fl-note" + (note.kind === "error" ? " is-error" : "") },
                h("span", null, note.message),
                note.stale
                  ? h(React.Fragment, null,
                      note.missing
                        ? h("button", { type: "button", className: "dshd-fl-btn", disabled: busy, onClick: () => setNote(null) }, "Keep editing")
                        : h("button", { type: "button", className: "dshd-fl-btn", disabled: busy, onClick: reload }, "Discard draft & reload"),
                      h("button", { type: "button", className: "dshd-fl-btn", disabled: busy, onClick: () => save(true, note.missing) }, note.missing ? "Recreate file" : "Overwrite disk file"))
                  : h("button", { type: "button", className: "dshd-fl-btn", onClick: () => setNote(null) }, "Dismiss"))
            : null,
          backup?.state === "error"
            ? h("div", { className: "dshd-fl-note is-error", role: "alert" },
                h("span", null, "Draft backup unavailable: " + backup.error + ". Save the file to keep your edits."),
                h("button", { type: "button", className: "dshd-fl-btn", onClick: () => retryBackup(selected) }, "Retry backup"))
            : null,
          h("div", { className: "dshd-fl-body" },
            h(Viewer, {
              doc, mode, draft, onKeyDown, dirty,
              status: editorStatus,
              findRequest: findRequest?.path === selected ? findRequest : null,
              onDraft: (value) => {
                setDrafts((previous) => Object.assign({}, previous, { [selected]: value }));
                queueBackup(selected);
              },
            })))));
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.view", () =>
        ctx.slots.register(
          { name: "conversation.view", id: "files", order: 21, label: () => "Files" },
          FilesView,
        ),
      );
    }

    exports.FilesView = FilesView;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
