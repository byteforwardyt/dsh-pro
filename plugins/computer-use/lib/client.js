window.__ModuleLoader__.load({
  id: "@dsh-desktop/computer-use",
  factory: (require) => {
    const React = require("react"),
      { useEffect, useState, useRef } = React,
      h = React.createElement;
    const CSS = `
.dshd-computer{font-size:13px;line-height:1.6;display:flex;flex-direction:column;gap:16px;min-width:0}
.dshd-computer .hero{padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dshd-computer .hero svg{width:24px;height:24px;margin-bottom:8px;color:var(--dsw-alias-label-secondary)}
.dshd-computer h3{font-size:20px;line-height:28px;font-weight:500;margin:0 0 8px}
.dshd-computer p{color:var(--dsw-alias-label-secondary);margin:0}
.dshd-computer .control{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshd-computer .control span{display:block;color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:4px}
.dshd-computer button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 12px;min-height:36px;cursor:pointer;flex-shrink:0}
.dshd-computer button:disabled{opacity:.5;cursor:default}.dshd-computer button:focus-visible{outline:2px solid currentColor;outline-offset:3px}
.dshd-computer .good{color:var(--dshd-good)}.dshd-computer .warn{color:var(--dshd-warn)}.dshd-computer [role=alert]{color:var(--dshd-bad)}
.dshd-computer .footer{display:flex;gap:8px;flex-wrap:wrap}.dshd-computer .hint{font-size:12px}
.dshd-computer-status{display:block;margin-top:2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
`;
    let sessions;
    function useApproval(sessionId) {
      const [policy,setPolicy] = useState(null);
      useEffect(()=>{
        if (!sessionId || !sessions) return;
        const face = sessions.binding(sessionId)?.session?.projections.faceOf("computer-approvals");
        if (!face) return;
        const refresh = () => setPolicy(face.getSnapshot());
        refresh(); return face.subscribe(refresh);
      },[sessionId]);
      return policy;
    }
    function statusLabel(state) {
      if (!state) return "Checking…";
      if (state.state === "unsupported" || state.supported === false) return "Unavailable";
      if (state.state === "approvals-disabled") return "Approvals disabled";
      if (state.state === "driver-error") return "Driver error";
      if (state.state === "disconnected") return "Disconnected";
      if (state.state === "permissions") return "Permissions needed";
      if (state.lastError) return "Action failed";
      return state.enabled ? "Ready" : "Off";
    }
    function ComputerUseStatus({sessionId} = {}) {
      const policy = useApproval(sessionId);
      const [state, setState] = useState(null);
      useEffect(() => {
        let live = true;
        const refresh = () => window.__DSH_DESKTOP__?.computerUse?.("status").then(value => { if (live) setState(value); }).catch(() => { if(live) setState({state:"disconnected"}); });
        refresh(); const timer = setInterval(refresh, 3000);
        return () => { live = false; clearInterval(timer); };
      }, []);
      return h("span", {className:"dshd-computer-status"}, statusLabel(state?.state === "ready" && policy === "never" ? {...state,state:"approvals-disabled"} : state));
    }
    function ComputerUsePanel({sessionId} = {}) {
      const policy = useApproval(sessionId);
      const bridge = window.__DSH_DESKTOP__;
      const available = typeof bridge?.computerUse === "function";
      const [state, setState] = useState(null),
        [busy, setBusy] = useState(false),
        [error, setError] = useState("");
      const live = useRef(false),
        sequence = useRef(0);
      async function run(op) {
        if (!available) return;
        const seq = ++sequence.current;
        setBusy(true);
        setError("");
        try {
          const next = await bridge.computerUse(op);
          if (live.current && seq === sequence.current) {
            setState(next);
            setError(next.error || next.lastError || "");
          }
        } catch {
          if (live.current)
            setError(
              "Could not contact Cua Driver. Check permissions and try again.",
            );
        } finally {
          if (live.current && seq === sequence.current) setBusy(false);
        }
      }
      useEffect(() => {
        live.current = true;
        run("status");
        return () => {
          live.current = false;
          sequence.current++;
        };
      }, []);
      const supported = available && state?.supported;
      const permission = (name, granted) =>
        h(
          "div",
          { className: "control" },
          h(
            "div",
            null,
            name,
            h(
              "span",
              null,
              name === "Accessibility"
                ? "Read app controls and interact with windows."
                : "Let the selected model see requested screenshots.",
            ),
          ),
          h(
            "strong",
            { className: granted ? "good" : "warn" },
            granted ? "Allowed" : "Required",
          ),
        );
      return h(
        "div",
        { className: "dshd-computer", "aria-busy": busy },
        h(
          "div",
          { className: "hero" },
          h(
            "svg",
            {
              width: 40,
              height: 40,
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "currentColor",
              strokeWidth: 1.3,
              "aria-hidden": true,
            },
            h("path", { d: "M3 3h18v13H3ZM8 21h8m-4-5v5m3-14 5 3-3 1-1 3Z" }),
          ),
          h("h3", null, "Work across your Mac."),
          h(
            "p",
            null,
            "Ask DSH to navigate apps, inspect a window, fill in fields, and check the result. Powered by Cua Driver.",
          ),
        ),
        h(
          "div",
          { className: "control" },
          h(
            "div",
            null,
            h(
              "strong",
              { className: state?.state === "ready" && policy === "ask" && !state?.lastError ? "good" : undefined },
              "Computer use · " + statusLabel(state?.state === "ready" && policy === "never" ? {...state,state:"approvals-disabled"} : state),
            ),
            h(
              "span",
              null,
              !available
                ? "Open this page in the desktop app."
                : state?.reason || (state?.state === "disconnected" ? "The agent connection is unavailable. Restart DSH PRO." :
                    "Enable for this app session. Each computer action requests approval."),
            ),
          ),
          h(
            "button",
            {
              disabled: !supported || busy,
              onClick: () => run(state.enabled ? "disable" : "enable"),
            },
            state?.enabled ? "Turn off" : "Turn on",
          ),
        ),
        policy === "never" ? h("div",{className:"control"},
          h("div",null,h("strong",null,"Approval prompts are disabled"),h("span",null,"This session automatically rejects computer actions. Enable prompts to approve each action. Filesystem access stays the same.")),
          h("button",{disabled:busy,onClick:async()=>{
            setBusy(true); setError("");
            try {
              const live = sessions.binding(sessionId)?.session;
              if (!live) throw new Error("Reopen this session to enable approval prompts.");
              const result = await live.command("/computer-approvals");
              if (!result.ok || !result.value.matched) throw new Error(result.error?.message || "The approval command is unavailable. Restart DSH PRO.");
            } catch(error) {setError(error.message);} finally {setBusy(false);}
          }},"Enable approval prompts")) : null,
        !sessionId ? h("p",{className:"hint"},"Open Computer controls beside your session to check its approval policy.") : null,
        supported && state?.permissions
          ? h(
              React.Fragment,
              null,
              permission("Accessibility", state.permissions.accessibility),
              permission("Screen Recording", state.permissions.screenRecording),
            )
          : null,
        error ? h("p", { role: "alert" }, error) : null,
        h(
          "div",
          { className: "footer" },
          h(
            "button",
            { disabled: !available || busy, onClick: () => run("status") },
            "Check again",
          ),
          supported
            ? h(
                "button",
                { disabled: busy, onClick: () => run("permissions") },
                "Allow permissions",
              )
            : null,
          supported
            ? h(
                "button",
                { disabled: busy, onClick: () => run("screen-settings") },
                "Screen Recording settings",
              )
            : null,
        ),
        h(
          "p",
          { className: "hint" },
          "Screenshots and app content requested by your task are sent to your selected AI provider. Turning this off cancels active computer actions. It starts off each time DSH launches.",
        ),
      );
    }
    function apply(ctx) {
      sessions = ctx.sessions;
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, "computer use styles");
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "computer-use",
            order: 6.5,
            label: () => "Computer use",
          },
          ComputerUsePanel,
        ),
      );
    }
    return { apply, inject: ["slots", "sessions"], ComputerUsePanel, ComputerUseStatus };
  },
});
