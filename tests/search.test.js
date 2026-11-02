"use strict";

/**
 * Stage 8 — search tests (spec §6, §7, §9 row 8).
 *
 * Criterion: the streamed search protocol reports an honest count, every id
 * reaches the client buffer, regex mode works, matches are emphasised in the
 * graph engine, the result list is virtualized, and stale sequences are
 * ignored. Real chromium is driven over CDP (same helper shapes as
 * tests/inspector.test.js).
 *
 * The fixture site only yields a handful of matches, so a synthetic scan with
 * 120 nodes is created through lib/db.js in the same data dir. Even nodes
 * match "flag"; odd nodes match "secretflag" (disjoint FTS token sets), which
 * makes the stale-sequence test meaningful.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const db = require("../lib/db");

const REPO = path.resolve(__dirname, "..");
const CHROMIUM = "/usr/bin/chromium";
const FIXTURE = path.join(REPO, "tests", "site", "server.js");
const SERVER = path.join(REPO, "bin", "server.js");
const SCANNER = path.join(REPO, "bin", "scanner.js");

const SYNTHETIC_NODES = 120;
const SYNTHETIC_FLAG_COUNT = SYNTHETIC_NODES / 2;
const SYNTHETIC_SECRET_COUNT = SYNTHETIC_NODES / 2;

const children = new Set();
const tempDirs = new Set();

let fixture = null;
let server = null;
let chromium = null;
let cdp = null;
let dataDir = null;
let scanId = 0;
let fixtureNodes = 0;
let syntheticId = 0;
let syntheticFlagCount = 0;
let syntheticSecretCount = 0;

// ---------------------------------------------------------------------------
// process helpers (same shapes as tests/inspector.test.js)
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
// fixture / scanner / synthetic scan
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

async function makeScan(dir, baseUrl) {
  const child = capture(
    track(
      spawn(
        process.execPath,
        [
          SCANNER,
          `${baseUrl}/`,
          "--data-dir",
          dir,
          "--delay",
          "0",
          "--max-depth",
          "3",
          "--wordlist",
          "lists/common.txt",
        ],
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

/**
 * Builds a completed scan with SYNTHETIC_NODES nodes. Even nodes contain the
 * FTS token "flag"; odd nodes contain "secretflag". Both carry a "fl…{"
 * regex target. Returns the FTS result counts read back from the same handle.
 */
