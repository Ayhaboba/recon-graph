"use strict";

/**
 * Stage 5 live stream hub (spec §6, §8).
 *
 * Serves newline-free JSON over WebSocket (`proto=1`). The hub is a pure
 * reader: every scan database is opened through `openReadOnly`, and no SQL
 * other than SELECT (plus deferred read transactions) is ever issued.
 *
 * One `WebSocketServer({ noServer: true })` instance is attached to the
 * caller's HTTP server via `handleUpgrade(req, socket, head)`.
 */

const fs = require("node:fs");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const db = require("./db");
const { searchScan } = require("./search");
const {
  refetchNode,
  buildNodePayload,
  urlFromKey,
  PREVIEW_CAP,
} = require("./refetch");

const SNAPSHOT_LIMIT = 5000;
const SEARCH_CHUNK_SIZE = 5000;
const PROGRESS_INTERVAL_MS = 1000;
const IDLE_CLOSE_MS = 30000;
const FULL_BODY_CAP = 2 * 1024 * 1024;

function safeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampLimit(value) {
  const number = Math.trunc(safeNumber(value, SNAPSHOT_LIMIT));
  if (number < 1) return 1;
  if (number > SNAPSHOT_LIMIT) return SNAPSHOT_LIMIT;
  return number;
}

function clampAfter(value) {
  const number = Math.trunc(safeNumber(value, 0));
  return number < 0 ? 0 : number;
}

function nodeWire(row) {
  return {
    id: Number(row.id),
    key: row.key,
    type: row.type,
    label: row.label == null ? null : String(row.label),
    status: row.status == null ? null : Number(row.status),
    degree: Number(row.degree || 0),
    depth: row.depth == null ? null : Number(row.depth),
    origin: row.origin == null ? null : String(row.origin),
    ...(Object.prototype.hasOwnProperty.call(row, "attrs") ? { attrs: row.attrs } : {}),
  };
}

function edgeWire(row) {
  return [Number(row.src), Number(row.dst), String(row.kind)];
}

function maxRev(raw, scanId) {
  const row = raw
    .prepare(
      `SELECT COALESCE(MAX(rev), 0) AS rev FROM (
         SELECT rev FROM nodes WHERE scan_id = ?
         UNION ALL
         SELECT rev FROM edges WHERE scan_id = ?
       )`
    )
    .get(scanId, scanId);
  return Number(row.rev) || 0;
}

/**
 * Read one snapshot page inside a deferred read transaction so the cursor and
 * the rows come from the same WAL snapshot. Cursor is taken before the rows:
 * anything the writer commits later has rev > cursor and arrives as a delta.
 */
function readPage(handle, scanId, after, limit) {
  const raw = handle.raw;
  raw.exec("BEGIN");
  try {
    const cursor = maxRev(raw, scanId);
    const nodes = raw
      .prepare(
        "SELECT * FROM nodes WHERE scan_id = ? AND id > ? ORDER BY id LIMIT ?"
      )
      .all(scanId, after, limit);
    const edges = raw
      .prepare(
        `SELECT * FROM edges
          WHERE scan_id = ?
            AND src IN (
              SELECT id FROM nodes
               WHERE scan_id = ? AND id > ? ORDER BY id LIMIT ?
            )
          ORDER BY src, id`
      )
      .all(scanId, scanId, after, limit);
    raw.exec("COMMIT");
    return {
      cursor: { rev: cursor },
      nodes: nodes.map(nodeWire),
      edges: edges.map(edgeWire),
    };
  } catch (err) {
    try {
      raw.exec("ROLLBACK");
    } catch (_rollbackErr) {
      // keep the original error
    }
    throw err;
  }
}

