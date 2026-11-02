"use strict";

/**
 * Stage 6 — browser client tests (spec §9 row 6).
 *
 * Criterion: switching between two scans without a page reload; a partial
 * delta-merge does not reset node positions.
 *
 * Real chromium is driven over CDP. Node 22 ships a global WebSocket client,
 * so no puppeteer/playwright dependency is needed.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const CHROMIUM = "/usr/bin/chromium";
const FIXTURE = path.join(REPO, "tests", "site", "server.js");
const SERVER = path.join(REPO, "bin", "server.js");
const SCANNER = path.join(REPO, "bin", "scanner.js");

const children = new Set();
const tempDirs = new Set();

let fixture = null;
let server = null;
let chromium = null;
let cdp = null;
let dataDir = null;
let scan1 = 0;
let scan2 = 0;
let expected1 = 0;
let expected2 = 0;

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

function track(child) {
  children.add(child);
  return child;
}

function capture(child) {
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout?.on("data", (chunk) => {
    child.stdoutText += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    child.stderrText += chunk.toString();
  });
  return child;
}

function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        if (child.detached) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish();
    }, 2000);
    timer.unref?.();
    child.once("exit", finish);
    try {
      if (child.detached) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

function waitExit(child, timeoutMs = 120000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `process did not exit within ${timeoutMs}ms; stderr:\n${child.stderrText || ""}`
        )
      );
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal && code === null) resolve(signal);
      else resolve(code);
    });
  });
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
    await sleep(100);
  }
  throw new Error(
    `timeout after ${timeoutMs}ms waiting for ${label}${
      lastError ? `: ${lastError.message}` : ""
    }`
  );
}

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { connection: "close" }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(JSON.parse(text));
        } catch (err) {
          reject(new Error(`invalid json from ${url}: ${err.message}: ${text.slice(0, 200)}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// fixture / server / scanner
// ---------------------------------------------------------------------------

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

function startServer(dir) {
  return new Promise((resolve, reject) => {
    const child = capture(
      track(
        spawn(process.execPath, [SERVER, "--port", "0", "--data-dir", dir], {
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

async function makeScan(dir, baseUrl, args) {
  const child = capture(
    track(
      spawn(
        process.execPath,
        [SCANNER, `${baseUrl}/`, "--data-dir", dir, "--delay", "0", ...args],
        { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
      )
    )
  );
  const code = await waitExit(child, 120000);
  if (code !== 0) {
    throw new Error(`scanner failed (code ${code})\nstdout:\n${child.stdoutText}\nstderr:\n${child.stderrText}`);
  }
  const match = child.stdoutText.match(/scan (\d+) complete/);
  if (!match) {
    throw new Error(`scanner did not report a scan id\nstdout:\n${child.stdoutText}\nstderr:\n${child.stderrText}`);
  }
  return Number(match[1]);
}

function startScanner(baseUrl, dir, args) {
  return capture(
    track(
      spawn(process.execPath, [SCANNER, `${baseUrl}/`, "--data-dir", dir, ...args], {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
      })
    )
  );
}

async function waitForNewScan(dir, known, timeoutMs = 15000) {
  const scansDir = path.join(dir, "scans");
  return waitUntil(
    async () => {
      const entries = await fsp.readdir(scansDir).catch(() => []);
      for (const entry of entries) {
        const match = entry.match(/^(\d+)\.sqlite$/);
        if (!match) continue;
        const id = Number(match[1]);
        if (!known.includes(id)) return id;
      }
      return 0;
    },
    timeoutMs,
    "new scan database"
  );
}

async function scanNodes(id) {
  const listing = await getJson(`${server.url}/api/scans`);
  const item = (listing.items || []).find((row) => Number(row.id) === Number(id));
  return item ? Number(item.nodes) || 0 : 0;
}

// ---------------------------------------------------------------------------
// chromium / CDP
// ---------------------------------------------------------------------------

function startChromium() {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recon-chrome-"));
    tempDirs.add(profile);
    const child = track(
      spawn(
        CHROMIUM,
        [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--enable-unsafe-swiftshader",
          "--disable-dev-shm-usage",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-sync",
          "--metrics-recording-only",
          "--mute-audio",
          "--no-first-run",
          "--remote-allow-origins=*",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "about:blank",
        ],
        { cwd: REPO, detached: true, stdio: ["ignore", "pipe", "pipe"] }
      )
    );
    capture(child);
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`chromium did not expose a CDP endpoint; stderr:\n${child.stderrText}`));
      }
    }, 30000);
    timer.unref?.();
    const inspect = () => {
      const match = `${child.stderrText}\n${child.stdoutText}`.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, wsUrl: match[1] });
      }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`chromium exited early (code ${code}); stderr:\n${child.stderrText}`));
      }
    });
  });
}

function waitForPageTarget(browserWsUrl, timeoutMs = 20000) {
  const parsed = new URL(browserWsUrl);
  const base = `http://${parsed.hostname}:${parsed.port}`;
  return waitUntil(
    async () => {
      const list = await getJson(`${base}/json/list`);
      return list.find((target) => target.type === "page" && target.webSocketDebuggerUrl) || null;
    },
    timeoutMs,
    "page target"
  );
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;
    const client = {
      ws,
      send(method, params = {}) {
        const id = nextId;
        nextId += 1;
        return new Promise((resolveCall, rejectCall) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCall(new Error(`CDP ${method} timed out`));
          }, 30000);
          timer.unref?.();
          pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() {
        try {
          ws.close();
        } catch {
          /* best effort */
        }
      },
    };
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message || message.id === undefined) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`CDP error: ${message.error.message}`));
      else waiter.resolve(message.result);
    });
    ws.addEventListener("open", () => resolve(client), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket connection error")), {
      once: true,
    });
    ws.addEventListener("close", () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("CDP websocket closed"));
      }
      pending.clear();
    });
  });
}

