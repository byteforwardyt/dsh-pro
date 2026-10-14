import { randomUUID } from "node:crypto";

/** Private inherited IPC. No HTTP endpoint can execute desktop actions. */
export function createBridge(channel = process) {
  const pending = new Map();
  function finish(id, error, result) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    error ? entry.reject(new Error(error)) : entry.resolve(result);
  }
  function receive(message) {
    if (message?.channel === "dsh-computer-result")
      finish(message.id, message.error, message.result);
  }
  function disconnect() {
    for (const id of pending.keys())
      finish(id, "The desktop connection closed.");
  }
  channel.on("message", receive);
  channel.on("disconnect", disconnect);
  return {
    request(op, values = {}, signal) {
      if (!channel.connected || typeof channel.send !== "function" || (channel === process && process.env.DSH_COMPUTER_BRIDGE !== '1'))
        return Promise.reject(
          new Error("Computer use requires the DSH PRO desktop app."),
        );
      if (signal?.aborted)
        return Promise.reject(new Error("Computer action cancelled."));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => {
          if (channel.connected)
            channel.send(
              { channel: "dsh-computer", id, op: "cancel" },
              () => {},
            );
          finish(
            id,
            "Computer action stopped. Check current state before retrying; an action may already have occurred.",
          );
        };
        const timer = setTimeout(abort, 95000);
        pending.set(id, { resolve, reject, timer, abort, signal });
        signal?.addEventListener("abort", abort, { once: true });
        channel.send(
          { ...values, channel: "dsh-computer", id, op },
          (error) => {
            if (error) finish(id, "The desktop connection closed.");
          },
        );
      });
    },
    dispose() {
      for (const entry of [...pending.values()]) entry.abort();
      channel.off("message", receive);
      channel.off("disconnect", disconnect);
    },
  };
}
