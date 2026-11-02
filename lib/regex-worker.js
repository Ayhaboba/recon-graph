"use strict";

/**
 * ReDoS containment worker (stage 8 repair).
 *
 * The main thread owns the SQLite cursor and posts bodies in chunks:
 *   { type: "init", pattern, flags }
 *   { type: "chunk", items: [{ id, text }] }
 *   { type: "cancel" }
 *
 * Replies:
 *   { type: "ready" } | { type: "error", message }
 *   { type: "matches", ids: number[] }
 *   { type: "cancelled" }
 *
 * A catastrophic pattern only ever blocks this thread. The parent enforces a
 * wall-clock budget and calls worker.terminate(), so the event loop (and the
 * 250 ms stream poller) stays responsive no matter how bad the pattern is.
 */

const { parentPort } = require("node:worker_threads");

let regex = null;

function textOf(item) {
  if (!item || typeof item !== "object") return null;
  const text = item.text;
  if (text === null || text === undefined) return null;
  return String(text);
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "init") {
    const pattern = msg.pattern === null || msg.pattern === undefined ? "" : String(msg.pattern);
    const flags = typeof msg.flags === "string" ? msg.flags : "i";
    try {
      regex = new RegExp(pattern, flags);
      parentPort.postMessage({ type: "ready" });
    } catch (err) {
      regex = null;
      parentPort.postMessage({
        type: "error",
        message: err && err.message ? String(err.message) : "invalid regex",
      });
    }
    return;
  }

  if (msg.type === "chunk") {
    if (!regex) {
      parentPort.postMessage({ type: "error", message: "worker not initialised" });
      return;
    }
    const items = Array.isArray(msg.items) ? msg.items : [];
    const ids = [];
    for (let index = 0; index < items.length; index += 1) {
      const text = textOf(items[index]);
      if (text === null) continue;
      if (regex.test(text)) ids.push(items[index].id);
    }
    parentPort.postMessage({ type: "matches", ids });
    return;
  }

  if (msg.type === "cancel") {
    parentPort.postMessage({ type: "cancelled" });
  }
});
