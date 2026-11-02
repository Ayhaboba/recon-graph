"use strict";

/**
 * Stage 9 — settings panel tests (spec §9 row 9).
 *
 * Criterion: turning off assets removes them; status=4xx leaves only errors;
 * Display/Forces/Groups work like the original.
 *
 * Real chromium over CDP, same helper shapes as tests/inspector.test.js.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

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
let scanId = 0;
let scanDb = null;
let scanNodes = 0;
let assetKeys = [];
let fuzzKeys = [];
let statusByKey = new Map();

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

const datasetCountExpr = "(() => window.__recon ? window.__recon.datasetNodeCount() : 0)()";

async function datasetCount() {
  return Number(await evalJs(datasetCountExpr));
}

async function renderedKeys() {
  return evalJs(
    "(() => Object.keys(window.__recon && window.__recon.renderer ? window.__recon.renderer.nodeLookup : {}))()"
  );
}

async function objectIds() {
  return evalJs("(() => window.__recon.objectIds())()");
}

function overlapRatio(before, after) {
  const keys = Object.keys(before || {});
  if (!keys.length) return 0;
  let same = 0;
  for (const key of keys) {
    if (after && Object.prototype.hasOwnProperty.call(after, key) && after[key] === before[key]) same += 1;
  }
  return same / keys.length;
}

// Panel DOM helpers, evaluated in the page.
const sectionExpr = (title) => `(() => {
  const host = document.getElementById('panel');
  if (!host) return null;
  return Array.from(host.querySelectorAll('details.gs-section')).find(
    (d) => String(d.querySelector('summary') ? d.querySelector('summary').textContent : '').trim() === ${JSON.stringify(title)}
  ) || null;
})()`;

async function clickFilter(label) {
  await evalJs(`(() => {
    const host = document.getElementById('panel');
    const details = Array.from(host.querySelectorAll('details.gs-section')).find(
      (d) => String(d.querySelector('summary') ? d.querySelector('summary').textContent : '').trim() === 'Filters'
    );
    if (!details) throw new Error('Filters section missing');
    const row = Array.from(details.querySelectorAll('.gs-filter-row')).find(
      (r) => {
        const name = r.querySelector('.gs-setting-name');
        return name && String(name.textContent || '').trim() === ${JSON.stringify(label)};
      }
    );
    if (!row) throw new Error('filter row missing: ' + ${JSON.stringify(label)});
    const input = row.querySelector('input[type=checkbox]');
    if (!input) throw new Error('filter checkbox missing: ' + ${JSON.stringify(label)});
    input.click();
  })()`);
}

async function setRange(label, value) {
  await evalJs(`(() => {
    const host = document.getElementById('panel');
    if (!host) throw new Error('panel missing');
    const rows = Array.from(host.querySelectorAll('.gs-setting-slider'));
    const row = rows.find((r) => {
      const name = r.querySelector('.gs-setting-name');
      return name && String(name.textContent || '').trim() === ${JSON.stringify(label)};
    });
    if (!row) throw new Error('slider row missing: ' + ${JSON.stringify(label)});
    const input = row.querySelector('input[type=range]');
    if (!input) throw new Error('range input missing: ' + ${JSON.stringify(label)});
    input.value = String(${Number(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

async function clickButton(label) {
  await evalJs(`(() => {
    const host = document.getElementById('panel');
    if (!host) throw new Error('panel missing');
    const button = Array.from(host.querySelectorAll('button.gs-button')).find(
      (b) => String(b.textContent || '').trim() === ${JSON.stringify(label)}
    );
    if (!button) throw new Error('button missing: ' + ${JSON.stringify(label)});
    button.click();
  })()`);
}

async function openSection(title) {
  await evalJs(`(() => {
    const host = document.getElementById('panel');
    const details = Array.from(host.querySelectorAll('details.gs-section')).find(
      (d) => String(d.querySelector('summary') ? d.querySelector('summary').textContent : '').trim() === ${JSON.stringify(title)}
    );
    if (details) details.open = true;
  })()`);
}

async function setGroupColor(type, color) {
  await openSection("Groups");
  await evalJs(`(() => {
    const host = document.getElementById('panel');
    const swatches = Array.from(host.querySelectorAll('input.gs-color-swatch'));
    const swatch = swatches.find((s) => String(s.title || '') === ${JSON.stringify(`${type} colour`)});
    if (!swatch) throw new Error('colour swatch missing for ' + ${JSON.stringify(type)});
    swatch.value = ${JSON.stringify(color)};
    swatch.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  fixture = await startFixture();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "recon-panel-"));
  tempDirs.add(dataDir);

  scanId = await makeScan(dataDir, fixture.url);
  assert.ok(scanId > 0, "scanner must report a scan id");

  scanDb = new DatabaseSync(path.join(dataDir, "scans", `${scanId}.sqlite`), {
    readOnly: true,
  });

  const rows = scanDb
    .prepare("SELECT key, type, status, origin FROM nodes WHERE scan_id = ? ORDER BY id")
    .all(scanId);
  assert.ok(rows.length > 0, "scan must contain nodes");

  statusByKey = new Map();
  assetKeys = [];
  fuzzKeys = [];
  for (const row of rows) {
    const key = String(row.key);
    statusByKey.set(key, row.status == null ? null : Number(row.status));
    if (String(row.type) === "asset") assetKeys.push(key);
    if (String(row.origin) === "fuzz") fuzzKeys.push(key);
  }
  assert.ok(assetKeys.length > 0, "scan must contain asset nodes");
  assert.ok(fuzzKeys.length > 0, "scan must contain fuzz-origin nodes");

  server = await startServer(dataDir);
  const listing = await getJson(`${server.url}/api/scans`);
  const item = (listing.items || []).find((row) => Number(row.id) === scanId);
  assert.ok(item, `scan ${scanId} missing from /api/scans`);
  scanNodes = Number(item.nodes) || 0;
  assert.ok(scanNodes > 0, "scan must contain nodes");

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
  await waitUntil(async () => (await datasetCount()) === scanNodes, 30000, "initial dataset");

  await waitForExpression("(() => !!(window.__panel && typeof window.__panel.show === 'function'))()", 20000, "window.__panel");
  const shown = await evalJs("(() => window.__panel.show())()");
  assert.equal(shown, true, "__panel.show() must build the settings panel");
  await waitForExpression(
    "(() => !!document.querySelector('#panel #graph-settings-panel'))()",
    20000,
    "#graph-settings-panel"
  );
});

after(async () => {
  if (scanDb) {
    try {
      scanDb.close();
    } catch {
      /* best effort */
    }
  }
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

