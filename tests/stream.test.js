"use strict";

/**
 * Stage 5 — live stream + read-only server tests (spec §9 row 5).
 *
 * Criterion: with the scanner running, an already-open client receives nodes
 * without reload (verified with TWO clients) and progress changes.
 *
 * Everything is spawned as real processes; no imports from bin/ or lib/.
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const FIXTURE = path.join(REPO, "tests", "site", "server.js");
const SERVER = path.join(REPO, "bin", "server.js");
const SCANNER = path.join(REPO, "bin", "scanner.js");

const children = new Set();
const sockets = new Set();
const tempDirs = new Set();

// ---------------------------------------------------------------------------
// process + network helpers
// ---------------------------------------------------------------------------

function track(child) {
  children.add(child);
  child.on("exit", () => {
    // keep in set until after() so we can still inspect exitCode
  });
  return child;
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 2000);
    timer.unref?.();
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      done();
    }
  });
}

function waitExit(child, timeoutMs = 60000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms; stderr:\n${child.stderrText || ""}`));
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal && code === null) resolve(signal);
      else resolve(code);
    });
  });
}

function capture(child) {
  child.stderrText = "";
  child.stdoutText = "";
  child.stdout?.on("data", (chunk) => {
    child.stdoutText += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    child.stderrText += chunk.toString();
  });
  return child;
}

/** Spawn tests/site/server.js --port 0; resolve base URL. */
function startFixture() {
  return new Promise((resolve, reject) => {
    const child = capture(
      track(
        spawn(process.execPath, [FIXTURE, "--port", "0"], {
          cwd: REPO,
          stdio: ["ignore", "pipe", "pipe"],
        })
      )
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`fixture did not start; stderr:\n${child.stderrText}`));
      }
    }, 15000);
    timer.unref?.();
    child.stdout.on("data", () => {
      const match = child.stdoutText.match(/listening on (http:\/\/127\.0\.0\.1:(\d+)\/)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[1].replace(/\/$/, ""), port: Number(match[2]), child });
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`fixture exited early (code ${code}); stderr:\n${child.stderrText}`));
      }
    });
  });
}

