"use strict";

// The Electron process owns the native runtime and its permission identity.
// Renderer requests can open a confirmation, but never call the driver directly.
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const TOOL_NAMES = new Set([
  "start_session",
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_accessibility_tree",
  "get_desktop_state",
  "get_screen_size",
  "get_cursor_position",
  "verify_state",
  "launch_app",
  "bring_to_front",
  "set_window_frame",
  "invoke_menu",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "move_cursor",
  "zoom",
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_pointer",
]);

function createComputerUse({ loadSDK, platform = process.platform, isConnected = () => true } = {}) {
  let lastError = "";
  let sdkPromise, driver, starting, stopping;
  let generation = 0;
  const pending = new Map();
  const sdk = () => (sdkPromise ||= loadSDK());

  async function status() {
    if (platform !== "darwin")
      return {
        supported: false,
        enabled: false,
        state: "unsupported",
        reason: "Computer use currently requires macOS.",
      };
    try {
      const permissions = (await sdk()).currentMacOsPermissionStatus();
      return {
        supported: true,
        enabled: !!driver,
        permissions,
        connected: isConnected(),
        state: !isConnected() ? "disconnected" : !permissions.accessibility || !permissions.screenRecording ? "permissions" : driver ? "ready" : "off",
        lastError,
        busy: pending.size > 0,
        version: "0.24.0",
      };
    } catch (error) {
      return {
        supported: true, enabled: false, state: "driver-error",
        error: "Computer driver could not load: " + (error?.message || "unknown native runtime error"),
      };
    }
  }

  async function enable() {
    if (driver) return status();
    if (starting) return starting;
    if (stopping) await stopping;
    const epoch = generation;
    starting = (async () => {
      const state = await status();
      if (!state.supported || state.error) return state;
      if (!state.connected) return { ...state, error: "The agent connection is unavailable. Reopen the session or restart DSH PRO." };
      if (
        !state.permissions.accessibility ||
        !state.permissions.screenRecording
      ) {
        return {
          ...state,
          error:
            "Allow Accessibility and Screen Recording for DSH PRO in System Settings, then check again.",
        };
      }
      const native = await sdk();
      if (epoch !== generation) return status();
      driver = native.CuaDriver.createConfigured({
        claudeCodeCompatibility: false,
        authorization: {
          allowedModes: [native.SessionPermissionMode.Standard],
          compatibilityMode: native.SessionPermissionMode.Standard,
          unrestrictedAcknowledged: false,
          maxSessionTtlSeconds: 3600n,
          maxIdleTtlSeconds: 300n,
        },
      });
      lastError = "";
      return status();
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function disable() {
    generation++;
    for (const entry of pending.values()) entry.controller.abort();
    const old = driver;
    driver = null;
    if (old) {
      stopping = (async () => {
        try {
          await old.shutdown();
        } finally {
          old.uniffiDestroy();
        }
      })().finally(() => {
        stopping = null;
      });
    }
    if (stopping) await stopping;
    return { enabled: false, supported: platform === "darwin" };
  }

  async function control(operation) {
    if (operation === "status") return status();
    if (operation === "disable") return disable();
    if (operation === "enable") return enable();
    if (platform !== "darwin") return status();
    if (operation === "permissions") {
      (await sdk()).requestMacOsPermissions();
      return status();
    }
    if (operation === "screen-settings") {
      (await sdk()).openMacOsScreenRecordingSettings();
      return status();
    }
    throw new Error("Unknown computer-use control.");
  }

  // Only the private pipe of our own harness child can reach this method.
  async function receive(message, child) {
    if (
      message?.channel !== "dsh-computer" ||
      typeof message.id !== "string" ||
      message.id.length > 80
    )
      return;
    const id = message.id;
    if (message.op === "cancel") {
      const entry = pending.get(id);
      if (entry?.child === child) entry.controller.abort();
      return;
    }
    const reply = (data) => {
      if (child.connected)
        child.send({ channel: "dsh-computer-result", id, ...data }, () => {});
    };
    if (pending.has(id)) return;
    try {
      if (message.op === "status") {
        reply({ result: await status() });
        return;
      }
      if (!driver)
        throw new Error(
          "Computer use is off. The user can enable it in Settings → Computer use.",
        );
      if (message.op !== "catalog" && message.op !== "call")
        throw new Error("Unknown computer-use request.");
      if (pending.size)
        throw new Error(
          "Another computer action is running. Wait for it to finish.",
        );
      const controller = new AbortController();
      const runtime = driver;
      pending.set(id, { child, controller });
      const timer = setTimeout(() => controller.abort(), 90000);
      try {
        const catalog = JSON.parse(
          await runtime.listToolsJson({ signal: controller.signal }),
        );
        const tools = catalog.tools.filter((tool) => TOOL_NAMES.has(tool.name)).map(tool => {
          const inputSchema = {...tool.inputSchema, properties:{...tool.inputSchema?.properties}};
          delete inputSchema.properties.debug_image_out;
          delete inputSchema.properties.screenshot_out_file;
          return {name:tool.name,description:tool.description,inputSchema};
        });
        if (message.op === "catalog") {
          reply({
            result: {
              tools: message.tool
                ? tools.filter((t) => t.name === message.tool)
                : tools.map((t) => ({
                    name: t.name,
                    description: t.description.split("\n")[0],
                  })),
            },
          });
          return;
        }
        if (!tools.some((tool) => tool.name === message.tool))
          throw new Error("This computer tool is not enabled in DSH.");
        if (
          !message.args ||
          typeof message.args !== "object" ||
          Array.isArray(message.args) ||
          JSON.stringify(message.args).length > 64000
        )
          throw new Error("Invalid computer action arguments.");
        if (
          typeof message.session !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(message.session)
        )
          throw new Error("A current DSH session is required.");
        const args = { ...message.args };
        delete args.session;
        const tool = tools.find(tool => tool.name === message.tool);
        if (tool.inputSchema.properties.session) args.session = "dsh-" + message.session;
        // Diagnostic output paths are not part of this UI-control capability.
        if ("debug_image_out" in args || "screenshot_out_file" in args)
          throw new Error("Diagnostic file output is not enabled.");
        if (runtime !== driver || controller.signal.aborted)
          throw new Error("Computer use was stopped before this action.");
        const result = await runtime.callTool(
          message.tool,
          JSON.stringify(args),
          { signal: controller.signal },
        );
        const output = {
          text: result.text,
          images: result.images,
          isError: result.isError,
          errorCode: result.errorCode,
          structuredJson: result.structuredJson,
        };
        if (JSON.stringify(output).length > 24 * 1024 * 1024)
          throw new Error(
            "The action completed, but its result was too large. Inspect current state before continuing.",
          );
        lastError = output.isError ? output.text || output.errorCode || "Computer action failed." : "";
        reply({ result: output });
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    } catch (error) {
      lastError = error?.message || "Computer action failed.";
      reply({
        error:
          error?.name === "AbortError"
            ? "Computer action stopped. Its outcome may be unknown; inspect current state before retrying."
            : error?.message || "Cua Driver could not complete the action.",
      });
    }
  }

  function disconnect(child) {
    for (const entry of pending.values())
      if (entry.child === child) entry.controller.abort();
    void disable().catch(() => {});
  }
  return { control, receive, disconnect };
}

function loadBundledSDK(resourcesPath, packaged) {
  // No background analytics or update requests: SDK updates ship with DSH.
  process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED = "false";
  process.env.CUA_DRIVER_RS_UPDATE_CHECK = "false";
  return import(
    packaged
      ? pathToFileURL(
          path.join(
            resourcesPath,
            "harness/node_modules/@trycua/cua-driver/dist/index.js",
          ),
        ).href
      : "@trycua/cua-driver"
  );
}

module.exports = { createComputerUse, loadBundledSDK, TOOL_NAMES };
