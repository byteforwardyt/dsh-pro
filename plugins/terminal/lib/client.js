/**
 * Terminal dock — browser half. Shell uses the PTY/xterm adapter in pty-view.js.
 * Agent commands retains the bounded transcript and command-completion UI below.
 *
 * A real shell below Chat, Trajectory, Preview and Files, running in the
 * folder the conversation is bound to. The host keeps one long-lived shell per
 * session and streams its output as NDJSON; this pane is the transcript, the
 * input line, and the honest reporting of everything that can go wrong with a
 * shell — which is a lot, and none of it should look like a hung spinner.
 *
 * Two consequences of the host's piped-stdio design shape this file.
 *
 * THE PANE DRAWS ITS OWN PROMPT. A shell reading a pipe does not echo what it
 * is fed, so the command the user typed is written into the transcript here,
 * before it is sent. That is also why there is a text input rather than a
 * cursor: there is no line editor on the far end to receive keystrokes.
 *
 * COLOUR IS TRANSLATED, NOT EMULATED. `ansiSpans` turns SGR sequences into
 * styled spans and swallows everything else — cursor moves, OSC title writes,
 * bracketed-paste toggles — because a transcript cannot honour them and
 * printing them raw is what makes a naive terminal pane look broken. The
 * palette is mid-tone on purpose so red stays red on both the light and the
 * dark theme.
 */