async function evalJs(expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    const text =
      details.exception?.description ||
      details.text ||
      (details.exception && details.exception.value) ||
      "evaluation failed";
    throw new Error(`page eval failed: ${text}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitForExpression(expression, timeoutMs = 20000, label = expression) {
  return waitUntil(async () => {
    try {
      return (await evalJs(expression)) ? true : false;
    } catch {
      return false;
    }
  }, timeoutMs, label);
}

const datasetCountExpr =
  "(() => { const rc = window.__recon; return rc ? (typeof rc.datasetNodeCount === 'function' ? rc.datasetNodeCount() : (rc.renderer && rc.renderer.nodes ? rc.renderer.nodes.length : 0)) : 0; })()";

const positionsExpr = `(() => {
  const rc = window.__recon || {};
  const out = {};
  if (typeof rc.positions === "function") {
    const value = rc.positions();
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (!entry) continue;
        const id = entry.id !== undefined ? entry.id : entry.key;
        if (id === undefined) continue;
        out[id] = [Number(entry.x) || 0, Number(entry.y) || 0];
      }
    } else if (value && typeof value === "object") {
      for (const [id, position] of Object.entries(value)) {
        if (Array.isArray(position)) out[id] = [Number(position[0]) || 0, Number(position[1]) || 0];
        else if (position) out[id] = [Number(position.x) || 0, Number(position.y) || 0];
      }
    }
    return out;
  }
  const lookup = (rc.renderer && rc.renderer.nodeLookup) || {};
  for (const [id, node] of Object.entries(lookup)) {
    out[id] = [Number(node.x) || 0, Number(node.y) || 0];
  }
  return out;
})()`;

const objectIdsExpr = `(() => {
  const rc = window.__recon || {};
  if (typeof rc.objectIds === "function") {
    const value = rc.objectIds();
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === "object") return Object.keys(value);
  }
  return Object.keys((rc.renderer && rc.renderer.nodeLookup) || {});
})()`;

async function positions() {
  return evalJs(positionsExpr);
}

async function freezeSimulation() {
  // The engine exposes no stopSim(); its worker stops once alpha <= 0.001.
  // alphaTarget < 0 drives alpha to zero within a few frames, then a 0 target
  // keeps it from restarting until the next setData/drag sets alpha again.
  await evalJs(`(() => {
    const renderer = window.__recon && window.__recon.renderer;
    if (!renderer || !renderer.worker) return false;
    renderer.worker.postMessage({ alphaTarget: -1, run: true });
    return true;
  })()`);
  await sleep(300);
  await evalJs(`(() => {
    const renderer = window.__recon && window.__recon.renderer;
    if (!renderer || !renderer.worker) return false;
    renderer.worker.postMessage({ alphaTarget: 0 });
    return true;
  })()`);
}

async function objectIds() {
  return evalJs(objectIdsExpr);
}

async function switchScan(id) {
  const value = await evalJs(`window.__recon.switchScan(${Number(id)})`);
  await waitForExpression(
    `String(window.__recon.currentScanId) === "${Number(id)}"`,
    20000,
    `scan ${id} selected`
  );
  return value;
}

function offset(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  fixture = await startFixture();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "recon-client-"));
  tempDirs.add(dataDir);

  scan1 = await makeScan(dataDir, fixture.url, ["--max-depth", "2"]);
  scan2 = await makeScan(dataDir, fixture.url, ["--max-depth", "3"]);
  assert.notEqual(scan1, scan2, "scanner must produce two distinct scan ids");

  server = await startServer(dataDir);
  const listing = await getJson(`${server.url}/api/scans`);
  const items = listing.items || [];
  const one = items.find((row) => Number(row.id) === scan1);
  const two = items.find((row) => Number(row.id) === scan2);
  assert.ok(one, `scan ${scan1} missing from /api/scans`);
  assert.ok(two, `scan ${scan2} missing from /api/scans`);
  expected1 = Number(one.nodes) || 0;
  expected2 = Number(two.nodes) || 0;
  assert.ok(expected1 > 0, "scan 1 must contain nodes");
  assert.ok(expected2 > 0, "scan 2 must contain nodes");
  assert.notEqual(expected1, expected2, "the two scans must differ in node count");

  chromium = await startChromium();
  const target = await waitForPageTarget(chromium.wsUrl);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `${server.url}/` });
  await waitForExpression(
    "(() => !!(window.__recon && window.__recon.ready) && (window.__recon.ready.then ? window.__recon.ready.then(() => true) : true))()",
    30000,
    "window.__recon.ready"
  );
});

after(async () => {
  if (cdp) cdp.close();
  if (chromium) await killChild(chromium.child);
  await killChild(server?.child);
  await killChild(fixture?.child);
  for (const child of children) await killChild(child);
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test("client boots and draws the first scan", { timeout: 120000 }, async () => {
  const count = Number(await evalJs(datasetCountExpr));
  assert.ok(count > 0, `datasetNodeCount() must be > 0, got ${count}`);
  assert.equal(count, expected1, `first scan node count: expected ${expected1}, got ${count}`);

  const status = await waitUntil(
    async () => {
      const text = await evalJs(
        "(() => { const el = document.getElementById('status'); return el ? String(el.textContent || '') : ''; })()"
      );
      return /nodes \d+\s*·\s*edges \d+/.test(text) ? text : null;
    },
    20000,
    "#status nodes · edges"
  );
  assert.match(status, /nodes \d+\s*·\s*edges \d+/);

  const errorDisplay = await evalJs(
    "(() => { const el = document.getElementById('error'); return el ? getComputedStyle(el).display : 'missing'; })()"
  );
  assert.equal(errorDisplay, "none", "#error overlay must stay hidden");
});

test("switching scans does not reload the page", { timeout: 120000 }, async () => {
  const before = Number(await evalJs(datasetCountExpr));
  assert.equal(before, expected1);

  await evalJs("window.__marker = 1");
  await switchScan(scan2);

  const current = await evalJs("window.__recon.currentScanId");
  assert.equal(Number(current), scan2);

  const count = await waitUntil(
    async () => {
      const value = Number(await evalJs(datasetCountExpr));
      return value === expected2 ? value : 0;
    },
    20000,
    `scan ${scan2} node count ${expected2}`
  );
  assert.equal(count, expected2);
  assert.notEqual(count, before);

  const marker = await evalJs("window.__marker");
  assert.equal(marker, 1, "page navigation must not happen (window.__marker reset)");
});

test("positions survive a delta merge", { timeout: 180000 }, async () => {
  // A live scanner gives the client real delta frames without any synthetic
  // protocol injection. It is slow on purpose so the snapshot is taken while
  // the crawl is still producing rows.
  const known = [scan1, scan2];
  const live = startScanner(fixture.url, dataDir, [
    "--max-depth", "4",
    "--delay", "1500",
    "--scope", "same-origin",
  ]);
  let liveId = 0;
  try {
    liveId = await waitForNewScan(dataDir, known, 20000);
    await waitUntil(async () => (await scanNodes(liveId)) >= 3, 30000, "live scan nodes >= 3");

    await switchScan(liveId);
    await sleep(700);
    await freezeSimulation();
    const beforePositions = await positions();
    const beforeIds = await objectIds();
    const beforeCount = Number(await evalJs(datasetCountExpr));
    assert.ok(beforeIds.length > 0, "live scan must have visible nodes before delta");

    let grew = false;
    try {
      await waitUntil(
        async () => {
          const count = Number(await evalJs(datasetCountExpr));
          return count > beforeCount ? count : 0;
        },
        25000,
        "delta to add at least one node"
      );
      grew = true;
    } catch {
      grew = false;
    }
    assert.ok(grew, "a live delta must arrive during the test");
    await sleep(500);
    await freezeSimulation();

    const afterPositions = await positions();
    const afterIds = await objectIds();
    const common = beforeIds.filter((id) => Object.prototype.hasOwnProperty.call(afterPositions, id));
    assert.ok(
      common.length >= Math.ceil(beforeIds.length * 0.5),
      `at least half of the ids must survive the merge (${common.length}/${beforeIds.length})`
    );
    // A re-spawn places nodes at random positions. Residual physics drift is
    // expected (the simulation keeps integrating after the delta), so the
    // bound is 800px and must also stay under 40% of the viewport diagonal.
    const viewportDiagonal = Number(
      await evalJs("Math.hypot(window.innerWidth || 0, window.innerHeight || 0)")
    ) || 1;
    const maxJump = Math.min(800, viewportDiagonal * 0.4);
    const moved = [];
    for (const id of common) {
      const delta = offset(beforePositions[id], afterPositions[id]);
      moved.push({ id, delta });
      assert.ok(
        delta < 800 && delta <= maxJump,
        `node ${id} moved ${delta.toFixed(1)} after delta merge ` +
          `(must be < 800 and <= ${maxJump.toFixed(1)} = 40% of viewport diagonal)`
      );
    }
    assert.ok(afterIds.length >= beforeIds.length, "delta merge must not drop visible nodes");

    if (!grew) {
      // Reliable fallback allowed by the task: switching to the same scan twice
      // must not respawn existing nodes at random positions.
      await switchScan(liveId);
      await switchScan(liveId);
      await sleep(300);
      const reopened = await positions();
      const reopenedIds = await objectIds();
      const same = beforeIds.filter((id) => Object.prototype.hasOwnProperty.call(reopened, id));
      assert.ok(
        same.length >= Math.ceil(beforeIds.length * 0.5),
        `re-open must keep at least half of the ids (${same.length}/${beforeIds.length})`
      );
      for (const id of same) {
        assert.ok(
          offset(beforePositions[id], reopened[id]) < 200,
          `re-open moved node ${id} by more than 200px`
        );
      }
      assert.ok(reopenedIds.length > 0);
    }
  } finally {
    await killChild(live);
  }
});

test("type mapping applied", { timeout: 120000 }, async () => {
  await switchScan(scan1);
  await waitUntil(async () => Number(await evalJs(datasetCountExpr)) === expected1, 20000, "scan 1 restored");

  const info = await evalJs(`(() => {
    const renderer = (window.__recon && window.__recon.renderer) || {};
    const lookup = renderer.nodeLookup || {};
    const hist = {};
    const samples = [];
    let unresolved = 0;
    for (const [id, node] of Object.entries(lookup)) {
      const type = node && node.type != null ? String(node.type) : "";
      hist[type] = (hist[type] || 0) + 1;
      if (type === "unresolved") unresolved += 1;
      if ((id.includes("/admin") || id.includes("/api/")) && samples.length < 20) {
        samples.push({ id, type });
      }
    }
    return { hist, samples, unresolved, total: Object.keys(lookup).length };
  })()`);

  assert.ok(info.total > 0, "renderer.nodeLookup must not be empty");
  assert.ok(info.samples.length > 0, "scan must contain /admin or /api/ nodes");
  for (const sample of info.samples) {
    assert.ok(
      sample.type === "attachment" || sample.type === "",
      `node ${sample.id} has unexpected engine type "${sample.type}"`
    );
  }
  assert.ok(info.unresolved > 0, `expected at least one unresolved node; histogram=${JSON.stringify(info.hist)}`);

  // Report the observed histogram in the TAP diagnostics for the stage report.
  process.stdout.write(`# type histogram ${JSON.stringify(info.hist)}\n`);
  process.stdout.write(`# type samples ${JSON.stringify(info.samples)}\n`);
});