function createHub(options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || "./data");
  const scansDir = path.join(dataDir, "scans");
  const pollMs = Math.max(10, safeNumber(opts.pollMs, 250));

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map();
  const scanStates = new Map();
  const refetching = new Set();
  let nextClientId = 1;
  let closed = false;

  const notImplemented = (message) => (msg, client) => {
    send(client, {
      t: "error",
      code: "not-implemented",
      of: message === "action" ? msg.cmd || message : message,
    });
  };
  const handlers = {
    search: (msg, client) => handleSearch(msg, client),
    node: (msg, client) => sendNode(client, msg.id, { full: false }),
    action: (msg, client) => handleAction(msg, client),
  };

  function send(client, message) {
    const ws = client && client.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch (_err) {
      dropClient(client);
      return false;
    }
  }

  function attrsOf(row) {
    try {
      const parsed = JSON.parse(String(row.attrs_json || "{}"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch (_err) {
      return {};
    }
  }

  // Resolve a node id to a scan. Prefer the client's open scan, then any open
  // scan state, then a short-lived read-only handle over scan files.
  function lookupNode(client, rawId) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    const ordered = [];
    const own = client.scanId == null ? null : scanStates.get(client.scanId);
    if (own) ordered.push(own);
    for (const state of scanStates.values()) {
      if (state !== own) ordered.push(state);
    }
    for (const state of ordered) {
      const row = db.getNodeById(state.handle, id);
      if (row) {
        return {
          row,
          scanId: state.scanId,
          handle: state.handle,
          temporary: false,
        };
      }
    }

    let files;
    try {
      files = fs.readdirSync(scansDir);
    } catch (_err) {
      return null;
    }
    for (const name of files) {
      const match = /^(\d+)\.sqlite$/i.exec(name);
      if (!match) continue;
      const scanId = Number(match[1]);
      if (scanStates.has(scanId)) continue;

      let handle = null;
      let found = null;
      try {
        handle = db.openReadOnly(path.join(scansDir, name));
        const row = db.getNodeById(handle, id);
        if (row) found = { row, scanId, handle, temporary: true };
      } catch (_err) {
        found = null;
      }
      if (found) return found;
      if (handle) {
        try {
          handle.close();
        } catch (_err) {
          // best effort
        }
      }
    }
    return null;
  }

  function sendNode(client, rawId, options) {
    const id = Number(rawId);
    const found = lookupNode(client, id);
    if (!found) {
      send(client, { t: "error", code: "no-node" });
      return;
    }

    let payload = null;
    try {
      payload = buildNodePayload(found.handle, found.row, {
        dataDir,
        cap: options && options.full ? FULL_BODY_CAP : PREVIEW_CAP,
      });
    } catch (err) {
      console.warn(
        `[stream] node ${id}: ${err && err.message ? err.message : err}`
      );
    } finally {
      if (found.temporary) {
        try {
          found.handle.close();
        } catch (_err) {
          // best effort
        }
      }
    }

    if (!payload) {
      send(client, { t: "error", code: "no-node" });
      return;
    }

    if (options && options.full) {
      send(client, { t: "node", id, body: payload.body, full: true });
      return;
    }

    send(client, {
      t: "node",
      id,
      node: payload.node,
      headers: payload.headers,
      findings: payload.findings,
      body: payload.body,
    });
  }

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function storedRequestHeaders(attrs) {
    const out = [];
    const push = (name, value) => {
      if (name === undefined || name === null) return;
      if (value === undefined || value === null) return;
      out.push([String(name), String(value)]);
    };

    const raw =
      attrs.requestHeaders ||
      attrs.request_headers ||
      attrs.reqHeaders ||
      attrs.req_headers;

    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (!entry) continue;
        if (typeof entry === "string") {
          const colon = entry.indexOf(":");
          if (colon > 0) push(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim());
        } else if (typeof entry === "object") {
          push(entry.name, entry.value);
        }
      }
    } else if (raw && typeof raw === "object") {
      for (const name of Object.keys(raw)) push(name, raw[name]);
    }

    if (attrs.cookie !== undefined && attrs.cookie !== null) push("Cookie", attrs.cookie);
    if (attrs.Cookie !== undefined && attrs.Cookie !== null) push("Cookie", attrs.Cookie);
    return out;
  }

  function handleCurl(msg, client) {
    const id = Number(msg.id);
    const found = lookupNode(client, id);
    if (!found) {
      send(client, { t: "error", code: "no-node" });
      return;
    }

    const row = found.row;
    const attrs = attrsOf(row);
    if (found.temporary) {
      try {
        found.handle.close();
      } catch (_err) {
        // best effort
      }
    }

    const url = urlFromKey(row.key) || (row.url ? urlFromKey(row.url) : null);
    if (!url) {
      send(client, { t: "error", code: "no-node" });
      return;
    }

    const parts = ["curl", "-sS", "-D-", shellQuote(url)];
    const headers = storedRequestHeaders(attrs);
    // The crawler always identifies itself; expose that too so the command is
    // reproducible even when no request headers were persisted.
    if (!headers.some(([name]) => String(name).toLowerCase() === "user-agent")) {
      headers.unshift(["User-Agent", "recon-graph/1.0"]);
    }
    for (const [name, value] of headers) {
      parts.push("-H", shellQuote(`${name}: ${value}`));
    }
    send(client, { t: "action", id, cmd: "curl", curl: parts.join(" ") });
  }

  function handleRefetch(msg, client) {
    const id = Number(msg.id);
    const found = lookupNode(client, id);
    if (!found) {
      send(client, { t: "error", code: "no-node" });
      return;
    }

    const scanId = Number(found.row.scan_id) || found.scanId;
    if (found.temporary) {
      try {
        found.handle.close();
      } catch (_err) {
        // best effort
      }
    }

    const key = `${scanId}:${id}`;
    if (refetching.has(key)) {
      send(client, { t: "error", code: "busy", of: "refetch" });
      return;
    }
    refetching.add(key);

    refetchNode({ dataDir, scanId, nodeId: id, options: {} })
      .then((result) => {
        if (!result || result.error) {
          send(client, {
            t: "error",
            code: "refetch-failed",
            of: "refetch",
            message: result && result.error ? String(result.error) : "refetch failed",
          });
          return;
        }
        // The rev trigger bumps the node; the 250 ms poller delivers the delta.
        send(client, {
          t: "node",
          id,
          node: result.node,
          headers: result.headers,
          findings: result.findings,
          body: result.body,
        });
      })
      .catch((err) => {
        send(client, {
          t: "error",
          code: "refetch-failed",
          of: "refetch",
          message: err && err.message ? err.message : String(err),
        });
      })
      .finally(() => {
        refetching.delete(key);
      });
  }

  /**
   * Stage 8 search protocol:
   *   1. reply {t:"search", scanId, seq, count, mode} first (honest count),
   *   2. stream ids in {t:"searchChunk", scanId, seq, ids, done} frames.
   * The query runs inside setImmediate and chunks yield between sends so the
   * 250 ms poller keeps breathing.
   */
  function handleSearch(msg, client) {
    const scanId = Number(msg.scanId);
    const seq = msg.seq === undefined || msg.seq === null ? null : msg.seq;

    if (!Number.isSafeInteger(scanId) || scanId <= 0) {
      send(client, { t: "error", code: "no-scan", of: "search", scanId, seq });
      return;
    }

    let handle = null;
    let temporary = false;
    let leasedState = null;

    const openState = scanStates.get(scanId);
    if (openState) {
      // Keep an idle-grace handle alive for the duration of the stream.
      leasedState = openState;
      if (openState.graceTimer) {
        clearTimeout(openState.graceTimer);
        openState.graceTimer = null;
      }
      handle = openState.handle;
    } else {
      const filePath = path.join(scansDir, `${scanId}.sqlite`);
      if (!fs.existsSync(filePath)) {
        send(client, { t: "error", code: "no-scan", of: "search", scanId, seq });
        return;
      }
      try {
        handle = db.openReadOnly(filePath);
        temporary = true;
        if (!db.getScan(handle, scanId)) {
          handle.close();
          send(client, { t: "error", code: "no-scan", of: "search", scanId, seq });
          return;
        }
      } catch (err) {
        if (handle) {
          try {
            handle.close();
          } catch (_closeErr) {
            // best effort
          }
        }
        console.warn(
          `[stream] search scan ${scanId}: ${
            err && err.message ? err.message : err
          }`
        );
        send(client, { t: "error", code: "no-scan", of: "search", scanId, seq });
        return;
      }
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (temporary) {
        try {
          handle.close();
        } catch (_err) {
          // best effort
        }
      } else if (leasedState && leasedState.subscribers.size === 0) {
        scheduleIdleClose(leasedState);
      }
    };

    const finish = (result) => {
      if (!result || result.error) {
        release();
        send(client, {
          t: "error",
          code: (result && result.error) || "search-failed",
          of: "search",
          scanId,
          seq,
          partial: result && result.partial === true,
          message:
            (result && result.message) || (result && result.error) || "search failed",
        });
        return;
      }

      const mode = result.mode === "regex" ? "regex" : "fts";
      send(client, {
        t: "search",
        scanId,
        seq,
        count: Number(result.count) || 0,
        mode,
        truncated: result.truncated === true,
      });

      const ids = Array.isArray(result.ids) ? result.ids : [];
      if (ids.length === 0) {
        release();
        send(client, { t: "searchChunk", scanId, seq, ids: [], done: true });
        return;
      }

      let offset = 0;
      const pump = () => {
        if (closed || !clients.has(client.id)) {
          release();
          return;
        }

        const chunk = ids.slice(offset, offset + SEARCH_CHUNK_SIZE);
        offset += chunk.length;
        const done = offset >= ids.length;
        const delivered = send(client, {
          t: "searchChunk",
          scanId,
          seq,
          ids: chunk,
          done,
        });

        if (done || !delivered) {
          release();
          return;
        }
        setImmediate(pump);
      };

      setImmediate(pump);
    };

    setImmediate(() => {
      if (closed) {
        release();
        return;
      }

      let result;
      try {
        result = searchScan({
          dbHandle: handle,
          scanId,
          q: msg.q,
          mode: msg.mode,
        });
      } catch (err) {
        finish({
          error: "search-failed",
          message: err && err.message ? String(err.message) : String(err),
        });
        return;
      }

      if (result && typeof result.then === "function") {
        result.then(finish).catch((err) => {
          finish({
            error: "search-failed",
            message: err && err.message ? String(err.message) : String(err),
          });
        });
        return;
      }

      finish(result);
    });
  }

  function handleAction(msg, client) {
    const cmd = msg.cmd === undefined || msg.cmd === null ? "" : String(msg.cmd);
    if (cmd === "curl") {
      handleCurl(msg, client);
      return;
    }
    if (cmd === "refetch") {
      handleRefetch(msg, client);
      return;
    }
    if (cmd === "body") {
      sendNode(client, msg.id, { full: true });
      return;
    }
    if (cmd === "stop") {
      notImplemented("action")(msg, client);
      return;
    }
    send(client, { t: "error", code: "not-implemented", of: cmd || "action" });
  }

  function scans() {
    let files;
    try {
      files = fs.readdirSync(scansDir);
    } catch (err) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }

    const items = [];
    for (const name of files) {
      const match = /^(\d+)\.sqlite$/i.exec(name);
      if (!match) continue;

      const id = Number(match[1]);
      const filePath = path.join(scansDir, name);
      let handle = null;
      try {
        handle = db.openReadOnly(filePath);
        const scan = db.getScan(handle, id);
        if (!scan) {
          console.warn(`[stream] skip ${name}: scans row ${id} missing`);
          continue;
        }
        const counts = db.stats(handle, id);
        items.push({
          id,
          target: String(scan.target),
          status: String(scan.status),
          nodes: Number(counts.nodes) || 0,
          edges: Number(counts.edges) || 0,
        });
      } catch (err) {
        console.warn(
          `[stream] skip ${name}: ${err && err.message ? err.message : err}`
        );
      } finally {
        if (handle) {
          try {
            handle.close();
          } catch (_closeErr) {
            // best effort
          }
        }
      }
    }

    items.sort((left, right) => left.id - right.id);
    return items;
  }

  function closeScanState(state) {
    if (state.graceTimer) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
    scanStates.delete(state.scanId);
    try {
      state.handle.close();
    } catch (_err) {
      // best effort
    }
  }

  function scheduleIdleClose(state) {
    if (state.graceTimer || state.subscribers.size !== 0) return;
    state.graceTimer = setTimeout(() => {
      state.graceTimer = null;
      if (state.subscribers.size === 0 && scanStates.get(state.scanId) === state) {
        closeScanState(state);
      }
    }, IDLE_CLOSE_MS);
    if (typeof state.graceTimer.unref === "function") state.graceTimer.unref();
  }

  function ensureScanState(scanId) {
    const existing = scanStates.get(scanId);
    if (existing) {
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
      }
      return existing;
    }

    const filePath = path.join(scansDir, `${scanId}.sqlite`);
    if (!fs.existsSync(filePath)) return null;

    let handle;
    try {
      handle = db.openReadOnly(filePath);
      const scan = db.getScan(handle, scanId);
      if (!scan) {
        handle.close();
        console.warn(`[stream] scan ${scanId}: scans row missing`);
        return null;
      }
    } catch (err) {
      if (handle) {
        try {
          handle.close();
        } catch (_closeErr) {
          // best effort
        }
      }
      console.warn(
        `[stream] scan ${scanId}: ${err && err.message ? err.message : err}`
      );
      return null;
    }

    const state = {
      scanId,
      handle,
      subscribers: new Set(),
      graceTimer: null,
      lastStatsJson: null,
      lastProgressAt: 0,
    };
    scanStates.set(scanId, state);
    return state;
  }

  function unsubscribe(client) {
    if (client.scanId === null || client.scanId === undefined) return;
    const state = scanStates.get(client.scanId);
    if (state) {
      state.subscribers.delete(client.id);
      if (state.subscribers.size === 0) scheduleIdleClose(state);
    }
    client.scanId = null;
  }

  function dropClient(client) {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    unsubscribe(client);
  }

  function subscribe(client, state) {
    if (client.scanId !== null && client.scanId !== state.scanId) {
      unsubscribe(client);
    }
    client.scanId = state.scanId;
    state.subscribers.add(client.id);
    if (state.graceTimer) {
      clearTimeout(state.graceTimer);
      state.graceTimer = null;
    }
  }

  function handleOpen(client, msg) {
    const scanId = Number(msg.scanId);
    if (!Number.isSafeInteger(scanId) || scanId <= 0) {
      send(client, { t: "error", code: "no-scan" });
      return;
    }

    const state = ensureScanState(scanId);
    if (!state) {
      send(client, { t: "error", code: "no-scan" });
      return;
    }

    let page;
    try {
      page = readPage(state.handle, scanId, 0, SNAPSHOT_LIMIT);
    } catch (err) {
      console.warn(
        `[stream] snapshot scan ${scanId}: ${err && err.message ? err.message : err}`
      );
      send(client, { t: "error", code: "no-scan" });
      return;
    }

    subscribe(client, state);
    client.cursor = { rev: page.cursor.rev };
    client.sentNodes = page.nodes.length;

    send(client, {
      t: "snapshot",
      scanId,
      cursor: { rev: page.cursor.rev },
      nodes: page.nodes,
      edges: page.edges,
    });
  }

  function handlePage(client, msg) {
    const scanId = Number(msg.scanId);
    if (!Number.isSafeInteger(scanId) || scanId <= 0) {
      send(client, { t: "error", code: "no-scan" });
      return;
    }

    const state = ensureScanState(scanId);
    if (!state) {
      send(client, { t: "error", code: "no-scan" });
      return;
    }

    let page;
    try {
      page = readPage(
        state.handle,
        scanId,
        clampAfter(msg.after),
        clampLimit(msg.limit)
      );
    } catch (err) {
      console.warn(
        `[stream] page scan ${scanId}: ${err && err.message ? err.message : err}`
      );
      send(client, { t: "error", code: "no-scan" });
      return;
    }

    // A page response never moves the subscriber's live delta cursor.
    send(client, {
      t: "snapshot",
      scanId,
      cursor: { rev: page.cursor.rev },
      nodes: page.nodes,
      edges: page.edges,
    });

    if (state.subscribers.size === 0) scheduleIdleClose(state);
  }

  function onMessage(client, data, isBinary) {
    if (closed) return;
    if (isBinary) {
      send(client, { t: "error", code: "bad-message" });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch (_err) {
      send(client, { t: "error", code: "bad-json" });
      return;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      send(client, { t: "error", code: "bad-message" });
      return;
    }

    switch (msg.t) {
      case "hello":
        if (msg.proto !== 1) {
          send(client, { t: "error", code: "proto" });
          try {
            client.ws.close(1002, "proto");
          } catch (_err) {
            dropClient(client);
          }
          return;
        }
        send(client, { t: "hello", proto: 1, ok: true });
        return;

      case "scans":
        send(client, { t: "scans", items: scans() });
        return;

      case "open":
        handleOpen(client, msg);
        return;

      case "page":
        handlePage(client, msg);
        return;

      case "close": {
        const scanId = Number(msg.scanId);
        if (client.scanId === scanId) unsubscribe(client);
        return;
      }

      case "search":
      case "node":
      case "action": {
        const handler = handlers[msg.t];
        if (typeof handler === "function") {
          handler(msg, client);
        } else {
          send(client, { t: "error", code: "not-implemented", of: msg.t });
        }
        return;
      }

      default:
        send(client, {
          t: "error",
          code: "unknown",
          of: msg.t === undefined ? null : String(msg.t),
        });
    }
  }

  function poll() {
    if (closed) return;
    const now = Date.now();

    for (const state of Array.from(scanStates.values())) {
      if (state.subscribers.size === 0) continue;

      for (const clientId of Array.from(state.subscribers)) {
        const client = clients.get(clientId);
        if (!client) {
          state.subscribers.delete(clientId);
          continue;
        }

        let result;
        try {
          result = db.delta(state.handle, state.scanId, client.cursor.rev);
        } catch (err) {
          console.warn(
            `[stream] delta scan ${state.scanId}: ${
              err && err.message ? err.message : err
            }`
          );
          break;
        }

        client.cursor.rev = result.cursor.rev;
        if (result.nodes.length > 0 || result.edges.length > 0) {
          send(client, {
            t: "delta",
            scanId: state.scanId,
            cursor: { rev: result.cursor.rev },
            nodes: result.nodes.map(nodeWire),
            edges: result.edges.map(edgeWire),
          });
        }
      }

      if (state.subscribers.size === 0) {
        scheduleIdleClose(state);
        continue;
      }

      if (now - state.lastProgressAt < PROGRESS_INTERVAL_MS) continue;
      state.lastProgressAt = now;

      let counts;
      try {
        counts = db.stats(state.handle, state.scanId);
      } catch (err) {
        console.warn(
          `[stream] progress scan ${state.scanId}: ${
            err && err.message ? err.message : err
          }`
        );
        continue;
      }

      const stats = {
        pending: Number(counts.pending) || 0,
        inflight: Number(counts.inflight) || 0,
        done: Number(counts.done) || 0,
        err: Number(counts.err) || 0,
        nodes: Number(counts.nodes) || 0,
        edges: Number(counts.edges) || 0,
      };
      const signature = JSON.stringify(stats);
      if (signature === state.lastStatsJson) continue;
      state.lastStatsJson = signature;

      for (const clientId of Array.from(state.subscribers)) {
        const client = clients.get(clientId);
        if (client) send(client, { t: "progress", scanId: state.scanId, stats });
      }
    }
  }

  const timer = setInterval(poll, pollMs);

  function handleUpgrade(req, socket, head) {
    if (closed) {
      try {
        socket.destroy();
      } catch (_err) {
        // best effort
      }
      return;
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = {
          id: `client-${nextClientId}`,
          ws,
          scanId: null,
          cursor: { rev: 0 },
          sentNodes: 0,
        };
        nextClientId += 1;
        clients.set(client.id, client);

        ws.on("message", (data, isBinary) => onMessage(client, data, isBinary));
        ws.on("close", () => dropClient(client));
        ws.on("error", () => {
          dropClient(client);
          try {
            ws.terminate();
          } catch (_err) {
            // best effort
          }
        });
      });
    } catch (_err) {
      try {
        socket.destroy();
      } catch (_destroyErr) {
        // best effort
      }
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);

    for (const client of Array.from(clients.values())) {
      const ws = client.ws;
      try {
        if (ws.readyState === 1) ws.close(1001, "hub closing");
      } catch (_err) {
        // best effort
      }
      const force = setTimeout(() => {
        try {
          ws.terminate();
        } catch (_terminateErr) {
          // best effort
        }
      }, 250);
      if (typeof force.unref === "function") force.unref();
    }
    clients.clear();

    for (const state of Array.from(scanStates.values())) {
      closeScanState(state);
    }

    try {
      wss.close();
    } catch (_err) {
      // best effort
    }
  }

  return { handleUpgrade, close, scans, handlers };
}

module.exports = { createHub };
