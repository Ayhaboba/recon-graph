"use strict";

// Stage 4: dictionary fuzzer + soft-404 detection against tests/site fixture.
//
// The fixture server prints one line on startup; every test that needs HTTP
// spawns its own instance on an ephemeral port and kills it with SIGTERM.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(__dirname, "site");
const SCANNER = path.join(ROOT, "bin", "scanner.js");

const {
  openDb,
  createScan,
  upsertNode,
  closeDb,
} = require("../lib/db");
const { key, normalizeUrl } = require("../lib/norm");
const { parseWordlist, probeSoft404, createFuzzer } = require("../lib/fuzz");

const tmpDirs = [];
function makeTmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `recon-fuzz-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_err) {
      // best effort cleanup
    }
  }
});

function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(SITE, "server.js"), "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`fixture did not start: ${stderr}`));
    }, 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /\[fixture\] listening on (http:\/\/127\.0\.0\.1:\d+\/)/.exec(
        stdout
      );
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ base: match[1], child });
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`fixture exited early (${code == null ? signal : code}): ${stderr}`)
      );
    });
  });
}

function stopFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
}

function collectFuzzRows(db, scanId) {
  return db.raw
    .prepare(
      "SELECT * FROM nodes WHERE scan_id = ? AND origin = 'fuzz' ORDER BY key"
    )
    .all(scanId);
}

// Shared state between the e2e scan test and the resume test.
let e2eState = null;

test("parseWordlist trims comments and dedupes", () => {
  const words = parseWordlist(
    "# c\nadmin\n\nbackup.zip\nadmin\n  api/v1/  \n"
  );
  assert.deepEqual(words, ["admin", "backup.zip", "api/v1/"]);
});

test("probeSoft404 returns the fixture's generic page signature", async (t) => {
  makeTmpDir("probe");
  const fixture = await startFixture();
  t.after(() => stopFixture(fixture.child));

  const reference = await probeSoft404({
    baseUrl: fixture.base,
    options: { timeout: 5000 },
  });

  assert.ok(reference, "probeSoft404 returned null");
  assert.match(
    String(reference.sha256),
    /^[0-9a-f]{64}$/,
    `sha256=${reference.sha256}`
  );
  assert.ok(
    Number.isInteger(Number(reference.size)) && Number(reference.size) > 0,
    `size=${reference.size}`
  );
});

test("fuzzer finds admin backup.zip and api/v1", async (t) => {
  const dir = makeTmpDir("hits");
  const fixture = await startFixture();
  t.after(() => stopFixture(fixture.child));

  const db = openDb(path.join(dir, "scan.sqlite"));
  try {
    const scanId = createScan(db, { target: fixture.base, mode: "active" });
    const rootKey = key(fixture.base);
    const root = upsertNode(db, scanId, {
      key: rootKey,
      type: "page",
      url: normalizeUrl(fixture.base),
      status: 200,
      depth: 0,
      origin: "crawl",
    });

    const fuzzer = createFuzzer({
      db,
      scanId,
      target: fixture.base,
      options: {
        wordlist: ["admin", "backup.zip", "api/v1/", "nonexistent"],
        dirs: [fixture.base],
        delay: 0,
        timeout: 5000,
        concurrency: 2,
      },
    });
    const result = await fuzzer.run();
    assert.ok(result.tested >= 4, `tested=${result.tested}`);

    const rows = collectFuzzRows(db, scanId);
    assert.equal(
      rows.length,
      3,
      `expected 3 fuzz nodes, got: ${rows.map((row) => row.key).join(", ")}`
    );

    const nodeKeys = rows.map((row) => row.key);
    for (const suffix of ["/admin", "/backup.zip", "/api/v1"]) {
      assert.ok(
        nodeKeys.some((nodeKey) => nodeKey.endsWith(suffix)),
        `missing key ending with ${suffix}: ${nodeKeys.join(", ")}`
      );
    }

    const allowed = new Set([200, 301, 302, 403]);
    for (const row of rows) {
      assert.ok(row.status !== null, `null status for ${row.key}`);
      assert.ok(
        allowed.has(Number(row.status)),
        `unexpected status ${row.status} for ${row.key}`
      );
      const edge = db.raw
        .prepare(
          "SELECT 1 AS ok FROM edges WHERE scan_id = ? AND src = ? AND dst = ? AND kind = 'fuzzed'"
        )
        .get(scanId, root.id, row.id);
      assert.ok(edge !== undefined, `missing fuzzed edge for ${row.key}`);
    }
  } finally {
    closeDb(db);
  }
});

test("soft-404 is not a finding", async (t) => {
  const dir = makeTmpDir("soft");
  const fixture = await startFixture();
  t.after(() => stopFixture(fixture.child));

  const db = openDb(path.join(dir, "scan.sqlite"));
  try {
    const scanId = createScan(db, { target: fixture.base, mode: "active" });
    upsertNode(db, scanId, {
      key: key(fixture.base),
      type: "page",
      url: normalizeUrl(fixture.base),
      status: 200,
      depth: 0,
      origin: "crawl",
    });

    const fuzzer = createFuzzer({
      db,
      scanId,
      target: fixture.base,
      options: {
        wordlist: ["nonexistent"],
        dirs: [fixture.base],
        delay: 0,
        timeout: 5000,
        concurrency: 1,
      },
    });
    const result = await fuzzer.run();

    assert.ok(result.softSkips >= 1, `softSkips=${result.softSkips}`);
    const rows = collectFuzzRows(db, scanId);
    assert.equal(rows.length, 0, `soft-404 became a finding: ${rows.map((r) => r.key).join(", ")}`);
    assert.ok(
      !rows.some((row) => row.key.includes("nonexistent")),
      "nonexistent node was stored"
    );
  } finally {
    closeDb(db);
  }
});

test("end to end through the scanner", async (t) => {
  const dir = makeTmpDir("e2e");
  const dataDir = path.join(dir, "data");
  const fixture = await startFixture();
  t.after(() => stopFixture(fixture.child));

  const run = spawnSync(
    process.execPath,
    [
      SCANNER,
      fixture.base,
      "--max-depth",
      "2",
      "--delay",
      "0",
      "--wordlist",
      "lists/common.txt",
      "--data-dir",
      dataDir,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 120000 }
  );

  assert.equal(
    run.status,
    0,
    `scanner exit ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
  );

  const scansDir = path.join(dataDir, "scans");
  const dbFiles = fs
    .readdirSync(scansDir)
    .filter((name) => name.endsWith(".sqlite"));
  assert.equal(dbFiles.length, 1, `scan databases: ${dbFiles.join(", ")}`);

  const db = openDb(path.join(scansDir, dbFiles[0]));
  try {
    const scanId = Number(dbFiles[0].replace(/\.sqlite$/, ""));
    const allKeys = db.raw
      .prepare("SELECT key FROM nodes WHERE scan_id = ?")
      .all(scanId)
      .map((row) => row.key);

    const fuzzCount = Number(
      db.raw
        .prepare(
          "SELECT count(*) AS c FROM nodes WHERE scan_id = ? AND origin = 'fuzz'"
        )
        .get(scanId).c
    );
    assert.ok(fuzzCount >= 1, `fuzz nodes=${fuzzCount}`);

    const admin = db.raw
      .prepare(
        "SELECT * FROM nodes WHERE scan_id = ? AND (key LIKE '%/admin' OR key LIKE '%/admin/') AND status IS NOT NULL"
      )
      .get(scanId);
    assert.ok(admin !== undefined, "no /admin node with a status");

    const api = db.raw
      .prepare(
        "SELECT * FROM nodes WHERE scan_id = ? AND (key LIKE '%/api/v1' OR key LIKE '%/api/v1/')"
      )
      .get(scanId);
    assert.ok(api !== undefined, "no /api/v1 node");

    const badFuzz = db.raw
      .prepare(
        "SELECT key FROM nodes WHERE scan_id = ? AND origin = 'fuzz' AND (key LIKE '%/nonexistent' OR key LIKE '%/nonexistent/')"
      )
      .all(scanId);
    assert.equal(badFuzz.length, 0, `fuzz stored nonexistent: ${badFuzz.map((r) => r.key).join(", ")}`);

    const nodeCount = Number(
      db.raw
        .prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?")
        .get(scanId).c
    );

    e2eState = { dataDir, scanId, nodeCount, sampleKeys: allKeys.slice(0, 5) };
  } finally {
    closeDb(db);
  }
});