test("panel renders all four sections", { timeout: 60000 }, async () => {
  const text = await evalJs(
    "(() => { const el = document.getElementById('panel'); return el ? String(el.textContent || '') : ''; })()"
  );
  for (const title of ["Filters", "Display", "Forces", "Groups"]) {
    assert.ok(text.includes(title), `#panel text must contain ${title}; got: ${text.slice(0, 400)}`);
  }
});

test("disabling assets removes them", { timeout: 90000 }, async () => {
  const before = await datasetCount();
  const beforeIds = await objectIds();
  const beforeKeys = await renderedKeys();
  const assetsBefore = assetKeys.length;
  for (const key of assetKeys) {
    assert.ok(beforeKeys.includes(key), `asset key must render before filtering: ${key}`);
  }

  await clickFilter("asset");
  await waitUntil(async () => (await datasetCount()) < before, 20000, "asset filter shrinks dataset");

  const filteredCount = await datasetCount();
  const filteredKeys = await renderedKeys();
  const assetsAfter = assetKeys.filter((key) => filteredKeys.includes(key)).length;
  assert.equal(assetsAfter, 0, "no asset keys may survive the asset toggle");
  assert.equal(
    filteredCount,
    before - assetsBefore,
    `filtered count must equal before - assets (before=${before}, assets=${assetsBefore})`
  );
  console.log(`[panel] assets before=${before} after=${filteredCount} assets=${assetsBefore}`);

  await clickFilter("asset");
  await waitUntil(async () => (await datasetCount()) === before, 20000, "asset filter restores dataset");

  const afterKeys = await renderedKeys();
  const restored = assetKeys.filter((key) => afterKeys.includes(key));
  assert.equal(restored.length, assetKeys.length, "all asset keys must come back");

  const afterIds = await objectIds();
  // Re-added nodes are new engine objects by design, so identity is checked
  // over the nodes that stayed rendered throughout the toggle.
  const assetSet = new Set(assetKeys);
  const persistentBefore = {};
  for (const key of Object.keys(beforeIds)) {
    if (!assetSet.has(key)) persistentBefore[key] = beforeIds[key];
  }
  const ratio = overlapRatio(persistentBefore, afterIds);
  const fullRatio = overlapRatio(beforeIds, afterIds);
  console.log(
    `[panel] object id overlap after restore persistent=${(ratio * 100).toFixed(1)}% full=${(fullRatio * 100).toFixed(1)}%`
  );
  assert.ok(
    ratio >= 0.8,
    `persistent non-asset node object id overlap must be at least 80%, got ${(ratio * 100).toFixed(1)}%`
  );
});

