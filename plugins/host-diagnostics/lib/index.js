/**
 * Desktop-only tool diagnostics. Full-access sessions have no wider sandbox
 * mode, even though upstream bash advertises escalation fields globally.
 * Drop only those redundant fields before bash validates them; restricted
 * sessions retain upstream's approval and denial behavior unchanged.
 */

export const inject = ["tools", "sandboxPolicy", "systemPrompt"];

export function omitRedundantEscalation(exec, policy) {
  if (exec?.name !== "bash" || policy?.mode !== "danger-full-access") return false;
  const args = exec.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (!Object.hasOwn(args, "sandbox_permissions") && !Object.hasOwn(args, "justification")) return false;
  const { sandbox_permissions: _mode, justification: _reason, ...ordinaryArgs } = args;
  exec.arguments = Object.freeze(ordinaryArgs);
  return true;
}

export function toolFailureDiagnostic(exec, result) {
  if (!result?.isError) return null;
  return {
    type: "dsh:diagnostic",
    source: "tool",
    level: "error",
    tool: typeof exec?.name === "string" ? exec.name : "unknown",
    // No arguments, command text, tool output, or session transcript crosses
    // this bridge. The shell redacts and bounds the error string before disk.
    message: typeof result.error?.message === "string" ? result.error.message : "Tool call failed",
  };
}

export function apply(ctx) {
  ctx.systemPrompt.context({
    name: "dsh-desktop:full-access-bash",
    order: 111,
    text: (context) => context.agent?.session
      && ctx.sandboxPolicy.resolve({ session: context.agent.session }).mode === "danger-full-access"
      ? "This session already has Full access. For bash calls, omit sandbox_permissions and justification. No wider file-access mode exists, and those fields only create invalid tool calls."
      : "",
  });

  ctx.on("tools/execute", (exec, next) => {
    const policy = ctx.sandboxPolicy.resolve(exec.agent?.session ? { session: exec.agent.session } : {});
    omitRedundantEscalation(exec, policy);
    return next();
  });

  ctx.on("tools/result", (exec, result) => {
    const event = toolFailureDiagnostic(exec, result);
    if (!event || typeof process.send !== "function") return;
    try { process.send(event); } catch { /* A closing shell cannot affect a tool result. */ }
  });
}