test("resume keeps the stored wordlist and depth", async (t) => {
  const dir = makeTmpDir("resume");
  const fixture = await startFixture();
  t.after(() => stopFixture(fixture.child));

  assert.ok(e2eState, "e2e scan test did not produce state");

  // Own temp dir: copy the scan database from the e2e run, then resume there.
  const dataDir = path.join(dir, "data");
  fs.cpSync(e2eState.dataDir, dataDir, { recursive: true });

  const beforeDb = openDb(
    path.join(dataDir, "scans", `${e2eState.scanId}.sqlite`)
  );
  let beforeCount;
  try {
    beforeCount = Number(
      beforeDb.raw
        .prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?")
        .get(e2eState.scanId).c
    );
  } finally {
    closeDb(beforeDb);
  }

  const run = spawnSync(
    process.execPath,
    [
      SCANNER,
      "--resume",
      String(e2eState.scanId),
      "--data-dir",
      dataDir,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 120000 }
  );

  assert.equal(
    run.status,
    0,
    `resume exit ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`
  );
  assert.match(run.stdout, /resume options: depth=2\b/);

  const wordlistMatch = /resume options: depth=2[^\n]*wordlist=([^\s]+)/.exec(
    run.stdout
  );
  assert.ok(wordlistMatch, `no wordlist in resume output:\n${run.stdout}`);
  assert.ok(
    wordlistMatch[1].endsWith(path.join("lists", "common.txt")),
    `wordlist points at ${wordlistMatch[1]}`
  );

  const db = openDb(
    path.join(dataDir, "scans", `${e2eState.scanId}.sqlite`)
  );
  try {
    const afterCount = Number(
      db.raw
        .prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?")
        .get(e2eState.scanId).c
    );
    assert.ok(
      afterCount >= beforeCount,
      `node count decreased: ${beforeCount} -> ${afterCount}`
    );

    const duplicates = db.raw
      .prepare(
        `SELECT key, count(*) AS c
           FROM nodes
          WHERE scan_id = ? AND origin = 'fuzz'
          GROUP BY key
         HAVING count(*) > 1`
      )
      .all(e2eState.scanId);
    assert.equal(
      duplicates.length,
      0,
      `duplicate fuzz keys: ${duplicates.map((row) => row.key).join(", ")}`
    );
  } finally {
    closeDb(db);
  }

  void fixture;
});
