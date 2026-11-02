"use strict";

/**
 * Stage 7 — inspector tests (spec §7.2, §9 row 7).
 *
 * Criterion: a click gives details; refetch arrives as a delta; subgraph
 * builds a local graph and "back" restores the global one; curl/open are
 * wired; "load full" replaces the truncated body preview.
 *
 * Real chromium is driven over CDP, reusing the stage 6 helper shapes.
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

// ---------------------------------------------------------------------------
// process helpers (same shapes as tests/client.test.js)
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

function nodeRow(pattern) {
  return scanDb
    .prepare(
      "SELECT id, key, status, rev, degree FROM nodes WHERE scan_id = ? AND key LIKE ? ORDER BY id LIMIT 1"
    )
    .get(scanId, pattern);
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

const inspectorCurrentExpr =
  "(() => (window.__inspector && typeof window.__inspector.current === 'function') ? window.__inspector.current() : null)()";

const panelTextExpr =
  "(() => { const el = document.getElementById('panel'); return el ? String(el.textContent || '') : ''; })()";

async function panelText() {
  return evalJs(panelTextExpr);
}

async function waitForCurrentNode(id, timeoutMs = 30000) {
  return waitUntil(
    async () => {
      const current = await evalJs(inspectorCurrentExpr);
      if (!current) return null;
      const node = current.node || current;
      return Number(node.id) === Number(id) ? current : null;
    },
    timeoutMs,
    `inspector node ${id}`
  );
}

async function requestNode(id) {
  await evalJs(`window.__recon.requestNode(${Number(id)})`);
  return waitForCurrentNode(id);
}

async function visible(selector) {
  return evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  })()`);
}

// Finds any object with `rule` in the current inspector payload, whatever
// nesting the inspector chooses for findings.
const findingRulesExpr = `(() => {
  const current = ${inspectorCurrentExpr};
  const rules = [];
  const seen = new Set();
  const walk = (value, depth) => {
    if (!value || depth > 8 || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (typeof value.rule === 'string') rules.push(value.rule);
    if (typeof value.rule === 'object' && value.rule && typeof value.rule.id === 'string') {
      rules.push(value.rule.id);
    }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(current, 0);
  return rules;
})()`;

const previewLengthExpr = `(() => {
  const panel = document.getElementById('panel');
  if (!panel) return 0;
  const nodes = Array.from(panel.querySelectorAll('pre'));
  let max = 0;
  for (const node of nodes) max = Math.max(max, String(node.textContent || '').length);
  return max;
})()`;

const messageHasFullExpr = `(() => {
  const msg = window.__recon && window.__recon.lastMessage ? window.__recon.lastMessage() : null;
  const seen = new Set();
  let found = false;
  const walk = (value, depth) => {
    if (found || !value || depth > 8 || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.full === true) { found = true; return; }
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(msg, 0);
  return found;
})()`;

// ---------------------------------------------------------------------------
// setup / teardown
// ---------------------------------------------------------------------------

before(async () => {
  fixture = await startFixture();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "recon-inspector-"));
  tempDirs.add(dataDir);

  scanId = await makeScan(dataDir, fixture.url);
  assert.ok(scanId > 0, "scanner must report a scan id");

  scanDb = new DatabaseSync(path.join(dataDir, "scans", `${scanId}.sqlite`), {
    readOnly: true,
  });

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
  await waitUntil(async () => Number(await evalJs(datasetCountExpr)) === scanNodes, 30000, "initial dataset");
  assert.ok(await visible("#panel"), "#panel must be visible at 1400x900");
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

test("node payload shows url status headers body and findings", { timeout: 120000 }, async () => {
  const flag = nodeRow("%/flag.html");
  const status = nodeRow("%/api/v1/status.json");
  assert.ok(flag, "flag.html node missing from scan");
  assert.ok(status, "status.json node missing from scan (fixture link?)");

  await requestNode(flag.id);
  await waitUntil(async () => (await panelText()).includes(flag.key), 20000, "flag url in #panel");

  const flagInfo = await evalJs(`(() => {
    const panel = document.getElementById('panel');
    const text = panel ? String(panel.textContent || '') : '';
    const rows = panel ? Array.from(panel.querySelectorAll('tr')).map((row) => String(row.textContent || '')) : [];
    const pres = panel ? Array.from(panel.querySelectorAll('pre')).map((node) => String(node.textContent || '')) : [];
    const current = ${inspectorCurrentExpr};
    const node = current && current.node ? current.node : current;
    return { text, rows, pres, status: node ? node.status : null };
  })()`);

  assert.match(flagInfo.text, /flag\.html/, "#panel must show the node URL");
  assert.equal(Number(flagInfo.status), Number(flag.status), "inspector node status must match the scan");
  assert.match(flagInfo.text, new RegExp(String(flag.status)), "#panel must show the status code");
  assert.ok(
    flagInfo.pres.some((text) => text.trim().length > 0),
    "#panel must render a non-empty body preview"
  );

  const rules = await evalJs(findingRulesExpr);
  assert.ok(
    rules.some((rule) => /flag/i.test(String(rule))),
    `expected a flag finding, got ${JSON.stringify(rules)}`
  );

  await requestNode(status.id);
  await waitUntil(
    async () => /content-type/i.test(await panelText()),
    20000,
    "content-type header row"
  );

  const headerInfo = await evalJs(`(() => {
    const panel = document.getElementById('panel');
    const rows = panel ? Array.from(panel.querySelectorAll('tr')).map((row) => String(row.textContent || '')) : [];
    const pres = panel ? Array.from(panel.querySelectorAll('pre')).map((node) => String(node.textContent || '')) : [];
    const text = panel ? String(panel.textContent || '') : '';
    return { rows, pres, text };
  })()`);

  assert.ok(headerInfo.rows.length > 0, "#panel must render a headers table");
  assert.ok(
    headerInfo.rows.some((row) => /content-type/i.test(row)),
    `headers table must contain a content-type row; rows=${JSON.stringify(headerInfo.rows)}`
  );
  assert.match(headerInfo.text, /"ok"\s*:\s*true/, "status.json body preview must be visible");
  assert.ok(
    headerInfo.pres.some((text) => text.trim().length > 0),
    "status.json body preview must be non-empty"
  );
});

test("curl action returns a valid command", { timeout: 60000 }, async () => {
  const status = nodeRow("%/api/v1/status.json");
  assert.ok(status, "status.json node missing");
  await requestNode(status.id);

  await evalJs(`window.__recon.send({ t: "action", id: ${Number(status.id)}, cmd: "curl" })`);
  const command = await waitUntil(
    async () => {
      const text = await evalJs(
        "(() => { const el = document.getElementById('curl-out'); return el ? String(el.textContent || '') : ''; })()"
      );
      return text.trim() ? text.trim() : null;
    },
    20000,
    "#curl-out text"
  );

  assert.match(command, /^curl\s/, `curl command must start with "curl ", got: ${command.slice(0, 120)}`);
  // node keys are "METHOD URL"; the curl command carries the URL without the method prefix.
  const statusUrl = String(status.key).replace(/^[A-Z]+ /, "");
  assert.ok(command.includes(statusUrl), `curl command must contain the URL ${statusUrl}`);
  assert.ok(command.includes("-H"), `curl command must forward headers, got: ${command.slice(0, 200)}`);
});

test("refetch bumps rev and arrives as a delta", { timeout: 90000 }, async () => {
  const flag = nodeRow("%/flag.html");
  assert.ok(flag, "flag.html node missing");

  const before = await requestNode(flag.id);
  const nodeBefore = before.node || before;
  const revBefore = Number(nodeBefore.rev);
  assert.ok(Number.isFinite(revBefore), `inspector node must expose rev, got ${nodeBefore.rev}`);

  await evalJs(`window.__recon.send({ t: "action", id: ${Number(flag.id)}, cmd: "refetch" })`);

  const after = await waitUntil(
    async () => {
      const current = await evalJs(inspectorCurrentExpr);
      if (!current) return null;
      const node = current.node || current;
      const rev = Number(node.rev);
      if (!(rev > revBefore)) return null;
      const last = await evalJs(
        "(() => { const msg = window.__recon && window.__recon.lastMessage ? window.__recon.lastMessage() : null; return msg ? String(msg.t || '') : ''; })()"
      );
      return last === "delta" ? current : null;
    },
    40000,
    "refetch delta with a higher rev"
  );

  const nodeAfter = after.node || after;
  assert.ok(Number(nodeAfter.rev) > revBefore, `rev must grow: ${revBefore} -> ${nodeAfter.rev}`);
  assert.equal(Number(nodeAfter.status), 200, "refetched node must keep status 200");
});

test("subgraph and back to global", { timeout: 90000 }, async () => {
  const hub = nodeRow("%/page2.html");
  assert.ok(hub, "page2.html node missing");

  const before = Number(await evalJs(datasetCountExpr));
  assert.ok(before > 0, "global graph must be populated");

  await evalJs(`window.__recon.setLocalGraph(${JSON.stringify(hub.key)})`);
  const localCount = await waitUntil(
    async () => {
      const isLocal = await evalJs("(() => !!(window.__recon.isLocalGraph && window.__recon.isLocalGraph()))()");
      if (!isLocal) return null;
      const count = Number(await evalJs(datasetCountExpr));
      return count < before ? count : null;
    },
    30000,
    "local subgraph smaller than the global graph"
  );
  assert.ok(localCount < before, `local graph (${localCount}) must be smaller than global (${before})`);
  assert.ok(await visible("#graph-back"), "#graph-back must be visible inside a local graph");

  await evalJs("(() => { const el = document.getElementById('graph-back'); if (el) el.click(); })()");
  await waitUntil(
    async () => {
      const isLocal = await evalJs("(() => !!(window.__recon.isLocalGraph && window.__recon.isLocalGraph()))()");
      if (isLocal) return null;
      const count = Number(await evalJs(datasetCountExpr));
      return count === before ? count : null;
    },
    30000,
    "global graph restored"
  );

  assert.equal(Number(await evalJs(datasetCountExpr)), before, "back must restore the global count");
  assert.equal(await visible("#graph-back"), false, "#graph-back must hide in global mode");
});

test("copy url and open buttons exist and are wired", { timeout: 60000 }, async () => {
  const status = nodeRow("%/api/v1/status.json");
  assert.ok(status, "status.json node missing");
  await requestNode(status.id);

  const buttons = await waitUntil(
    async () => {
      const list = await evalJs(`(() => {
        const panel = document.getElementById('panel');
        if (!panel) return [];
        return Array.from(panel.querySelectorAll('button')).map((button) => ({
          id: String(button.id || ''),
          text: String(button.textContent || '').trim(),
          title: String(button.title || ''),
          url: String(button.dataset.url || button.dataset.href || button.getAttribute('data-url') || ''),
          aria: String(button.getAttribute('aria-label') || '')
        }));
      })()`);
      const copy = list.find((button) => /copy/i.test(`${button.id} ${button.text} ${button.aria} ${button.title}`));
      const open = list.find((button) => /open/i.test(`${button.id} ${button.text} ${button.aria} ${button.title}`));
      return copy && open ? { list, copy, open } : null;
    },
    20000,
    "copy and open buttons"
  );

  assert.ok(buttons.copy, "copy URL button missing");
  assert.ok(buttons.open, "open button missing");

  const openTarget = buttons.open.url || buttons.open.title;
  assert.match(
    openTarget,
    /^https?:\/\//,
    `open button must expose its URL via title or data-url, got ${JSON.stringify(buttons.open)}`
  );
  assert.ok(
    openTarget.includes(status.key) || openTarget.startsWith("http"),
    "open button URL must look usable"
  );
});

test("body load full", { timeout: 90000 }, async () => {
  // index.html normalises to "/", so the root node key is "GET <origin>/".
  const index = nodeRow(`GET ${fixture.url}/`);
  assert.ok(index, "root node (normalised index.html) missing");
  await requestNode(index.id);

  const before = Number(await evalJs(previewLengthExpr));
  assert.ok(before > 0, "body preview must be rendered before load-full");

  const hasButton = await evalJs(
    "(() => !!document.getElementById('load-full'))()"
  );
  assert.ok(hasButton, "#load-full button missing");

  await evalJs("(() => { const el = document.getElementById('load-full'); if (el) el.click(); })()");

  await waitUntil(
    async () => {
      if (!(await evalJs(messageHasFullExpr))) return false;
      const current = await evalJs(inspectorCurrentExpr);
      if (!current) return false;
      const length = Number(await evalJs(previewLengthExpr));
      return length > before ? length : false;
    },
    30000,
    "full body payload and a larger preview"
  );

  const after = Number(await evalJs(previewLengthExpr));
  assert.ok(after > before, `preview must grow: ${before} -> ${after}`);
});