/** Spawn bin/server.js --port 0 --data-dir <dir>; resolve base URL. */
function startServer(dataDir) {
  return new Promise((resolve, reject) => {
    const child = capture(
      track(
        spawn(process.execPath, [SERVER, "--port", "0", "--data-dir", dataDir], {
          cwd: REPO,
          stdio: ["ignore", "pipe", "pipe"],
        })
      )
    );
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`server did not start; stderr:\n${child.stderrText}`));
      }
    }, 20000);
    timer.unref?.();
    child.stdout.on("data", () => {
      const match = child.stdoutText.match(/listening on (http:\/\/127\.0\.0\.1:(\d+)\/)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[1].replace(/\/$/, ""), port: Number(match[2]), child });
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited early (code ${code}); stderr:\n${child.stderrText}`));
      }
    });
  });
}

/** Spawn scanner against fixture with a long-enough delay. */
function startScanner(base, dataDir, extraArgs = []) {
  const child = capture(
    track(
      spawn(
        process.execPath,
        [SCANNER, `${base}/`, "--data-dir", dataDir, "--max-depth", "4", "--delay", "300", ...extraArgs],
        { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
      )
    )
  );
  return child;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(fn, timeoutMs, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(50);
  }
  throw new Error(
    `timeout after ${timeoutMs}ms waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`
  );
}

function getJson(port, urlPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: urlPath, headers: { connection: "close" }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text), text });
          } catch {
            resolve({ status: res.statusCode, headers: res.headers, body: null, text });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`GET ${urlPath} timed out`)));
    req.on("error", reject);
  });
}

async function tmpDir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `recon-stream-${prefix}-`));
  tempDirs.add(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// WebSocket helper
// ---------------------------------------------------------------------------

function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const waiters = [];
  const closeWaiters = [];
  const hooks = [];
  let closed = false;

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    messages.push(msg);
    for (const hook of hooks) {
      try {
        hook(msg);
      } catch {
        /* hook errors must not break collection */
      }
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (messages.length - 1 >= waiter.from && waiter.predicate(msg)) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  });

  ws.addEventListener("close", () => {
    closed = true;
    for (const resolve of closeWaiters.splice(0)) resolve();
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("socket closed before matching message"));
    }
  });

  const client = {
    ws,
    messages,
    get closed() {
      return closed;
    },
    onMessage(fn) {
      hooks.push(fn);
      return () => {
        const index = hooks.indexOf(fn);
        if (index >= 0) hooks.splice(index, 1);
      };
    },
    /** Predicate over every message seen so far, then over future messages. */
    waitFor(predicate, timeoutMs = 15000, from = 0) {
      for (let i = from; i < messages.length; i += 1) {
        if (predicate(messages[i])) return Promise.resolve(messages[i]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((w) => w.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`timeout after ${timeoutMs}ms waiting for ws message`));
        }, timeoutMs);
        timer.unref?.();
        waiters.push({ predicate, from, resolve, reject, timer });
      });
    },
    waitClose(timeoutMs = 5000) {
      if (closed) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
        closeWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };

  sockets.add(client);
  const opened = new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve(client);
    ws.addEventListener("open", () => resolve(client), { once: true });
    ws.addEventListener("error", () => reject(new Error("websocket connection error")), { once: true });
  });
  return opened;
}

/** Send open until the scan exists; tolerate no-scan during scanner startup. */
async function openScan(client, scanId, rev = 0, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const from = client.messages.length;
    client.send({ t: "open", scanId, rev });
    const reply = await client
      .waitFor(
        (m) =>
          (m.t === "snapshot" && m.scanId === scanId) ||
          (m.t === "error" && m.code === "no-scan"),
        1500,
        from
      )
      .catch(() => null);
    if (reply && reply.t === "snapshot") return reply;
    await sleep(100);
  }
  throw new Error(`scan ${scanId} never became openable`);
}

/** Run a scanner to completion in a fresh-ish data dir and assert success. */
async function scanToCompletion(base, dataDir, extraArgs = []) {
  const child = startScanner(base, dataDir, ["--delay", "0", ...extraArgs]);
  const code = await waitExit(child, 90000);
  assert.equal(code, 0, `scanner failed (code ${code}):\n${child.stderrText}\n${child.stdoutText}`);
  return path.join(dataDir, "scans", "1.sqlite");
}

async function getScans(port) {
  const res = await getJson(port, "/api/scans");
  assert.equal(res.status, 200, `GET /api/scans -> ${res.status}: ${res.text}`);
  assert.ok(res.body && Array.isArray(res.body.items), "GET /api/scans must return {items:[]}");
  return res.body.items;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

const live = { timeout: 45000 };
const quick = { timeout: 30000 };

test("two clients receive the same snapshot", quick, async () => {
  const fixture = await startFixture();
  try {
    const dataDir = await tmpDir("snapshot");
    await scanToCompletion(fixture.url, dataDir);
    const server = await startServer(dataDir);

    const clientA = await connect(server.port);
    const clientB = await connect(server.port);
    const [snapA, snapB] = await Promise.all([openScan(clientA, 1), openScan(clientB, 1)]);

    assert.equal(snapA.t, "snapshot");
    assert.ok(Array.isArray(snapA.nodes), "snapshot.nodes must be an array");
    assert.ok(snapA.nodes.length > 0, "completed fixture scan must have nodes");
    assert.equal(snapB.nodes.length, snapA.nodes.length, "both clients see the same node count");
    assert.ok(snapA.cursor && typeof snapA.cursor.rev === "number", "snapshot.cursor.rev missing");
    assert.equal(snapB.cursor.rev, snapA.cursor.rev, "both clients see the same rev");
    assert.equal(snapB.scanId, snapA.scanId);
  } finally {
    await killChild(fixture.child);
  }
});

test("pagination returns the rest", quick, async () => {
  const fixture = await startFixture();
  try {
    const dataDir = await tmpDir("page");
    await scanToCompletion(fixture.url, dataDir);
    const server = await startServer(dataDir);

    const client = await connect(server.port);
    const snapshot = await openScan(client, 1);
    const pageOneIds = new Set(snapshot.nodes.map((node) => node.id));

    const from = client.messages.length;
    client.send({ t: "page", scanId: 1, after: snapshot.nodes.length, limit: 2 });
    // Spec §6 answers a page request with another `snapshot` frame.
    const page = await client.waitFor(
      (m) => (m.t === "page" || m.t === "snapshot") && m.scanId === 1,
      10000,
      from
    );

    assert.ok(Array.isArray(page.nodes), "page.nodes must be an array");
    assert.ok(page.nodes.length <= 2, `page returned ${page.nodes.length} nodes, limit was 2`);
    for (const node of page.nodes) {
      assert.equal(pageOneIds.has(node.id), false, `node ${node.id} overlaps page 1`);
    }
    assert.ok(page.cursor && typeof page.cursor.rev === "number", "page.cursor.rev missing");
  } finally {
    await killChild(fixture.child);
  }
});

test("live delta while scanning", live, async () => {
  const fixture = await startFixture();
  const dataDir = await tmpDir("live");
  try {
    const server = await startServer(dataDir);
    const client = await connect(server.port);
    const scanner = startScanner(fixture.url, dataDir, ["--delay", "250", "--max-depth", "4"]);

    const state = { progressNodes: [], deltasWithNodes: 0 };
    client.onMessage((m) => {
      if (m.t === "progress" && m.stats && Number.isInteger(m.stats.nodes)) {
        state.progressNodes.push(m.stats.nodes);
      }
      if (m.t === "delta" && Array.isArray(m.nodes) && m.nodes.length > 0) {
        state.deltasWithNodes += 1;
      }
    });

    const snapshot = await openScan(client, 1, 0, 20000);
    assert.equal(snapshot.t, "snapshot");
    assert.ok(Array.isArray(snapshot.nodes), "initial snapshot must carry a nodes array");

    await waitUntil(
      () =>
        state.deltasWithNodes > 0 ||
        state.progressNodes.some((value, index) => index > 0 && value > state.progressNodes[index - 1]),
      30000,
      "a non-empty delta or strictly increasing progress.stats.nodes"
    );

    const code = await waitExit(scanner, 60000);
    assert.equal(code, 0, `scanner failed (code ${code}):\n${scanner.stderrText}`);
  } finally {
    await killChild(fixture.child);
  }
});

test("two tabs see the same live growth", live, async () => {
  const fixture = await startFixture();
  const dataDir = await tmpDir("twotabs");
  try {
    const server = await startServer(dataDir);
    const clientA = await connect(server.port);
    const clientB = await connect(server.port);
    const scanner = startScanner(fixture.url, dataDir, ["--delay", "250", "--max-depth", "4"]);

    const tracked = [clientA, clientB].map((client) => {
      const state = { lastNodes: null, ids: new Set() };
      client.onMessage((m) => {
        if ((m.t === "snapshot" || m.t === "delta") && Array.isArray(m.nodes)) {
          for (const node of m.nodes) state.ids.add(node.id);
        }
        if (m.t === "progress" && m.stats && Number.isInteger(m.stats.nodes)) {
          state.lastNodes = m.stats.nodes;
        }
      });
      return state;
    });

    const snaps = await Promise.all([
      openScan(clientA, 1, 0, 20000),
      openScan(clientB, 1, 0, 20000),
    ]);
    for (const snap of snaps) {
      assert.equal(snap.t, "snapshot");
      assert.ok(Array.isArray(snap.nodes));
    }

    const item = await waitUntil(
      async () => {
        const items = await getScans(server.port);
        const scan = items.find((entry) => entry.id === 1);
        return scan && scan.status !== "running" ? scan : null;
      },
      30000,
      "scan to finish"
    );
    assert.equal(item.status, "done", `scan ended with status ${item.status}`);

    const finalCount = item.nodes;
    assert.ok(Number.isInteger(finalCount) && finalCount > 0, "final scan node count missing");

    await waitUntil(
      () =>
        tracked.every(
          (state) => state.lastNodes === finalCount || state.ids.size === finalCount
        ),
      15000,
      `both clients to reach ${finalCount} nodes`
    );

    assert.equal(tracked[0].lastNodes, tracked[1].lastNodes, "progress node counts diverged");
    assert.equal(tracked[0].ids.size, tracked[1].ids.size, "delivered node sets diverged");

    const code = await waitExit(scanner, 60000);
    assert.equal(code, 0, `scanner failed (code ${code}):\n${scanner.stderrText}`);
  } finally {
    await killChild(fixture.child);
  }
});

test("scans list endpoint and message", quick, async () => {
  const fixture = await startFixture();
  try {
    const dataDir = await tmpDir("scans");
    await scanToCompletion(fixture.url, dataDir);
    const server = await startServer(dataDir);

    const items = await getScans(server.port);
    const restIds = items.map((entry) => entry.id).sort((a, b) => a - b);
    assert.ok(restIds.includes(1), `GET /api/scans missing scan 1: ${JSON.stringify(restIds)}`);
    const restItem = items.find((entry) => entry.id === 1);
    assert.equal(typeof restItem.target, "string");
    assert.equal(typeof restItem.status, "string");

    const client = await connect(server.port);
    const from = client.messages.length;
    client.send({ t: "scans" });
    const frame = await client.waitFor((m) => m.t === "scans", 10000, from);
    assert.ok(Array.isArray(frame.items), "scans frame must carry items");
    const wsIds = frame.items.map((entry) => entry.id).sort((a, b) => a - b);
    assert.deepEqual(wsIds, restIds, "WS scans ids must match GET /api/scans");
  } finally {
    await killChild(fixture.child);
  }
});

test("protocol errors", quick, async () => {
  const fixture = await startFixture();
  try {
    const dataDir = await tmpDir("errors");
    await scanToCompletion(fixture.url, dataDir);
    const server = await startServer(dataDir);

    // Wrong protocol: error frame with code "proto", or a close.
    let client = await connect(server.port);
    const fromProto = client.messages.length;
    client.send({ t: "hello", proto: 2 });
    const protoReply = await client
      .waitFor((m) => m.t === "error" && m.code === "proto", 3000, fromProto)
      .catch(() => null);
    if (!protoReply) {
      await client.waitClose(3000);
      assert.equal(client.closed, true, "proto=2 must yield an error frame or close the socket");
    }
    // The implementation may close after the proto error; continue on a fresh socket.
    client.close();
    client = await connect(server.port);

    // Unknown scan id: no-scan error, connection stays alive.
    const fromMissing = client.messages.length;
    client.send({ t: "open", scanId: 9999, rev: 0 });
    const missing = await client.waitFor(
      (m) => m.t === "error" && m.code === "no-scan",
      10000,
      fromMissing
    );
    assert.equal(missing.code, "no-scan");
    assert.equal(client.closed, false, "no-scan error must not close the socket");

    // Unknown type: error frame, then hello must still work.
    const fromUnknown = client.messages.length;
    client.send({ t: "definitely-not-a-message" });
    const unknown = await client.waitFor((m) => m.t === "error", 10000, fromUnknown);
    assert.equal(typeof unknown.code, "string", "unknown t error needs a code");
    assert.equal(client.closed, false, "unknown t must not close the socket");

    const fromHello = client.messages.length;
    client.send({ t: "hello", proto: 1 });
    const ack = await client.waitFor(
      (m) => m.t === "ok" || (m.t === "hello" && m.ok === true),
      10000,
      fromHello
    );
    assert.ok(ack.t === "ok" || ack.ok === true, "hello must be acknowledged");
    assert.equal(client.ws.readyState, WebSocket.OPEN, "connection must remain usable");
  } finally {
    await killChild(fixture.child);
  }
});

test("server is read-only", quick, async () => {
  const fixture = await startFixture();
  try {
    const dataDir = await tmpDir("readonly");
    const dbPath = await scanToCompletion(fixture.url, dataDir);
    const before = await fsp.stat(dbPath);

    const server = await startServer(dataDir);
    const client = await connect(server.port);
    const snapshot = await openScan(client, 1);
    assert.ok(snapshot.nodes.length > 0);

    // Exercise read paths for 3 s while the client is attached.
    const started = Date.now();
    while (Date.now() - started < 3000) {
      client.send({ t: "page", scanId: 1, after: 0, limit: 2 });
      await getScans(server.port);
      await sleep(250);
    }

    const afterStat = await fsp.stat(dbPath);
    assert.equal(afterStat.size, before.size, "server changed scan DB size");
    assert.equal(afterStat.mtimeMs, before.mtimeMs, "server changed scan DB mtime");
    assert.equal(fs.existsSync(dbPath), true);
  } finally {
    await killChild(fixture.child);
  }
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

after(async () => {
  for (const client of sockets) {
    client.close();
  }
  sockets.clear();
  await Promise.all([...children].map((child) => killChild(child)));
  children.clear();
  await Promise.all(
    [...tempDirs].map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}))
  );
  tempDirs.clear();
});