test("status 4xx only", { timeout: 90000 }, async () => {
  const before = await datasetCount();
  for (const label of ["ok (2xx)", "redirect (3xx)", "serverErr (5xx)", "unknown (no status)"]) {
    await clickFilter(label);
  }
  await waitUntil(async () => (await datasetCount()) < before, 20000, "status filter shrinks dataset");

  const filtered = await renderedKeys();
  const bad = filtered.filter((key) => {
    const status = statusByKey.get(key);
    return !(Number.isInteger(status) && status >= 400 && status <= 499);
  });
  // The fixture ships /forbidden (403), so the clientErr bucket is non-empty.
  assert.ok(
    filtered.length > 0,
    "status 4xx filter must keep at least one node (fixture /forbidden -> 403)"
  );
  assert.deepEqual(bad, [], `only 400..499 nodes may remain, offenders: ${JSON.stringify(bad)}`);
  console.log(`[panel] status all before=${before} clientErr-only=${filtered.length}`);

  await clickButton("reset filters");
  await waitUntil(async () => (await datasetCount()) === before, 20000, "reset filters restores dataset");
});

test("origin filter", { timeout: 90000 }, async () => {
  const before = await datasetCount();
  await clickFilter("fuzz");
  await waitUntil(async () => (await datasetCount()) < before, 20000, "fuzz filter shrinks dataset");

  const filtered = await renderedKeys();
  const leaked = fuzzKeys.filter((key) => filtered.includes(key));
  assert.deepEqual(leaked, [], `fuzz-origin keys must disappear: ${JSON.stringify(leaked)}`);
  const backup = fuzzKeys.find((key) => /backup\.zip$/.test(key));
  assert.ok(backup, "fixture must yield a /backup.zip fuzz hit");
  assert.ok(!filtered.includes(backup), "fuzz-only /backup.zip must not render with fuzz off");
  console.log(`[panel] origin before=${before} crawl-only=${filtered.length} fuzzKeys=${fuzzKeys.length}`);

  await clickFilter("fuzz");
  await waitUntil(async () => (await datasetCount()) === before, 20000, "fuzz filter restores dataset");
});