function makeSyntheticScan(dir, id) {
  const scansDir = path.join(dir, "scans");
  fs.mkdirSync(scansDir, { recursive: true });
  const file = path.join(scansDir, `${id}.sqlite`);
  const handle = db.openDb(file);

  try {
    db.createScan(handle, {
      id,
      target: "http://synthetic.test/",
      mode: "active",
      rootKey: "GET http://synthetic.test/",
      options: {},
    });

    for (let index = 1; index <= SYNTHETIC_NODES; index += 1) {
      const url = `http://synthetic.test/node/${index}.html`;
      const inserted = db.upsertNode(handle, id, {
        key: `GET ${url}`,
        type: "page",
        label: `synthetic node ${index}`,
        url,
        method: "GET",
        status: 200,
        depth: 1,
        origin: "crawl",
        attrs: {},
      });
      const even = index % 2 === 0;
      const text = even
        ? `synthetic flag{fixture${index}} body`
        : `synthetic secretflag{fixture${index}} body`;
      db.putBody(handle, inserted.id, {
        text,
        mime: "text/html",
        encoding: "utf-8",
        size: Buffer.byteLength(text, "utf8"),
        sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
        filePath: `/synthetic/${index}.html`,
        title: `Synthetic ${index}`,
      });
    }

    db.setScanStatus(handle, id, "complete", {
      stats: { nodes: SYNTHETIC_NODES, edges: 0 },
    });

    return {
      flag: db.search(handle, id, "flag", { limit: 0 }).length,
      secret: db.search(handle, id, "secretflag", { limit: 0 }).length,
    };
  } finally {
    handle.close();
  }
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
          "--window-size=1400,900",
          "--force-device-scale-factor=1",
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

// ---------------------------------------------------------------------------
// search helpers
// ---------------------------------------------------------------------------

const datasetCountExpr = "(() => window.__recon ? window.__recon.datasetNodeCount() : 0)()";

const searchStateExpr = `(() => {
  const s = window.__search;
  if (!s) return null;
  const badge = document.getElementById('search-badge');
  return {
    count: s.count(),
    len: s.results().length,
    ids: s.results().slice(),
    badge: badge ? String(badge.textContent || '') : ''
  };
})()`;

async function searchState() {
  return evalJs(searchStateExpr);
}

async function runSearch(query, mode) {
  const q = JSON.stringify(String(query));
  const m = JSON.stringify(mode || "fts");
  return evalJs(`window.__search.run(${q}, ${m})`);
}

async function waitSearchDone(timeoutMs = 30000) {
  return waitUntil(
    async () => {
      const state = await searchState();
      if (!state) return null;
      if (/searching/.test(state.badge)) return null;
      if (state.len !== state.count) return null;
      if (state.count > 0 && state.ids.length === 0) return null;
      return state;
    },
    timeoutMs,
    "search done (buffer length equals count)"
  );
}

async function useScan(id, expectedNodes) {
  const current = Number(await evalJs("(() => window.__recon.currentScanId)()"));
  if (current !== Number(id)) {
    await evalJs(`window.__recon.switchScan(${Number(id)})`);
  }
  await waitUntil(
    async () => {
      const active = Number(await evalJs("(() => window.__recon.currentScanId)()"));
      const nodes = Number(await evalJs(datasetCountExpr));
      return active === Number(id) && nodes === expectedNodes;
    },
    30000,
    `scan ${id} with ${expectedNodes} nodes`
  );
}

async function scrollResults(top) {
  await evalJs(`(() => {
    const results = document.getElementById('search-results');
    results.scrollTop = ${Number(top)};
    results.dispatchEvent(new Event('scroll'));
    return results.scrollTop;
  })()`);
  await sleep(150);
  return evalJs(
    "(() => Array.from(document.querySelectorAll('#search-rows .search-result-row')).map((row) => String(row.dataset.id)))()"
  );
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  fixture = await startFixture();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "recon-search-"));
  tempDirs.add(dataDir);

  scanId = await makeScan(dataDir, fixture.url);
  assert.ok(scanId > 0, "scanner must report a scan id");

  syntheticId = scanId + 100;
  const counts = makeSyntheticScan(dataDir, syntheticId);
  syntheticFlagCount = counts.flag;
  syntheticSecretCount = counts.secret;
  assert.equal(syntheticFlagCount, SYNTHETIC_FLAG_COUNT, 'synthetic "flag" count');
  assert.equal(syntheticSecretCount, SYNTHETIC_SECRET_COUNT, 'synthetic "secretflag" count');

  server = await startServer(dataDir);
  const listing = await getJson(`${server.url}/api/scans`);
  const item = (listing.items || []).find((row) => Number(row.id) === scanId);
  assert.ok(item, `scan ${scanId} missing from /api/scans`);
  fixtureNodes = Number(item.nodes) || 0;
  assert.ok(fixtureNodes > 0, "fixture scan must contain nodes");
  const syntheticItem = (listing.items || []).find((row) => Number(row.id) === syntheticId);
  assert.ok(syntheticItem, `synthetic scan ${syntheticId} missing from /api/scans`);
  assert.equal(Number(syntheticItem.nodes), SYNTHETIC_NODES);

  chromium = await startChromium();
  const target = await waitForPageTarget(chromium.wsUrl);
  cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.navigate", { url: `${server.url}/` });
  await waitForExpression(
    "(() => !!(window.__recon && window.__recon.ready && window.__search && document.getElementById('search-mode') && document.getElementById('search-panel')))()",
    30000,
    "window.__search and search markup"
  );
  await evalJs("window.__recon.ready.then(() => true)");
  await waitUntil(
    async () => Number(await evalJs(datasetCountExpr)) === fixtureNodes,
    30000,
    "fixture dataset loaded"
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

test("search returns an honest count", { timeout: 120000 }, async () => {
  await useScan(scanId, fixtureNodes);

  await runSearch("flag", "fts");
  const state = await waitSearchDone();
  assert.ok(state.count >= 1, `fixture "flag" must match at least one node, got ${state.count}`);
  assert.match(state.badge, /match/, `badge must report matches, got "${state.badge}"`);
  assert.ok(
    state.badge.includes(String(state.count)),
    `badge must show the honest count ${state.count}, got "${state.badge}"`
  );
});

test("chunks reach the buffer and the list is virtualized", { timeout: 120000 }, async () => {
  await useScan(syntheticId, SYNTHETIC_NODES);

  await runSearch("flag", "fts");
  const state = await waitSearchDone();
  assert.equal(state.count, syntheticFlagCount, "server count must match the database");
  assert.ok(state.count > 40, `virtualization fixture must exceed 40 matches, got ${state.count}`);
  assert.equal(state.len, state.count, "every id chunk must reach the client buffer");

  const rendered = Number(
    await evalJs("(() => document.querySelectorAll('#search-rows .search-result-row').length)()")
  );
  assert.ok(rendered > 0, "some rows must be rendered");
  assert.ok(
    rendered < state.count,
    `rendered rows (${rendered}) must be fewer than matches (${state.count})`
  );
});

test("regex mode finds matches", { timeout: 120000 }, async () => {
  await useScan(syntheticId, SYNTHETIC_NODES);

  await runSearch("fl[a-z]+\\{", "regex");
  const state = await waitSearchDone();
  assert.ok(state.count >= 1, `regex must match at least one node, got ${state.count}`);
  assert.ok(
    state.len === state.count,
    `regex buffer (${state.len}) must equal count (${state.count})`
  );
});

test("emphasis applied and cleared", { timeout: 120000 }, async () => {
  await useScan(syntheticId, SYNTHETIC_NODES);

  await runSearch("flag", "fts");
  await waitSearchDone();

  const emphasis = await evalJs(
    "(() => { const ids = window.__recon.renderer && window.__recon.renderer._emphasisIds; return ids ? Object.keys(ids) : []; })()"
  );
  assert.ok(Array.isArray(emphasis) && emphasis.length > 0, "renderer._emphasisIds must be non-empty after search");

  await evalJs("window.__search.clear()");
  const cleared = await evalJs(
    "(() => { const ids = window.__recon.renderer && window.__recon.renderer._emphasisIds; return ids ? Object.keys(ids) : []; })()"
  );
  assert.equal(cleared.length, 0, "renderer._emphasisIds must be empty after clear()");
});

test("virtualized scrolling renders a different window", { timeout: 120000 }, async () => {
  await useScan(syntheticId, SYNTHETIC_NODES);

  await runSearch("flag", "fts");
  await waitSearchDone();

  const first = await scrollResults(300);
  const second = await scrollResults(800);

  assert.ok(first.length > 0, "first scroll window must render rows");
  assert.ok(second.length > 0, "second scroll window must render rows");
  assert.ok(second.length < 60, `rendered window must stay bounded, got ${second.length}`);
  assert.notDeepEqual(second, first, "scrolling must change the rendered id window");
});

test("stale seq is ignored", { timeout: 120000 }, async () => {
  await useScan(syntheticId, SYNTHETIC_NODES);

  await runSearch("flag", "fts");
  await runSearch("secretflag", "fts");
  const finalState = await waitSearchDone();
  assert.ok(finalState.count > 0, "second query must match");
  assert.equal(finalState.count, syntheticSecretCount, "final count must be the second query count");

  await runSearch("secretflag", "fts");
  const freshState = await waitSearchDone();
  const fresh = new Set(freshState.ids.map((id) => Number(id)));

  assert.equal(finalState.ids.length, freshState.ids.length, "final buffer must match a fresh run length");
  for (const id of finalState.ids) {
    assert.ok(fresh.has(Number(id)), `result ${id} does not belong to the second query`);
  }
});