window.__ModuleLoader__.load({
  id: "@dsh-desktop/terminal",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { createPortal } = require("react-dom");
    const { useState, useRef, useCallback, useEffect } = React;
    const h = React.createElement;

    const API = "/dsh-terminal";
    const SESSION_KEY = "dshd.terminal.session";
    const HISTORY_KEY = "dshd.terminal.history";

    /** Recalled commands kept per machine. Enough to be useful, not a log. */
    const MAX_HISTORY = 200;

    /** The transcript is bounded in the DOM too: a long build must not grow the page forever. */
    const MAX_BLOCKS = 600;
    const MAX_BLOCK_CHARS = 8000;
    const MAX_TRANSCRIPT_CHARS = 400000;

    /** Output is applied in batches so a fast writer cannot re-render per chunk. */
    const FLUSH_MS = 50;

    /* ── ANSI ─────────────────────────────────────────────────────────────── */

    /**
     * Mid-tone ANSI palette. Deliberately not #000/#fff at either end: this
     * pane inherits the app's background, which is near-white in the light
     * theme and near-black in the dark one, and a terminal palette tuned for
     * one of those is illegible on the other.
     */
    const BASE_COLORS = [
      "#6a6f75", "#d1383d", "#2e9e4f", "#a37200", "#2f6fd0", "#a24bc4", "#1c8b96", "#b6bcc2",
      "#8b9198", "#f2555a", "#3fb950", "#d29922", "#679efe", "#c678dd", "#39c5cf", "#e8ecef",
    ];

    /** The xterm 256-colour cube and grey ramp, computed rather than tabulated. */
    function xterm256(index) {
      if (!Number.isInteger(index) || index < 0 || index > 255) return null;
      if (index < 16) return BASE_COLORS[index];
      if (index < 232) {
        const value = index - 16;
        const level = (step) => [0, 95, 135, 175, 215, 255][step];
        return rgb(level(Math.floor(value / 36) % 6), level(Math.floor(value / 6) % 6), level(value % 6));
      }
      const grey = 8 + (index - 232) * 10;
      return rgb(grey, grey, grey);
    }

    function rgb(r, g, b) {
      const hex = (value) => Math.max(0, Math.min(255, Number(value) || 0)).toString(16).padStart(2, "0");
      return "#" + hex(r) + hex(g) + hex(b);
    }

    const EMPTY_STYLE = {
      fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false,
    };

    function styleValue(style) {
      for (const key of Object.keys(EMPTY_STYLE)) {
        if (style[key] !== EMPTY_STYLE[key]) return { ...style };
      }
      return null;
    }

    /**
     * Apply one SGR parameter list. Colon-separated sub-parameters are
     * normalised to semicolons first: both spellings appear in the wild and
     * only the code that reads them differs.
     */
    function applySgr(style, params) {
      const codes = params.replace(/:/g, ";").split(";").map((part) => (part === "" ? 0 : Number(part)));
      for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i];
        if (!Number.isFinite(code)) continue;
        if (code === 0) Object.assign(style, EMPTY_STYLE);
        else if (code === 1) style.bold = true;
        else if (code === 2) style.dim = true;
        else if (code === 3) style.italic = true;
        else if (code === 4) style.underline = true;
        else if (code === 7) style.inverse = true;
        else if (code === 22) { style.bold = false; style.dim = false; }
        else if (code === 23) style.italic = false;
        else if (code === 24) style.underline = false;
        else if (code === 27) style.inverse = false;
        else if (code >= 30 && code <= 37) style.fg = BASE_COLORS[code - 30];
        else if (code >= 90 && code <= 97) style.fg = BASE_COLORS[code - 90 + 8];
        else if (code >= 40 && code <= 47) style.bg = BASE_COLORS[code - 40];
        else if (code >= 100 && code <= 107) style.bg = BASE_COLORS[code - 100 + 8];
        else if (code === 39) style.fg = null;
        else if (code === 49) style.bg = null;
        else if (code === 38 || code === 48) {
          const target = code === 38 ? "fg" : "bg";
          if (codes[i + 1] === 5) { style[target] = xterm256(codes[i + 2]); i += 2; }
          else if (codes[i + 1] === 2) { style[target] = rgb(codes[i + 2], codes[i + 3], codes[i + 4]); i += 4; }
        }
      }
    }

    /**
     * Match one escape sequence starting at `start`.
     *
     * @returns its length and, for SGR, its parameters — or null when the
     *   sequence is INCOMPLETE, which is the case that matters: a chunk
     *   boundary can fall inside an escape, and printing the half that arrived
     *   is exactly the garbage this parser exists to prevent.
     */
    function matchEscape(input, start) {
      const next = input[start + 1];
      if (next === undefined) return null;
      if (next === "[") {
        let i = start + 2;
        while (i < input.length && input[i] >= "\u0030" && input[i] <= "\u003f") i += 1;
        while (i < input.length && input[i] >= "\u0020" && input[i] <= "\u002f") i += 1;
        if (i >= input.length) return null;
        const final = input[i];
        return { length: i - start + 1, sgr: final === "m" ? input.slice(start + 2, i) : null };
      }
      if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
        // Terminated by BEL or by ST (ESC backslash).
        for (let i = start + 2; i < input.length; i += 1) {
          if (input[i] === "\u0007") return { length: i - start + 1, sgr: null };
          if (input[i] === "\u001b" && input[i + 1] === "\\") return { length: i - start + 2, sgr: null };
          if (input[i] === "\u001b" && i + 1 >= input.length) return null;
        }
        return null;
      }
      return { length: 2, sgr: null };
    }

    /**
     * Translate a chunk of terminal output into styled spans.
     *
     * @param text - the chunk.
     * @param state - the previous call's `state`, carrying both the current SGR
     *   style and any trailing partial escape. Omit it to start clean.
     * @returns `{ spans, state }`, where a span is `{ text, style }` and `style` is
     *   null for unstyled runs.
     */
    function ansiSpans(text, state) {
      const style = { ...EMPTY_STYLE, ...(state && state.style ? state.style : null) };
      const input = (state && state.pending ? state.pending : "") + (text == null ? "" : String(text));
      const spans = [];
      let plain = "";
      let pending = "";
      let i = 0;
      const flush = () => {
        if (!plain) return;
        spans.push({ text: plain, style: styleValue(style) });
        plain = "";
      };
      while (i < input.length) {
        const character = input[i];
        if (character === "\u001b") {
          const escape = matchEscape(input, i);
          if (escape === null) { pending = input.slice(i); break; }
          if (escape.sgr !== null) { flush(); applySgr(style, escape.sgr); }
          i += escape.length;
          continue;
        }
        if (character === "\r") {
          // A lone carriage return redraws the line. With no cursor to move,
          // the frames are kept on separate lines: a progress bar reads as a
          // short column instead of one unreadable run-on line.
          plain += "\n";
          if (input[i + 1] === "\n") i += 1;
          i += 1;
          continue;
        }
        if (character === "\b") { plain = plain.slice(0, -1); i += 1; continue; }
        if (character === "\u0007") { i += 1; continue; }
        plain += character;
        i += 1;
      }
      flush();
      return { spans, state: { style, pending } };
    }

    function spanStyle(style) {
      if (!style) return undefined;
      const css = {};
      const foreground = style.inverse ? style.bg : style.fg;
      const background = style.inverse ? style.fg : style.bg;
      if (foreground) css.color = foreground;
      if (background) css.background = background;
      if (style.inverse && !background) css.background = "var(--dsw-alias-label-primary,#f9fafb)";
      if (style.inverse && !foreground) css.color = "var(--dsw-alias-bg-base,#151517)";
      if (style.bold) css.fontWeight = "600";
      if (style.dim) css.opacity = "0.7";
      if (style.italic) css.fontStyle = "italic";
      if (style.underline) css.textDecoration = "underline";
      return css;
    }

    /* ── Presentation ─────────────────────────────────────────────────────── */

    const CSS = [
      ".dshd-tm{display:flex;flex-direction:column;flex:1 1 0%;height:auto;min-height:0;min-width:0;box-sizing:border-box;",
      "background:var(--dsw-alias-bg-base,#151517);color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-tm-bar{display:flex;align-items:center;gap:10px;flex:0 0 auto;min-height:46px;padding:8px 12px;",
      "background:var(--dsw-alias-bg-layer-1,#19191b);",
      "border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12))}",
      ".dshd-tm-where{display:flex;flex-direction:column;min-width:0;gap:1px}",
      ".dshd-tm-where strong{font:500 13px/18px ui-sans-serif,sans-serif;white-space:nowrap;",
      "overflow:hidden;text-overflow:ellipsis}",
      ".dshd-tm-where span{font:11px/15px ui-sans-serif,sans-serif;white-space:nowrap;overflow:hidden;",
      "text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-tm-spacer{flex:1 1 auto;min-width:8px}",
      ".dshd-tm-btn{flex:0 0 auto;height:28px;padding:0 11px;border-radius:8px;cursor:pointer;color:inherit;",
      "background:transparent;font:500 12px/26px ui-sans-serif,sans-serif;",
      "border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "transition:background-color var(--ds-transition-duration-fast,.1s) var(--ds-ease-in-out,ease)}",
      ".dshd-tm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      ".dshd-tm-btn:disabled{opacity:.35;cursor:default}",
      ".dshd-tm-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#679efe);outline-offset:2px}",
      ".dshd-tm-out{flex:1 1 auto;min-height:0;overflow:auto;padding:12px 14px 18px;white-space:pre-wrap;",
      "overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}",
      ".dshd-tm-out:focus-visible{outline:none}",
      ".dshd-tm-cmd{margin-top:6px;color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-tm-cmd b{font-weight:500;user-select:none;margin-right:9px;",
      "color:var(--dsw-alias-state-business-primary,#679efe)}",
      ".dshd-tm-err{color:var(--dsw-alias-state-error-primary,#f25a5a)}",
      ".dshd-tm-note{color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-tm-status{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:6px 14px;",
      "font:11px/16px ui-sans-serif,sans-serif;color:var(--dsw-alias-label-tertiary,#adb2b8);",
      "border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.07))}",
      ".dshd-tm-status[data-tone=\"error\"]{color:var(--dsw-alias-state-error-primary,#f25a5a)}",
      ".dshd-tm-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;",
      "background:var(--dsw-alias-state-success,#3fb950)}",
      ".dshd-tm-form{display:flex;align-items:center;gap:9px;flex:0 0 auto;padding:9px 14px 11px;",
      "border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.12));",
      "background:var(--dsw-alias-bg-layer-1,#19191b)}",
      ".dshd-tm-form b{flex:0 0 auto;font:500 13px/20px ui-monospace,SFMono-Regular,Menlo,monospace;",
      "color:var(--dsw-alias-state-business-primary,#679efe)}",
      ".dshd-tm-in{flex:1 1 auto;min-width:0;border:none;background:transparent;color:inherit;padding:4px 0;",
      "font:13px/20px ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}",
      ".dshd-tm-in::placeholder{color:var(--dsw-alias-label-tertiary,#adb2b8);opacity:.75}",
      ".dshd-tm-in:disabled{opacity:.5}",
      ".dshd-tm-empty{flex:1 1 auto;display:flex;flex-direction:column;gap:12px;align-items:center;",
      "justify-content:center;text-align:center;padding:40px 32px;overflow:auto}",
      ".dshd-tm-empty h3{margin:0;font:500 16px/24px ui-sans-serif,sans-serif;",
      "color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dshd-tm-empty p{margin:0;max-width:460px;font:13px/1.7 ui-sans-serif,sans-serif;",
      "color:var(--dsw-alias-label-tertiary,#adb2b8)}",
      ".dshd-tm-empty code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;",
      "background:var(--dsw-alias-bg-module-platform,#2c2d2f);padding:2px 6px;border-radius:6px}",
      ".dshd-tm-empty-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:4px}",
      ".dshd-tm-dock{height:min(36vh,360px);min-height:170px;flex:0 0 auto;display:flex;flex-direction:column;",
      "border-top:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));overflow:hidden}",
      ".dshd-tm-dock .dshd-tm{height:100%;flex:1 1 auto;min-height:0}",
      ".dshd-tm-resize{height:7px;flex:none;cursor:ns-resize;touch-action:none;background:transparent;outline-offset:-2px}",
      ".dshd-tm-resize:hover,.dshd-tm-resize:focus-visible{background:var(--dsw-alias-state-business-primary,#679efe)}",
      ".dshd-tm-toggle{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.15));",
      "border-radius:8px;background:transparent;color:inherit;font:12px ui-sans-serif,sans-serif;cursor:pointer}",
      ".dshd-tm-toggle[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}",
      "[class*=centerCol]:has(>.dshd-tm-dock){display:flex;flex-direction:column;min-height:0}",
      "[class*=centerCol]:has(>.dshd-tm-dock)>[data-slot=conversation]>[class~=wSkVaW_root]{flex:1 1 0%;height:auto;min-height:0}",
      ".dshd-tm-modes,.dshd-pty-head{display:flex;align-items:center;gap:8px;padding:6px 12px;flex:none}.dshd-tm-modes button,.dshd-pty-head button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 10px;cursor:pointer}.dshd-tm-modes button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dshd-pty{display:flex;flex-direction:column;flex:1;min-height:0;background:#191919;color:#e6e6e6}.dshd-pty-head{font-size:12px}.dshd-pty-head span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshd-pty-screen{flex:1;min-height:0;padding:0 12px 4px;overflow:hidden}.dshd-pty-status{font-size:12px;padding:2px 12px}.dshd-pty-status:empty{display:none}",
    ].join("");
    const STYLE_ID = "dshd-terminal-style";
    function ensureStyle() {
      if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
      const element = document.createElement("style");
      element.id = STYLE_ID;
      element.textContent = CSS;
      document.head.appendChild(element);
    }

    /* ── Talking to /dsh-terminal ─────────────────────────────────────────── */

    const reason = (error) => (error && error.message ? error.message : "the terminal did not answer");

    async function api(path, body) {
      const response = await fetch(API + path, {
        credentials: "same-origin",
        ...(body === undefined ? {} : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      let payload = null;
      try { payload = await response.json(); } catch { /* reported below */ }
      if (!response.ok) {
        throw new Error((payload && payload.error) || "The terminal service answered " + response.status + ".");
      }
      return payload || {};
    }

    /**
     * Read one session's NDJSON stream, handing each event to `onEvent`.
     * Returns when the host closes the stream; throws for anything else, which
     * the pane turns into a visible retry rather than a stalled tab.
     */
    async function readStream(id, since, onEvent, signal) {
      const query = "?id=" + encodeURIComponent(id) + (Number.isInteger(since) ? "&since=" + since : "");
      const response = await fetch(API + "/stream" + query, { credentials: "same-origin", signal });
      if (!response.ok) {
        let message = "The terminal stream is unavailable (" + response.status + ").";
        try { const body = await response.json(); if (body && body.error) message = body.error; } catch { /* keep the status */ }
        throw new Error(message);
      }
      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("This window cannot stream terminal output.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line) onEvent(JSON.parse(line));
          }
          if (buffer.length > 4 * 1024 * 1024) throw new Error("The terminal stream sent an oversized line.");
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
        if (typeof reader.releaseLock === "function") reader.releaseLock();
      }
    }

    function readHistory() {
      try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string").slice(-MAX_HISTORY) : [];
      } catch { return []; }
    }

    /* ── The view ─────────────────────────────────────────────────────────── */

    function TerminalView({ active = true, sessionId, useSessions, openWorkspace } = {}) {
      ensureStyle();
      // The workspace this conversation is bound to, exactly as Preview and
      // Files resolve it: a shell belongs in the folder being worked on, not in
      // whichever root happens to be first.
      const sessionCwd = useSessions
        ? useSessions((state) => (sessionId ? state.byId[sessionId]?.cwd : undefined))
        : undefined;

      const [session, setSession] = useState(null);
      const [roots, setRoots] = useState(null);
      const [blocks, setBlocks] = useState([]);
      const [failure, setFailure] = useState(null);
      const [busy, setBusy] = useState(false);
      const [draft, setDraft] = useState("");
      const [notice, setNotice] = useState(null);
      const [attempt, setAttempt] = useState(0);
      const [chosenRoot, setChosenRoot] = useState(null);

      const blocksRef = useRef([]);
      const pendingRef = useRef([]);
      const flushRef = useRef(null);
      const ansiRef = useRef({ stdout: null, stderr: null });
      const seqRef = useRef(null);
      const streamedRef = useRef(null);
      const outRef = useRef(null);
      const stickyRef = useRef(true);
      const inputRef = useRef(null);
      const historyRef = useRef(null);
      const cursorRef = useRef(-1);
      const counterRef = useRef(0);
      if (historyRef.current === null) historyRef.current = readHistory();

      /* Transcript maintenance. Blocks are appended and trimmed on a ref, then
         published in one batch, so a command printing thousands of lines costs
         a render every FLUSH_MS rather than a render per chunk. */
      const publish = useCallback(() => {
        flushRef.current = null;
        const queued = pendingRef.current;
        pendingRef.current = [];
        if (queued.length === 0) return;
        let list = blocksRef.current.slice();
        for (const item of queued) {
          const last = list[list.length - 1];
          if (item.kind === "out" && last && last.kind === "out" && last.stream === item.stream
            && last.chars + item.chars <= MAX_BLOCK_CHARS) {
            list[list.length - 1] = {
              ...last, chars: last.chars + item.chars, spans: last.spans.concat(item.spans),
            };
          } else list.push(item);
        }
        let total = list.reduce((sum, block) => sum + block.chars, 0);
        while (list.length > 0 && (list.length > MAX_BLOCKS || total > MAX_TRANSCRIPT_CHARS)) {
          total -= list[0].chars;
          list = list.slice(1);
        }
        blocksRef.current = list;
        setBlocks(list);
      }, []);

      const append = useCallback((block) => {
        counterRef.current += 1;
        pendingRef.current.push({ id: counterRef.current, ...block });
        if (flushRef.current === null) flushRef.current = setTimeout(publish, FLUSH_MS);
      }, [publish]);

      const appendText = useCallback((kind, text) => {
        append({ kind, chars: text.length, text });
      }, [append]);

      const reset = useCallback(() => {
        if (flushRef.current !== null) { clearTimeout(flushRef.current); flushRef.current = null; }
        pendingRef.current = [];
        blocksRef.current = [];
        ansiRef.current = { stdout: null, stderr: null };
        setBlocks([]);
      }, []);

      /* Connection. One effect owns the whole lifecycle: choose a root, reuse
         or open a session, then stay attached to its stream until the view is
         unmounted or a retry replaces it. */
      useEffect(() => {
        if (!active) return undefined;
        const controller = new AbortController();
        let live = true;

        const onEvent = (event) => {
          if (!live) return;
          if (typeof event.seq === "number") seqRef.current = event.seq;
          if (event.kind === "session") {
            setSession(event.session);
            setBusy(Boolean(event.session.pendingRunId));
            // A gap the ring could not fill is the one case appending would
            // silently lie about, so the transcript is replaced instead.
            if (event.truncated) {
              reset();
              appendText("note", "[earlier output was dropped to keep memory bounded]");
            }
            return;
          }
          if (event.kind === "chunk") {
            const previous = ansiRef.current[event.stream] || null;
            const parsed = ansiSpans(event.text, previous);
            ansiRef.current[event.stream] = parsed.state;
            if (parsed.spans.length > 0) {
              append({ kind: "out", stream: event.stream, chars: event.text.length, spans: parsed.spans });
            }
            return;
          }
          if (event.kind === "done") {
            setBusy(false);
            if (event.exitCode !== 0) appendText("note", "[exit " + event.exitCode + "]");
            return;
          }
          if (event.kind === "exit") {
            setBusy(false);
            setSession((current) => (current ? { ...current, running: false, exitCode: event.exitCode } : current));
            return;
          }
          if (event.kind === "error") setFailure(event.message);
        };

        (async () => {
          try {
            setFailure(null);
            const state = await api("/sessions");
            if (!live) return;
            setRoots(state.roots || []);

            const wanted = chosenRoot || sessionCwd
              || (state.roots || []).find((root) => root.registered)?.path
              || null;
            // No folder has been opened and none was chosen: say so rather than
            // starting a shell somewhere the user never picked.
            if (!wanted) return;

            const remembered = localStorage.getItem(SESSION_KEY);
            let chosen = (state.sessions || []).find((row) =>
              row.id === remembered && row.running && row.cwd === wanted)
              || (state.sessions || []).find((row) => row.running && row.cwd === wanted);
            if (!chosen) chosen = (await api("/open", { cwd: wanted })).session;
            if (!live) return;
            localStorage.setItem(SESSION_KEY, chosen.id);
            setSession(chosen);
            // Sequence numbers belong to one session. Resuming a different
            // shell from the previous one's offset would skip its history and
            // splice two transcripts together, so a new id starts clean.
            if (streamedRef.current !== chosen.id) {
              reset();
              seqRef.current = null;
              streamedRef.current = chosen.id;
            }
            // COLUMNS is what makes ls and git log --graph lay out for this
            // pane instead of an assumed 80. There is no pty and so no ioctl,
            // so the host exports it for the next command instead.
            const node = outRef.current;
            const width = node && typeof node.clientWidth === "number" ? node.clientWidth : 0;
            if (width > 0) {
              const cols = Math.max(20, Math.min(500, Math.floor((width - 28) / 7.2)));
              await api("/resize", { id: chosen.id, cols, rows: 24 }).catch(() => {});
            }
            await readStream(chosen.id, seqRef.current, onEvent, controller.signal);
            // A clean end of stream means the shell exited; the exit event has
            // already been rendered, so there is nothing to report here.
          } catch (error) {
            if (!live || controller.signal.aborted) return;
            setFailure(reason(error));
          }
        })();

        return () => { live = false; controller.abort(); };
      }, [active, sessionCwd, attempt, chosenRoot, append, appendText, reset]);

      useEffect(() => () => {
        if (flushRef.current !== null) clearTimeout(flushRef.current);
      }, []);

      /* Auto-scroll, surrendered the moment the user scrolls up so reading
         back through a build is not fought by every new line. */
      useEffect(() => {
        const node = outRef.current;
        if (!node || !stickyRef.current || typeof node.scrollHeight !== "number") return;
        node.scrollTop = node.scrollHeight;
      }, [blocks]);

      const onScroll = useCallback((event) => {
        const node = event && event.currentTarget;
        if (!node || typeof node.scrollHeight !== "number") return;
        stickyRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }, []);

      const remember = useCallback((command) => {
        const list = historyRef.current.filter((entry) => entry !== command);
        list.push(command);
        historyRef.current = list.slice(-MAX_HISTORY);
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(historyRef.current)); } catch { /* history is a convenience */ }
      }, []);

      const submit = useCallback(async (event) => {
        if (event && event.preventDefault) event.preventDefault();
        const command = draft.trim();
        if (!command || !session || !session.running) return;
        setDraft("");
        setNotice(null);
        cursorRef.current = -1;
        stickyRef.current = true;
        // While a command runs, the shell is not reading commands — the
        // program is reading its own stdin. Typing then answers the prompt it
        // printed, which is the only way to get past an npm init or a sudo
        // password without killing the command.
        if (busy) {
          appendText("cmd", command);
          try {
            await api("/input", { id: session.id, data: command + "\n" });
          } catch (error) { appendText("note", "[" + reason(error) + "]"); }
          return;
        }
        remember(command);
        // The far end is a pipe and cannot echo, so the prompt line is drawn
        // here — before the send, so it is never out of order with the output.
        appendText("cmd", command);
        setBusy(true);
        try {
          await api("/run", { id: session.id, command });
        } catch (error) {
          setBusy(false);
          appendText("note", "[" + reason(error) + "]");
        }
      }, [draft, busy, session, remember, appendText]);

      const interrupt = useCallback(async () => {
        if (!session || !session.running) return;
        try {
          const result = await api("/signal", { id: session.id, signal: "SIGINT" });
          // "Sent" is not the news; whether it worked is. A command that
          // catches SIGINT and carries on used to be reported here as nothing
          // having been running, which is the opposite of what happened.
          setNotice(result.interrupted
            ? "The command stopped."
            : (result.reason || "The command did not stop."));
        } catch (error) {
          setNotice(reason(error));
        }
      }, [session]);

      const restart = useCallback(async () => {
        if (session) await api("/close", { id: session.id }).catch(() => {});
        localStorage.removeItem(SESSION_KEY);
        reset();
        seqRef.current = null;
        setSession(null);
        setBusy(false);
        setAttempt((value) => value + 1);
      }, [session, reset]);

      const onKeyDown = useCallback((event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const list = historyRef.current;
          if (list.length === 0) return;
          event.preventDefault();
          const position = cursorRef.current === -1 && event.key === "ArrowUp"
            ? list.length - 1
            : cursorRef.current + (event.key === "ArrowUp" ? -1 : 1);
          if (position < 0) { cursorRef.current = 0; setDraft(list[0]); return; }
          if (position >= list.length) { cursorRef.current = -1; setDraft(""); return; }
          cursorRef.current = position;
          setDraft(list[position]);
          return;
        }
        if (event.ctrlKey && (event.key === "c" || event.key === "C")) {
          // A selection means copy, which is what the user expects from a
          // terminal too; only an empty selection is an interrupt.
          const target = event.target || {};
          if (target.selectionStart !== undefined && target.selectionStart !== target.selectionEnd) return;
          event.preventDefault();
          interrupt();
          return;
        }
        if (event.ctrlKey && (event.key === "l" || event.key === "L")) {
          event.preventDefault();
          reset();
        }
      }, [interrupt, reset]);

      const running = Boolean(session && session.running);
      const fallbackRoot = (roots || []).find((root) => !root.registered) || null;
      const hasWorkspace = Boolean(sessionCwd || chosenRoot || (roots || []).some((root) => root.registered));

      // No folder is open. This is a real state with a real answer, not an
      // error and not a spinner.
      if (roots !== null && !hasWorkspace) {
        return h("div", { className: "dshd-tm" },
          h("div", { className: "dshd-tm-empty" },
            h("h3", null, "No workspace is open"),
            h("p", null, "A terminal only runs inside a folder you have opened, so that a command "
              + "cannot reach the rest of your disk by accident. Open a project folder and this "
              + "pane will start a shell there."),
            fallbackRoot
              ? h("p", null, "You can also start one in ", h("code", null, fallbackRoot.path),
                  ", the folder the app itself was launched from.")
              : null,
            h("div", { className: "dshd-tm-empty-actions" },
              h("button", { type: "button", className: "dshd-tm-btn",
                onClick: () => {
                  // The harness already owns a directory picker ("Add workspace").
                  // Opening that is the offer; inventing a second picker here
                  // would drift from the one the sidebar uses.
                  if (typeof openWorkspace === "function") { openWorkspace(); return; }
                  const add = document.querySelector('button[aria-label="Add workspace"], button[aria-label="添加工作区"]');
                  if (add) add.click();
                } }, "Choose a project folder"),
              fallbackRoot
                ? h("button", { type: "button", className: "dshd-tm-btn",
                    onClick: () => setChosenRoot(fallbackRoot.path) }, "Start a shell there")
                : null)));
      }

      const status = failure
        ? h("div", { className: "dshd-tm-status", "data-tone": "error", role: "alert" },
            h("span", null, failure),
            h("button", { type: "button", className: "dshd-tm-btn",
              onClick: () => { setFailure(null); setAttempt((value) => value + 1); } }, "Reconnect"))
        : session && !running
          ? h("div", { className: "dshd-tm-status", role: "status" },
              h("span", null, "The shell exited"
                + (Number.isInteger(session.exitCode) ? " with code " + session.exitCode : "") + "."),
              h("button", { type: "button", className: "dshd-tm-btn", onClick: restart }, "Start a new session"))
          : busy
            ? h("div", { className: "dshd-tm-status", role: "status" },
                h("i", { className: "dshd-tm-dot", "aria-hidden": true }),
                h("span", null, notice || "Running"),
                h("button", { type: "button", className: "dshd-tm-btn", onClick: interrupt }, "Interrupt"))
            : notice
              ? h("div", { className: "dshd-tm-status", role: "status" }, h("span", null, notice))
              : null;

      return h("div", { className: "dshd-tm" },
        h("div", { key: "bar", className: "dshd-tm-bar" },
          h("div", { className: "dshd-tm-where" },
            h("strong", null, session ? session.title : "Terminal"),
            h("span", { title: session ? session.cwd : undefined },
              session ? session.cwd + "  ·  " + session.shell : "Starting a shell…")),
          h("i", { className: "dshd-tm-spacer" }),
          h("button", { type: "button", className: "dshd-tm-btn", onClick: reset,
            "aria-label": "Clear the terminal transcript" }, "Clear"),
          h("button", { type: "button", className: "dshd-tm-btn", onClick: restart,
            "aria-label": "Restart the shell" }, "Restart")),
        h("div", { key: "out", className: "dshd-tm-out", ref: outRef, onScroll,
          role: "log", "aria-live": "polite", "aria-label": "Terminal output", tabIndex: 0 },
          blocks.map((block) => block.kind === "cmd"
            ? h("div", { key: block.id, className: "dshd-tm-cmd" }, h("b", null, "$"), block.text)
            : block.kind === "note"
              ? h("div", { key: block.id, className: "dshd-tm-note" }, block.text)
              : h("div", { key: block.id, className: block.stream === "stderr" ? "dshd-tm-err" : undefined },
                  block.spans.map((span, index) => (span.style
                    ? h("span", { key: index, style: spanStyle(span.style) }, span.text)
                    : span.text))))),
        status,
        h("form", { key: "form", className: "dshd-tm-form", onSubmit: submit },
          h("b", { "aria-hidden": true }, "$"),
          h("input", { className: "dshd-tm-in", ref: inputRef, value: draft, onKeyDown,
            onChange: (event) => setDraft(event.target.value),
            disabled: !running, spellCheck: false, autoComplete: "off", autoCorrect: "off",
            "aria-label": "Terminal command",
            placeholder: running
              ? (busy ? "Answer the running command, or Ctrl+C to interrupt it" : "Type a command, then press Enter")
              : "No shell is running" }),
          h("button", { type: "submit", className: "dshd-tm-btn", disabled: !running || !draft.trim() },
            busy ? "Send" : "Run")));
    }

    let emulatorAssets;
    function loadEmulator() {
      if (!emulatorAssets) emulatorAssets = (async () => {
        const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = API + '/assets/xterm.css'; document.head.appendChild(css);
        for (const name of ['xterm.js', 'fit.js', 'pty-view.js']) await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = API + '/assets/' + name;
          script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('Could not load the terminal emulator.')) }; document.head.appendChild(script);
        });
      })().catch(error => { emulatorAssets = null; throw error; });
      return emulatorAssets;
    }

    function InteractiveTerminal({ sessionId, useSessions, openWorkspace } = {}) {
      const cwd = useSessions ? useSessions(s => sessionId ? s.byId[sessionId]?.cwd : undefined) : undefined;
      const host = useRef(null);
      const [failure, setFailure] = useState(null);
      useEffect(() => {
        let live = true, dispose;
        loadEmulator().then(async () => {
          if (!live) return;
          dispose = await window.DshPtyView(host.current, cwd, openWorkspace);
          if (!live) dispose();
        }).catch(error => { if (live) setFailure(error.message); });
        return () => { live = false; dispose?.(); };
      }, [cwd]);
      return h('div', { className: 'dshd-pty', ref: host }, failure ? h('p', { role: 'alert' }, failure) : null);
    }

    function TerminalDock(props = {}) {
      ensureStyle();
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const [commands, setCommands] = useState(false);
      const [height, setHeight] = useState(() => {
        try { const saved = Number(localStorage.getItem('dshd.terminal.height')); return Number.isFinite(saved) && saved >= 170 ? saved : 300; } catch { return 300; }
      });
      const [maximized, setMaximized] = useState(false);
      const [limit, setLimit] = useState(600);
      const drag = useRef(null);
      const origin = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const column = origin.current?.closest('[class*="centerCol"]');
        if (!column) return undefined;
        const mount = document.createElement("div");
        mount.className = "dshd-tm-dock";
        column.appendChild(mount);
        setAnchor(mount);
        const measure = () => setLimit(Math.max(170, Math.floor(column.clientHeight - 160)));
        const observer = new ResizeObserver(measure); observer.observe(column); measure();
        return () => { observer.disconnect(); drag.current = null; setAnchor(null); mount.remove(); };
      }, [open]);
      // Agent commands also has a workspace header, status row, and input form.
      // Preserve the saved shell preference when temporarily making room for them.
      const minimum = commands ? 260 : 170;
      const maximum = Math.max(minimum, limit);
      const shownHeight = maximized ? maximum : Math.min(maximum, Math.max(minimum, height));
      useEffect(() => { if (anchor) anchor.style.height = shownHeight + 'px'; }, [anchor, shownHeight]);
      useEffect(() => { try { localStorage.setItem('dshd.terminal.height', String(height)); } catch {} }, [height]);
      const resize = value => { setMaximized(false); setHeight(Math.min(maximum, Math.max(minimum, value))); };
      return h(React.Fragment, null,
        h("span", { ref: origin, hidden: true }),
        h("button", { type: "button", className: "dshd-tm-toggle",
          "data-dshd-terminal-toggle": "", "aria-expanded": String(open),
          "aria-label": open ? "Close terminal" : "Open terminal",
          onClick: () => setOpen(value => !value) },
          h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false },
            h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
            h('path', { d: 'm7 9 3 3-3 3m6 0h4' })),
          "Terminal"),
        open && anchor ? createPortal(h(React.Fragment, null,
          h('div', { className: 'dshd-tm-resize', role: 'separator', tabIndex: 0,
            'aria-label': 'Resize terminal', 'aria-orientation': 'horizontal',
            'aria-valuemin': minimum, 'aria-valuemax': maximum, 'aria-valuenow': shownHeight,
            title: 'Drag to resize; arrow keys to adjust; double-click to restore default height',
            onPointerDown: event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { y: event.clientY, height: shownHeight }; },
            onPointerMove: event => { if (drag.current) resize(drag.current.height + drag.current.y - event.clientY); },
            onPointerUp: () => { drag.current = null; }, onPointerCancel: () => { drag.current = null; }, onLostPointerCapture: () => { drag.current = null; },
            onDoubleClick: () => resize(300),
            onKeyDown: event => { const values = { ArrowUp: shownHeight + 30, ArrowDown: shownHeight - 30, Home: minimum, End: maximum }; if (Object.hasOwn(values, event.key)) { event.preventDefault(); resize(values[event.key]); } },
          }),
          h('div', { className: 'dshd-tm-modes' },
            h('button', { type: 'button', 'aria-pressed': !commands, onClick: () => setCommands(false) }, 'Shell'),
            h('button', { type: 'button', 'aria-pressed': commands, onClick: () => setCommands(true) }, 'Agent commands'),
            h('span', { className: 'dshd-tm-spacer' }),
            h('button', { type: 'button', 'aria-label': maximized ? 'Restore terminal size' : 'Maximize terminal', 'aria-pressed': maximized, onClick: () => setMaximized(value => !value) }, maximized ? 'Restore' : 'Maximize'),
            h('button', { type: 'button', 'aria-label': 'Hide terminal panel', title: 'Hide panel (shell keeps running)', onClick: () => { setOpen(false); origin.current?.parentElement?.querySelector('[data-dshd-terminal-toggle]')?.focus(); } }, 'Close')),
          commands ? h(TerminalView, { ...props, active: true }) : h(InteractiveTerminal, props)), anchor) : null);
    }

    /** Required service: the UI slot registry. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          { name: "conversation.session.header.utilities", id: "terminal-dock", order: 21, label: () => "Terminal" },
          TerminalDock,
        ),
      );
    }

    exports.TerminalView = TerminalView;
    exports.TerminalDock = TerminalDock;
    exports.InteractiveTerminal = InteractiveTerminal;
    exports.ansiSpans = ansiSpans;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
