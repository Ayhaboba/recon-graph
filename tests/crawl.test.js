"use strict";

// Stage-3 integration tests: bin/scanner.js + lib/crawl.js against the
// reference fixture in tests/site/.
//
// Invocation: `node --test tests/crawl.test.js` (or `npm test`).
// Builtins only: node:test, node:assert, node:child_process, node:fs,
// node:os, node:path, node:sqlite, node:events.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(__dirname, "site", "server.js");
const SCANNER = path.join(ROOT, "bin", "scanner.js");

// Shared fixture server and temp bookkeeping.
let fixture = null;
const tempDirs = [];

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `recon-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, "--port", "0"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`fixture server did not start:\n${out}\n${err}`));
    }, 10000);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /\[fixture\] listening on (http:\/\/[^\s]+\/)/.exec(out);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: match[1] });
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `fixture server exited early code=${code} signal=${signal}:\n${out}\n${err}`
        )
      );
    });
  });
}

function runScanner(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCANNER, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(`scanner timed out after ${timeoutMs}ms:\n${stdout}\n${stderr}`)
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function scanDbPath(dataRoot, scanId = 1) {
  return path.join(dataRoot, "scans", `${scanId}.sqlite`);
}

function openScanDb(dataRoot, scanId = 1) {
  const file = scanDbPath(dataRoot, scanId);
  assert.ok(fs.existsSync(file), `scan database missing: ${file}`);
  return new DatabaseSync(file);
}

function readScan(db, scanId = 1) {
  return db.prepare("SELECT * FROM scans WHERE id = ?").get(scanId);
}

function readNodes(db, scanId = 1) {
  return db.prepare("SELECT * FROM nodes WHERE scan_id = ?").all(scanId);
}

function readEdges(db, scanId = 1) {
  return db.prepare("SELECT * FROM edges WHERE scan_id = ?").all(scanId);
}

function readQueue(db, scanId = 1) {
  return db
    .prepare("SELECT state, count(*) AS c FROM queue WHERE scan_id = ? GROUP BY state")
    .all(scanId);
}

function queueCount(db, scanId, state) {
  const row = db
    .prepare("SELECT count(*) AS c FROM queue WHERE scan_id = ? AND state = ?")
    .get(scanId, state);
  return Number(row.c);
}

function nodePathname(node) {
  const raw =
    node.url ||
    (typeof node.key === "string" ? node.key.replace(/^[A-Z]+ /, "") : null);
  if (!raw) return null;
  try {
    return new URL(raw).pathname;
  } catch (_err) {
    return null;
  }
}

function collapsePath(pathname) {
  if (!pathname) return pathname;
  const collapsed = pathname.replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

function findNodeByPath(nodes, pathname) {
  const wanted = collapsePath(pathname);
  return nodes.find((node) => collapsePath(nodePathname(node)) === wanted) || null;
}

async function waitForScanStarted(dataRoot, scanId = 1, timeoutMs = 30000) {
  const file = scanDbPath(dataRoot, scanId);
  const deadline = Date.now() + timeoutMs;
  let db = null;

  try {
    while (Date.now() < deadline) {
      try {
        if (!db && fs.existsSync(file)) db = new DatabaseSync(file);
        if (db) {
          const nodeRow = db
            .prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?")
            .get(scanId);
          const queueRow = db
            .prepare("SELECT count(*) AS c FROM queue WHERE scan_id = ?")
            .get(scanId);
          if (Number(nodeRow.c) >= 1 && Number(queueRow.c) >= 1) {
            db.close();
            return;
          }
        }
      } catch (_err) {
        // database may still be initialising or busy; retry
      }
      await sleep(20);
    }
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_err) {
        // already closed
      }
    }
  }

  throw new Error(`scan ${scanId} did not start within ${timeoutMs}ms`);
}

before(async () => {
  fixture = await startFixture();
});

after(async () => {
  if (fixture) {
    const child = fixture.child;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), sleep(3000)]);
    }
  }
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_err) {
      // best-effort cleanup
    }
  }
});

test("depth 3 crawl writes nodes and edges", async () => {
  const tmp = makeTempDir("depth3");
  const dataRoot = path.join(tmp, "data");

  const result = await runScanner([
    fixture.url,
    "--max-depth",
    "3",
    "--delay",
    "0",
    "--data-dir",
    dataRoot,
  ]);
  assert.equal(result.code, 0, result.stderr);

  const db = openScanDb(dataRoot);
  try {
    const scan = readScan(db);
    assert.ok(scan, "scan row missing");
    assert.equal(scan.status, "done");
    assert.equal(scan.target, fixture.url);

    const nodes = readNodes(db);
    const edges = readEdges(db);

    assert.ok(nodes.length >= 8, `expected >= 8 nodes, got ${nodes.length}`);
    assert.ok(edges.length >= 8, `expected >= 8 edges, got ${edges.length}`);

    const root = findNodeByPath(nodes, "/");
    assert.ok(root, "root node missing");
    assert.equal(root.type, "page");
    assert.equal(root.depth, 0);
    assert.equal(root.status, 200);
    assert.ok(Number(root.degree) > 0, `root degree=${root.degree}`);

    const page1 = findNodeByPath(nodes, "/page1.html");
    assert.ok(page1, "/page1.html node missing");
    assert.equal(page1.depth, 1);

    // Chain: page1 (1) -> page2 (2) -> page3 (3) -> page4/page5 (4/5,
    // beyond the limit).
    const page2 = findNodeByPath(nodes, "/page2.html");
    assert.ok(page2, "/page2.html node missing");
    assert.equal(page2.depth, 2);

    const page3 = findNodeByPath(nodes, "/page3.html");
    assert.ok(page3, "/page3.html node missing");
    assert.equal(page3.depth, 3);

    // Depth limit: no non-unresolved node may sit deeper than max-depth.
    for (const node of nodes) {
      if (node.depth !== null && Number(node.depth) > 3) {
        assert.equal(node.type, "unresolved", `deep node ${node.key} is ${node.type}`);
        assert.equal(node.status, null, `deep node ${node.key} was fetched`);
      }
    }

    const page4 = findNodeByPath(nodes, "/page4.html");
    assert.ok(page4, "/page4.html node missing (expected unresolved)");
    assert.equal(page4.type, "unresolved");
    assert.equal(page4.status, null);
    assert.ok(Number(page4.depth) >= 4, `page4 depth=${page4.depth}`);

    const page5 = findNodeByPath(nodes, "/page5.html");
    if (page5) {
      assert.equal(page5.type, "unresolved");
      assert.equal(page5.status, null);
      assert.ok(Number(page5.depth) >= 4, `page5 depth=${page5.depth}`);
    }

    const artifacts = nodes.filter((node) => node.type === "artifact");
    assert.ok(
      artifacts.length >= 1,
      `expected an artifact node from flag.html, got ${artifacts.length}`
    );
    const findings = db
      .prepare("SELECT count(*) AS c FROM findings WHERE scan_id = ? AND rule = 'flag'")
      .get(1);
    assert.ok(Number(findings.c) >= 1, "flag finding missing");
  } finally {
    db.close();
  }
});

test("rerun does not duplicate nodes", async () => {
  const tmp = makeTempDir("dedupe");
  const dataRoot = path.join(tmp, "data");

  const first = await runScanner([
    fixture.url,
    "--max-depth",
    "3",
    "--delay",
    "0",
    "--data-dir",
    dataRoot,
  ]);
  assert.equal(first.code, 0, first.stderr);

  const dbBefore = openScanDb(dataRoot);
  let beforeNodes;
  let beforeEdges;
  try {
    beforeNodes = readNodes(dbBefore).length;
    beforeEdges = readEdges(dbBefore).length;
  } finally {
    dbBefore.close();
  }

  const second = await runScanner([
    "--resume",
    "1",
    "--delay",
    "0",
    "--data-dir",
    dataRoot,
  ]);
  assert.equal(second.code, 0, second.stderr);

  const db = openScanDb(dataRoot);
  try {
    const scan = readScan(db);
    assert.equal(scan.status, "done");
    assert.equal(readNodes(db).length, beforeNodes, "node count changed on rerun");
    assert.equal(readEdges(db).length, beforeEdges, "edge count changed on rerun");
  } finally {
    db.close();
  }
});

test("robots.txt is respected by default", async () => {
  const defaultTmp = makeTempDir("robots-default");
  const defaultRoot = path.join(defaultTmp, "data");
  const defaultRun = await runScanner([
    fixture.url,
    "--max-depth",
    "3",
    "--delay",
    "0",
    "--data-dir",
    defaultRoot,
  ]);
  assert.equal(defaultRun.code, 0, defaultRun.stderr);

  const defaultDb = openScanDb(defaultRoot);
  try {
    const nodes = readNodes(defaultDb);
    const secretNodes = nodes.filter((node) => {
      const p = collapsePath(nodePathname(node));
      return p === "/secret" || p === "/secret.html";
    });
    for (const node of secretNodes) {
      assert.equal(node.status, null, `robots-disallowed ${node.key} was fetched`);
    }
  } finally {
    defaultDb.close();
  }

  const ignoreTmp = makeTempDir("robots-ignore");
  const ignoreRoot = path.join(ignoreTmp, "data");
  const ignoreRun = await runScanner([
    fixture.url,
    "--max-depth",
    "3",
    "--delay",
    "0",
    "--ignore-robots",
    "--data-dir",
    ignoreRoot,
  ]);
  assert.equal(ignoreRun.code, 0, ignoreRun.stderr);

  const ignoreDb = openScanDb(ignoreRoot);
  try {
    const nodes = readNodes(ignoreDb);
    const secret = findNodeByPath(nodes, "/secret");
    assert.ok(secret, "robots-disallowed node missing with --ignore-robots");
    assert.equal(secret.status, 200);
  } finally {
    ignoreDb.close();
  }
});

// Tests 4 and 5 share one data directory: the SIGINT-stopped scan is resumed.
const interrupted = { dataRoot: null, nodesBeforeResume: 0 };

test("SIGINT leaves status stopped and requeues inflight", async () => {
  const tmp = makeTempDir("sigint");
  const dataRoot = path.join(tmp, "data");
  interrupted.dataRoot = dataRoot;

  const child = spawn(
    process.execPath,
    [
      SCANNER,
      fixture.url,
      "--max-depth",
      "6",
      "--delay",
      "400",
      "--data-dir",
      dataRoot,
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitForScanStarted(dataRoot);

    child.kill("SIGINT");
    const exit = await Promise.race([
      exitPromise,
      sleep(30000).then(() => {
        throw new Error("scanner did not exit after SIGINT");
      }),
    ]);
    void exit;
  } catch (err) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    err.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    throw err;
  }

  const db = openScanDb(dataRoot);
  try {
    const scan = readScan(db);
    assert.ok(scan, "scan row missing after SIGINT");
    assert.equal(scan.status, "stopped");

    assert.ok(queueCount(db, 1, "pending") > 0, "pending queue is empty after SIGINT");
    assert.equal(queueCount(db, 1, "inflight"), 0, "inflight queue row left behind");

    interrupted.nodesBeforeResume = readNodes(db).length;
    assert.ok(interrupted.nodesBeforeResume >= 1);
  } finally {
    db.close();
  }
});

test("--resume continues the same scan", async () => {
  assert.ok(interrupted.dataRoot, "test 4 (SIGINT) did not run");
  const dataRoot = interrupted.dataRoot;

  const result = await runScanner([
    "--resume",
    "1",
    "--delay",
    "0",
    "--data-dir",
    dataRoot,
  ]);
  assert.equal(result.code, 0, result.stderr);

  const db = openScanDb(dataRoot);
  try {
    const scan = readScan(db);
    assert.equal(scan.status, "done");
    assert.ok(
      readNodes(db).length > interrupted.nodesBeforeResume,
      "resume added no nodes"
    );
    assert.equal(queueCount(db, 1, "pending"), 0, "pending queue not drained");
  } finally {
    db.close();
  }
});

test("redirect chain becomes endpoint nodes", async () => {
  const tmp = makeTempDir("redirects");
  const dataRoot = path.join(tmp, "data");
  const target = new URL("redirect-2", fixture.url).href;

  const result = await runScanner([
    target,
    "--max-depth",
    "1",
    "--delay",
    "0",
    "--data-dir",
    dataRoot,
  ]);
  assert.equal(result.code, 0, result.stderr);

  const db = openScanDb(dataRoot);
  try {
    const nodes = readNodes(db);
    const redirect1 = nodes.find(
      (node) =>
        collapsePath(nodePathname(node)) === "/redirect-1" &&
        node.type === "endpoint" &&
        Number(node.status) === 302
    );
    const redirect2 = nodes.find(
      (node) =>
        collapsePath(nodePathname(node)) === "/redirect-2" &&
        node.type === "endpoint" &&
        Number(node.status) === 301
    );

    assert.ok(redirect1, "302 node for /redirect-1 missing");
    assert.ok(redirect2, "301 node for /redirect-2 missing");

    const edges = readEdges(db);
    const linked = edges.some(
      (edge) =>
        (edge.src === redirect1.id && edge.dst === redirect2.id) ||
        (edge.src === redirect2.id && edge.dst === redirect1.id)
    );
    assert.ok(linked, "redirect hop edge missing");
  } finally {
    db.close();
  }
});

test("scanner CLI rejects bad input", async () => {
  const noArgs = await runScanner([], 15000);
  assert.equal(noArgs.code, 2, `no args exit=${noArgs.code}\n${noArgs.stderr}`);

  const badScheme = await runScanner(["ftp://x"], 15000);
  assert.equal(
    badScheme.code,
    2,
    `ftp target exit=${badScheme.code}\n${badScheme.stderr}`
  );

  const tmp = makeTempDir("resume-missing");
  const dataRoot = path.join(tmp, "data");
  const missing = await runScanner(
    ["--resume", "999", "--data-dir", dataRoot],
    15000
  );
  assert.equal(
    missing.code,
    1,
    `missing scan exit=${missing.code}\n${missing.stderr}`
  );
});
