import test from "node:test";
import assert from "node:assert/strict";
import { apply, omitRedundantEscalation, toolFailureDiagnostic } from "../lib/index.js";

test("Full access drops invalid and redundant Bash escalation fields before validation", () => {
  for (const mode of ["use_default", "workspace-write", "danger-full-access"]) {
    const exec = { name: "bash", arguments: Object.freeze({ command: "pwd", description: "Show working directory", sandbox_permissions: mode, justification: "No wider mode exists" }) };
    assert.equal(omitRedundantEscalation(exec, { mode: "danger-full-access" }), true);
    assert.deepEqual(exec.arguments, { command: "pwd", description: "Show working directory" });
  }
});

test("restricted sessions preserve escalation validation and approval", () => {
  const args = Object.freeze({ command: "pwd", sandbox_permissions: "danger-full-access", justification: "Need access" });
  const exec = { name: "bash", arguments: args };
  assert.equal(omitRedundantEscalation(exec, { mode: "workspace-write" }), false);
  assert.equal(exec.arguments, args);
  assert.equal(omitRedundantEscalation({ ...exec, name: "other" }, { mode: "danger-full-access" }), false);
});

test("tool diagnostics include failure metadata but no call arguments or output", () => {
  const event = toolFailureDiagnostic(
    { name: "bash", arguments: { command: "secret command" }, callId: "private-call" },
    { isError: true, error: { message: "invalid escalation" }, content: [{ text: "secret output" }] },
  );
  assert.deepEqual(event, { type: "dsh:diagnostic", source: "tool", level: "error", tool: "bash", message: "invalid escalation" });
  assert.equal(toolFailureDiagnostic({ name: "bash" }, { isError: false }), null);
});

test("plugin registers a Full-access instruction and normalizes through tools/execute", async () => {
  const handlers = new Map();
  let context;
  const ctx = {
    sandboxPolicy: { resolve: ({ session } = {}) => ({ mode: session?.mode || "workspace-write" }) },
    systemPrompt: { context: (entry) => { context = entry; } },
    on: (event, handler) => handlers.set(event, handler),
  };
  apply(ctx);
  assert.match(context.text({ agent: { session: { mode: "danger-full-access" } } }), /omit sandbox_permissions/);
  assert.equal(context.text({ agent: { session: { mode: "workspace-write" } } }), "");
  const exec = { name: "bash", agent: { session: { mode: "danger-full-access" } }, arguments: Object.freeze({ command: "pwd", sandbox_permissions: "use_default" }) };
  let called = false;
  await handlers.get("tools/execute")(exec, () => { called = true; return Promise.resolve("done"); });
  assert.equal(called, true);
  assert.deepEqual(exec.arguments, { command: "pwd" });

  const sent = [];
  const originalSend = process.send;
  process.send = (event) => { sent.push(event); return true; };
  try {
    handlers.get("tools/result")({ name: "bash", arguments: { command: "secret" } }, { isError: true, error: { message: "invalid escalation" } });
    handlers.get("tools/result")({ name: "bash" }, { isError: false });
  } finally {
    if (originalSend === undefined) delete process.send;
    else process.send = originalSend;
  }
  assert.deepEqual(sent, [{ type: "dsh:diagnostic", source: "tool", level: "error", tool: "bash", message: "invalid escalation" }]);
});