test("status updates with progress", { timeout: 180000 }, async () => {
  const known = [scan1, scan2];
  // 400 ms per request keeps the crawl alive long enough to observe progress.
  const live = startScanner(fixture.url, dataDir, [
    "--max-depth", "5",
    "--delay", "400",
    "--scope", "same-origin",
  ]);
  try {
    const liveId = await waitForNewScan(dataDir, known, 20000);
    // Wait for real rows before switching, otherwise the first snapshot can be
    // taken against an empty scan that finishes before the client subscribes.
    await waitUntil(async () => (await scanNodes(liveId)) >= 1, 30000, "live scan nodes >= 1");
    await switchScan(liveId);

    const readStatus = async () => {
      const text = await evalJs(
        "(() => { const el = document.getElementById('status'); return el ? String(el.textContent || '') : ''; })()"
      );
      const pending = text.match(/pending\s+(\d+)/);
      const nodes = text.match(/nodes\s+(\d+)/);
      if (!pending && !nodes) return null;
      return {
        text,
        pending: pending ? Number(pending[1]) : null,
        nodes: nodes ? Number(nodes[1]) : null,
      };
    };

    const first = await waitUntil(readStatus, 20000, "#status progress numbers");
    const startedNonZero = Number(first.pending) > 0;
    let last = first;
    let changed = false;

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(250);
      let next = null;
      try {
        next = await readStatus();
      } catch {
        next = null;
      }
      if (!next) continue;
      last = next;
      if (
        next.text !== first.text ||
        next.pending !== first.pending ||
        next.nodes !== first.nodes
      ) {
        changed = true;
        break;
      }
    }

    // The crawl may finish between two polls: accept the terminal pending 0
    // transition from a non-zero start, as long as the text really changed.
    if (!changed) {
      const finalStatus = await readStatus();
      if (finalStatus) {
        last = finalStatus;
        changed =
          startedNonZero &&
          finalStatus.pending === 0 &&
          finalStatus.text !== first.text;
      }
    }

    assert.ok(
      changed,
      `#status must update at least once (initial=${JSON.stringify(first)} last=${JSON.stringify(last)})`
    );
    process.stdout.write(
      `# status progress ${JSON.stringify({ first: first.text, later: last.text })}\n`
    );
  } finally {
    await killChild(live);
  }
});

test("no error overlay on a normal run", { timeout: 120000 }, async () => {
  const display = await evalJs(
    "(() => { const el = document.getElementById('error'); return el ? getComputedStyle(el).display : 'missing'; })()"
  );
  assert.equal(display, "none", "#error must remain hidden after a normal run");
  const text = await evalJs(
    "(() => { const el = document.getElementById('error'); return el ? String(el.textContent || '') : ''; })()"
  );
  assert.equal(text, "", "no fatal error text must be rendered");
});
