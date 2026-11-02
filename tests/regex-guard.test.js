"use strict";

/**
 * Stage 8 repair — regex guard tests.
 *
 * Proves the worker_threads engine contains a catastrophic pattern without
 * blocking the event loop, that the cheap heuristic fast path still wins, and
 * that a normal regex keeps matching afterwards.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const db = require("../lib/db");
const { searchScan } = require("../lib/search");

let dataDir = null;
let handle = null;
let scanId = 0;

const CATASTROPHIC = "(a|aa)+$";
const SAFE = "fl[a-z]+\\{";

function addNode(id, text) {
  const url = `http://regex.test/node/${id}.html`;
  const node = db.upsertNode(handle, scanId, {
    key: `GET ${url}`,
    type: "page",
    label: `regex node ${id}`,
    url,
    method: "GET",
    status: 200,
    depth: 1,
    origin: "crawl",
    attrs: {},
  });
  db.putBody(handle, node.id, {
    text,
    mime: "text/html",
    encoding: "utf-8",
    size: Buffer.byteLength(text, "utf8"),
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    filePath: `/regex/${id}.html`,
    title: `Regex ${id}`,
  });
}

before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "recon-regex-"));
  fs.mkdirSync(path.join(dataDir, "scans"), { recursive: true });
  scanId = 1;
  handle = db.openDb(path.join(dataDir, "scans", `${scanId}.sqlite`));
  db.createScan(handle, {
    id: scanId,
    target: "http://regex.test/",
    mode: "active",
    rootKey: "GET http://regex.test/",
    options: {},
  });

  // Trailing non-"a" is what forces (a|aa)+$ to backtrack; all-"a" bodies
  // simply match on the first attempt and prove nothing.
  addNode(1, "a".repeat(39) + "!");
  addNode(2, "a".repeat(4 * 1024 * 1024 - 1) + "!");
  addNode(3, "synthetic flag{guard} body");
  addNode(4, "nothing interesting here");

  db.setScanStatus(handle, scanId, "complete", { stats: { nodes: 4, edges: 0 } });
});

after(async () => {
  if (handle) {
    try {
      handle.close();
    } catch (_err) {
      // best effort
    }
  }
  if (dataDir) {
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function timedSearch(q, opts) {
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    if (gap > maxGap) maxGap = gap;
    last = now;
  }, 20);
  const startedAt = Date.now();
  try {
    const result = await searchScan({
      dbHandle: handle,
      scanId,
      q,
      mode: "regex",
      opts,
    });
    const elapsed = Date.now() - startedAt;
    const tail = Date.now() - last;
    if (tail > maxGap) maxGap = tail;
    return { result, elapsed, maxGap };
  } finally {
    clearInterval(timer);
  }
}

test("heuristic still rejects known-bad shapes immediately", async () => {
  const { result, elapsed } = await timedSearch("(a+)+$");
  assert.equal(result.error, "regex-unsafe");
  assert.ok(elapsed < 500, `heuristic must be fast, took ${elapsed} ms`);
});

test("catastrophic pattern is aborted on a 40-char body", async () => {
  const { result, elapsed, maxGap } = await timedSearch(CATASTROPHIC, {
    regexTimeoutMs: 300,
  });
  assert.equal(result.error, "regex-timeout");
  assert.equal(result.partial, true);
  assert.ok(elapsed < 2000, `abort must be bounded, took ${elapsed} ms`);
  assert.ok(maxGap < 500, `event loop must stay responsive, max gap ${maxGap} ms`);
});

test("catastrophic pattern is aborted on a 4 MB body", async () => {
  const { result, elapsed, maxGap } = await timedSearch(CATASTROPHIC, {
    regexTimeoutMs: 300,
  });
  assert.equal(result.error, "regex-timeout");
  assert.equal(result.partial, true);
  assert.ok(elapsed < 2000, `abort must be bounded, took ${elapsed} ms`);
  assert.ok(maxGap < 500, `event loop must stay responsive, max gap ${maxGap} ms`);
});

test("normal regex still matches after aborts", async () => {
  const { result } = await timedSearch(SAFE, { regexTimeoutMs: 2000 });
  assert.equal(result.error, undefined);
  assert.equal(result.count, 1);
  assert.equal(result.ids.length, 1);
  assert.equal(result.truncated, false);
});