test("display sliders call setRenderOptions", { timeout: 60000 }, async () => {
  const before = await evalJs("(() => Number(window.__recon.renderer.fNodeSizeMult))()");
  assert.equal(before, 1, "node size multiplier must start at 1");

  await setRange("node size", 2.5);
  await waitUntil(
    async () => (await evalJs("(() => Number(window.__recon.renderer.fNodeSizeMult))()")) === 2.5,
    10000,
    "renderer node size multiplier"
  );

  const errorText = await evalJs(
    "(() => { const el = document.getElementById('error'); return el ? String(el.textContent || '') : ''; })()"
  );
  assert.equal(errorText, "", `graph must keep rendering; #error=${errorText}`);
  assert.ok((await datasetCount()) > 0, "graph must still have nodes after render option change");
  console.log(`[panel] render nodeSize ${before} -> 2.5`);
});

test("forces sliders call setForces", { timeout: 60000 }, async () => {
  await evalJs(`(() => {
    const renderer = window.__recon.renderer;
    window.__forceCalls = [];
    if (!renderer.__forceWrapped) {
      const original = renderer.setForces.bind(renderer);
      renderer.setForces = function (options) {
        window.__forceCalls.push(JSON.parse(JSON.stringify(options || {})));
        return original(options);
      };
      renderer.__forceWrapped = true;
    }
  })()`);

  await setRange("repel force", 15);
  const changed = await waitUntil(
    async () => {
      const calls = await evalJs("(() => window.__forceCalls || [])()");
      const last = calls[calls.length - 1];
      return last && Number(last.repelStrength) === 3375 ? last : null;
    },
    10000,
    "repel force 15 -> repelStrength 3375"
  );
  assert.equal(Number(changed.repelStrength), 3375, "repel slider (cubed) must reach setForces");

  await clickButton("reset forces");
  const reset = await waitUntil(
    async () => {
      const calls = await evalJs("(() => window.__forceCalls || [])()");
      const last = calls[calls.length - 1];
      return last && Number(last.repelStrength) === 1000 ? last : null;
    },
    10000,
    "reset forces restores repelStrength 1000"
  );
  assert.equal(Number(reset.repelStrength), 1000, "reset must restore default repel force");
  const sliderValue = await evalJs(`(() => {
    const host = document.getElementById('panel');
    const rows = Array.from(host.querySelectorAll('.gs-setting-slider'));
    const row = rows.find((r) => {
      const name = r.querySelector('.gs-setting-name');
      return name && String(name.textContent || '').trim() === 'repel force';
    });
    return row ? Number(row.querySelector('input[type=range]').value) : null;
  })()`);
  assert.equal(sliderValue, 10, "reset must restore the repel slider to 10");
  console.log(`[panel] forces repel ${changed.repelStrength} -> reset ${reset.repelStrength}`);
});

test("groups persist", { timeout: 90000 }, async () => {
  const colour = "#123456";
  await setGroupColor("asset", colour);

  const stateColour = await waitUntil(
    async () => {
      const state = await evalJs("(() => window.__panel.state())()");
      return state && state.colors && state.colors.asset === colour ? state.colors.asset : null;
    },
    10000,
    "panel state asset colour"
  );
  assert.equal(stateColour, colour, "panel state must carry the new group colour");

  await sleep(300); // debounce is 80ms
  const stored = await evalJs(
    "(() => { try { return JSON.parse(localStorage.getItem('recon.panel.v1') || 'null'); } catch (_e) { return null; } })()"
  );
  assert.ok(stored && stored.colors && stored.colors.asset === colour, `localStorage must persist colour, got ${JSON.stringify(stored)}`);

  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForExpression(
    "(() => !!(window.__panel && typeof window.__panel.state === 'function'))()",
    30000,
    "window.__panel after reload"
  );
  await waitForExpression(
    "(() => !!(window.__recon && window.__recon.renderer))()",
    30000,
    "window.__recon after reload"
  );

  const restored = await evalJs("(() => window.__panel.state().colors.asset)()");
  assert.equal(restored, colour, "group colour must survive reload");
  console.log(`[panel] group colour persisted asset=${restored}`);
});
