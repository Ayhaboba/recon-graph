"use strict";

// Stage-1 contract tests for lib/db.js + lib/migrate.js (spec §5, §6).
//
// Invocation: `npm test` -> `node --test tests/*.test.js`.
// Do NOT use `node --test tests/` on Node 22.23.3 (directory positional fails).
//
// Isolation: one temp dir + one sqlite file for the whole suite; every test
// that mutates global counters creates its own scan row.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// node:sqlite is a builtin from Node 22.5. Tests must fail loudly (not skip)
// when the declared engine cannot provide the driver.
const sqlite = require("node:sqlite");
const dbApi = require("../lib/db.js");

const FTS_TEXT_CAP = 2 * 1024 * 1024;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-graph-db-"));
const dbPath = path.join(tmpDir, "recon.sqlite");
let db = null;
let scanCounter = 0;

before(() => {
  db = dbApi.openDb(dbPath);
});

after(() => {
  if (db) {
    dbApi.closeDb(db);
    db = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function newScan() {
  scanCounter += 1;
  return dbApi.createScan(db, {
    target: "https://scan-" + scanCounter + ".test/",
  });
}

function addNode(scanId, key, type, extra) {
  return dbApi.upsertNode(
    db,
    scanId,
    Object.assign({ key, type, origin: "seed", label: key }, extra || {})
  );
}

function countRows(table, scanId) {
  const row = db.raw
    .prepare("SELECT COUNT(*) AS c FROM " + table + " WHERE scan_id = ?")
    .get(scanId);
  return Number(row.c);
}

function nodeRow(nodeId) {
  return db.raw.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId);
}

function fakeSha(nodeId) {
  return (nodeId.toString(16) + "0".repeat(64)).slice(0, 64);
}

function putBody(nodeId, text, title) {
  dbApi.putBody(db, nodeId, {
    mime: "text/html",
    encoding: "utf-8",
    size: Buffer.byteLength(text, "utf8"),
    sha256: fakeSha(nodeId),
    filePath: path.join(tmpDir, "bodies", String(nodeId)),
    title: title || "body-" + nodeId,
    text,
  });
}

// Bulk helpers accept the documented return shape (array of
// {id, inserted} / ids) so the assertions stay about behaviour, not encoding.
function idOf(entry) {
  if (typeof entry === "number") return entry;
  if (entry && typeof entry === "object" && typeof entry.id === "number") {
    return entry.id;
  }
  throw new Error("unexpected bulk result entry: " + JSON.stringify(entry));
}

function bulkCount(value) {
  return Array.isArray(value) ? value.length : Number(value);
}

test("schema objects exist", () => {
  const rows = db.raw
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'trigger')")
    .all();
  const tables = new Set(rows.filter((r) => r.type === "table").map((r) => r.name));
  const triggers = new Set(rows.filter((r) => r.type === "trigger").map((r) => r.name));

  const expectedTables = [
    "rev_seq",
    "scans",
    "nodes",
    "edges",
    "bodies",
    "fts_docs",
    "findings",
    "queue",
    "node_fts",
  ];
  for (const name of expectedTables) {
    assert.ok(tables.has(name), "missing table: " + name);
  }

  const expectedTriggers = [
    "nodes_rev_insert",
    "nodes_rev_update",
    "edges_rev_insert",
    "edges_degree_insert",
    "edges_degree_delete",
    "nodes_ad",
    "fts_docs_ai",
    "fts_docs_ad",
    "fts_docs_au",
  ];
  for (const name of expectedTriggers) {
    assert.ok(triggers.has(name), "missing trigger: " + name);
  }

  const seq = db.raw.prepare("SELECT id, value FROM rev_seq").get();
  assert.ok(seq, "rev_seq must have its singleton row");
  assert.equal(seq.id, 1);
});

test("migrations are idempotent", () => {
  const migrate = require("../lib/migrate.js");
  assert.equal(typeof migrate.applyMigrations, "function");
  assert.equal(typeof migrate.withTransaction, "function");
  assert.equal(typeof migrate.SCHEMA_VERSION, "number");

  const mem = new sqlite.DatabaseSync(":memory:");
  try {
    const first = migrate.applyMigrations(mem);
    assert.ok(Array.isArray(first.applied), "applyMigrations must return { applied: [...] }");
    assert.ok(first.applied.length > 0, "a fresh db must apply at least one migration");

    const seq = mem.prepare("SELECT value FROM rev_seq WHERE id = 1").get();
    assert.ok(seq, "fresh db must have the rev_seq row");
    assert.equal(Number(seq.value), 0);

    const second = migrate.applyMigrations(mem);
    assert.deepEqual(second.applied, []);

    const versionRow = mem.prepare("PRAGMA user_version").get();
    assert.equal(Number(versionRow.user_version), migrate.SCHEMA_VERSION);

    const seqAgain = mem.prepare("SELECT value FROM rev_seq WHERE id = 1").get();
    assert.equal(Number(seqAgain.value), 0);
  } finally {
    mem.close();
  }
});

test("upsertNode inserts once and dedups by key", () => {
  const scanId = newScan();
  const key = "GET https://scan-dedup.test/page";

  const first = dbApi.upsertNode(db, scanId, { key, type: "page", origin: "seed" });
  assert.equal(first.inserted, true);
  assert.equal(typeof first.id, "number");

  const second = dbApi.upsertNode(db, scanId, { key, type: "page", origin: "seed" });
  assert.equal(second.inserted, false);
  assert.equal(second.id, first.id);
  assert.equal(countRows("nodes", scanId), 1);

  const beforeUpdate = dbApi.getNodeByKey(db, scanId, key);
  assert.equal(beforeUpdate.id, first.id);

  dbApi.upsertNode(db, scanId, { key, type: "page", origin: "seed", status: 200 });
  const afterUpdate = dbApi.getNodeByKey(db, scanId, key);

  assert.ok(
    afterUpdate.rev > beforeUpdate.rev,
    "rev must strictly increase after status update (" + beforeUpdate.rev + " -> " + afterUpdate.rev + ")"
  );
  assert.equal(afterUpdate.status, 200);
  assert.equal(countRows("nodes", scanId), 1);
});

test("degree maintained by triggers", () => {
  const scanId = newScan();
  const a = addNode(scanId, "GET https://scan-degree.test/a", "page").id;
  const b = addNode(scanId, "GET https://scan-degree.test/b", "page").id;
  const c = addNode(scanId, "GET https://scan-degree.test/c", "page").id;

  assert.equal(dbApi.addEdge(db, scanId, a, b, "link"), true);
  assert.equal(dbApi.addEdge(db, scanId, b, c, "link"), true);

  assert.equal(nodeRow(a).degree, 1);
  assert.equal(nodeRow(b).degree, 2);
  assert.equal(nodeRow(c).degree, 1);

  db.raw
    .prepare("DELETE FROM edges WHERE scan_id = ? AND src = ? AND dst = ? AND kind = ?")
    .run(scanId, a, b, "link");

  assert.equal(nodeRow(a).degree, 0);
  assert.equal(nodeRow(b).degree, 1);
  assert.equal(nodeRow(c).degree, 1);
});

test("edge unique constraint", () => {
  const scanId = newScan();
  const a = addNode(scanId, "GET https://scan-edge.test/a", "page").id;
  const b = addNode(scanId, "GET https://scan-edge.test/b", "page").id;

  assert.equal(dbApi.addEdge(db, scanId, a, b, "link"), true);
  assert.equal(dbApi.addEdge(db, scanId, a, b, "link"), false);

  assert.equal(countRows("edges", scanId), 1);
  assert.equal(nodeRow(a).degree, 1);
  assert.equal(nodeRow(b).degree, 1);
});

test("fts finds body text", () => {
  const scanId = newScan();
  const key = "GET https://scan-fts.test/page";
  const node = dbApi.upsertNode(db, scanId, {
    key,
    type: "page",
    origin: "seed",
    url: "https://scan-fts.test/page",
  });

  putBody(node.id, "<html>the delta-flag-marker appears here</html>", "Delta page");

  const hits = dbApi.search(db, scanId, "delta");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].nodeId, node.id);
  assert.equal(typeof hits[0].snippet, "string");
  assert.ok(hits[0].snippet.toLowerCase().includes("delta"), "snippet must contain the match");
  assert.ok("rule" in hits[0], "search hits must expose the spec's rule field");

  const misses = dbApi.search(db, scanId, "zzz-not-present");
  assert.equal(misses.length, 0);
});

test("fts no LIMIT by default", () => {
  const scanId = newScan();
  const total = 60;
  for (let i = 0; i < total; i += 1) {
    const node = dbApi.upsertNode(db, scanId, {
      key: "GET https://scan-fts-many.test/page-" + i,
      type: "page",
      origin: "seed",
      url: "https://scan-fts-many.test/page-" + i,
    });
    putBody(node.id, "manyhits token number " + i, "many " + i);
  }

  const all = dbApi.search(db, scanId, "manyhits");
  assert.equal(all.length, total);

  const limited = dbApi.search(db, scanId, "manyhits", { limit: 5 });
  assert.equal(limited.length, 5);
});

test("fts body truncation at 2 MiB", () => {
  const scanId = newScan();
  const keptToken = "HEADTOKEN";
  const tailToken = "TAILTOKEN";
  const body =
    keptToken + "A".repeat(FTS_TEXT_CAP - keptToken.length) + tailToken + "B".repeat(200 - tailToken.length);
  assert.equal(body.length, FTS_TEXT_CAP + 200);

  const node = dbApi.upsertNode(db, scanId, {
    key: "GET https://scan-fts-big.test/page",
    type: "page",
    origin: "seed",
    url: "https://scan-fts-big.test/page",
  });
  putBody(node.id, body, "huge");

  const row = db.raw
    .prepare("SELECT text, fts_truncated FROM bodies WHERE node_id = ?")
    .get(node.id);
  assert.equal(row.text.length, FTS_TEXT_CAP);
  assert.equal(row.fts_truncated, 1);

  // An oversized body is excluded from the index entirely: neither a token in
  // the stored first 2 MiB nor a token in the dropped tail may match.
  assert.equal(dbApi.search(db, scanId, keptToken).length, 0);
  assert.equal(dbApi.search(db, scanId, tailToken).length, 0);
});

test("oversized body excluded from fts", () => {
  const scanId = newScan();
  const headToken = "HEADTOKEN";
  const tailToken = "TAILTOKEN";
  const body =
    headToken + "A".repeat(FTS_TEXT_CAP - headToken.length) + tailToken + "B".repeat(200 - tailToken.length);
  assert.equal(body.length, FTS_TEXT_CAP + 200);

  const node = dbApi.upsertNode(db, scanId, {
    key: "GET https://oversized.test/oversized-node",
    type: "page",
    origin: "seed",
    url: "https://oversized.test/oversized-node",
  });
  putBody(node.id, body, "oversized");

  const bodyRow = db.raw
    .prepare("SELECT text, fts_truncated FROM bodies WHERE node_id = ?")
    .get(node.id);
  assert.equal(bodyRow.text.length, FTS_TEXT_CAP);
  assert.equal(bodyRow.fts_truncated, 1);

  const ftsRow = db.raw
    .prepare("SELECT body FROM fts_docs WHERE node_id = ?")
    .get(node.id);
  assert.ok(ftsRow, "fts_docs row must exist for the oversized node");
  assert.equal(ftsRow.body, null);

  assert.equal(dbApi.search(db, scanId, headToken).length, 0);
  assert.equal(dbApi.search(db, scanId, tailToken).length, 0);
});

test("oversized body url still searchable", () => {
  const scanId = newScan();
  const node = dbApi.upsertNode(db, scanId, {
    key: "GET https://oversized.test/oversized-node",
    type: "page",
    origin: "seed",
    url: "https://oversized.test/oversized-node",
  });
  putBody(node.id, "B".repeat(FTS_TEXT_CAP + 100), "oversized-url");

  const hits = dbApi.search(db, scanId, "oversized");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].nodeId, node.id);
});

test("delta by rev", () => {
  const scanId = newScan();
  const nodeA = addNode(scanId, "GET https://scan-delta.test/a", "page").id;
  const nodeB = addNode(scanId, "GET https://scan-delta.test/b", "page").id;
  const nodeC = addNode(scanId, "GET https://scan-delta.test/c", "endpoint").id;
  assert.equal(dbApi.addEdge(db, scanId, nodeA, nodeB, "link"), true);
  assert.equal(dbApi.addEdge(db, scanId, nodeB, nodeC, "request"), true);

  const first = dbApi.delta(db, scanId, 0);
  assert.equal(first.nodes.length, 3);
  assert.equal(first.edges.length, 2);
  assert.ok(first.cursor.rev > 0, "cursor.rev must be positive after the first delta");

  const second = dbApi.delta(db, scanId, first.cursor.rev);
  assert.equal(second.nodes.length, 0);
  assert.equal(second.edges.length, 0);

  dbApi.upsertNode(db, scanId, {
    key: "GET https://scan-delta.test/b",
    type: "page",
    origin: "seed",
    status: 500,
  });

  const third = dbApi.delta(db, scanId, first.cursor.rev);
  assert.equal(third.nodes.length, 1);
  assert.equal(third.nodes[0].id, nodeB);
  assert.equal(third.edges.length, 0);
});

test("delta delivers edge after cursor", () => {
  const scanId = newScan();
  const a = addNode(scanId, "GET https://scan-delta-edge.test/a", "page").id;
  const b = addNode(scanId, "GET https://scan-delta-edge.test/b", "page").id;
  addNode(scanId, "GET https://scan-delta-edge.test/c", "page");

  const baseline = dbApi.delta(db, scanId, 0);
  const cursor = baseline.cursor.rev;

  assert.equal(dbApi.addEdge(db, scanId, a, b, "link"), true);

  const after = dbApi.delta(db, scanId, cursor);
  assert.equal(after.edges.length, 1);
  assert.equal(after.edges[0].src, a);
  assert.equal(after.edges[0].dst, b);
  // The edge triggers bump degree on both endpoints, and degree is part of the
  // rev contract (spec §6: degree changes must reach the client), so the two
  // endpoints legitimately reappear. No unrelated node may leak in.
  assert.deepEqual(
    after.nodes.map((row) => row.id).sort((x, y) => x - y),
    [a, b].sort((x, y) => x - y)
  );
  assert.ok(after.cursor.rev > cursor, "cursor must advance past the new edge");
});

test("delta node after edge cursor", () => {
  const scanId = newScan();
  const a = addNode(scanId, "GET https://scan-delta-node.test/a", "page").id;
  const b = addNode(scanId, "GET https://scan-delta-node.test/b", "page").id;
  assert.equal(dbApi.addEdge(db, scanId, a, b, "link"), true);

  const baseline = dbApi.delta(db, scanId, 0);
  const cursor = baseline.cursor.rev;

  const fresh = addNode(scanId, "GET https://scan-delta-node.test/c", "page");

  const after = dbApi.delta(db, scanId, cursor);
  assert.equal(after.nodes.length, 1);
  assert.equal(after.nodes[0].id, fresh.id);
  assert.equal(after.edges.length, 0);
  assert.ok(after.cursor.rev > cursor, "cursor must advance past the new node");
});

test("partial upsert preserves fields", () => {
  const scanId = newScan();
  const key = "GET https://scan-partial.test/node";
  const first = dbApi.upsertNode(db, scanId, {
    key,
    type: "endpoint",
    origin: "crawl",
    label: "keep-me",
    url: "https://scan-partial.test/node",
    method: "GET",
    status: 200,
    depth: 3,
    attrs: { a: 1, b: 2 },
  });
  const before = nodeRow(first.id);

  const second = dbApi.upsertNode(db, scanId, {
    key,
    type: "endpoint",
    origin: "crawl",
  });
  assert.equal(second.id, first.id);
  assert.equal(second.inserted, false);

  const afterRow = nodeRow(first.id);
  assert.equal(afterRow.label, before.label);
  assert.equal(afterRow.url, before.url);
  assert.equal(afterRow.method, before.method);
  assert.equal(afterRow.status, before.status);
  assert.equal(afterRow.depth, before.depth);
  assert.equal(afterRow.attrs_json, before.attrs_json);
  assert.equal(Number(afterRow.rev), Number(before.rev));
});

test("explicit null clears field", () => {
  const scanId = newScan();
  const key = "GET https://scan-null.test/node";
  const first = dbApi.upsertNode(db, scanId, {
    key,
    type: "endpoint",
    origin: "crawl",
    status: 200,
  });
  assert.equal(Number(nodeRow(first.id).status), 200);

  dbApi.upsertNode(db, scanId, {
    key,
    type: "endpoint",
    origin: "crawl",
    status: null,
  });
  assert.equal(nodeRow(first.id).status, null);
});

test("attrs key order is a no-op", () => {
  const scanId = newScan();
  const key = "GET https://scan-attrs.test/node";
  const first = dbApi.upsertNode(db, scanId, {
    key,
    type: "page",
    origin: "crawl",
    attrs: { a: 1, b: 2 },
  });
  const revBefore = Number(nodeRow(first.id).rev);

  const second = dbApi.upsertNode(db, scanId, {
    key,
    type: "page",
    origin: "crawl",
    attrs: { b: 2, a: 1 },
  });
  assert.equal(second.id, first.id);
  assert.equal(second.inserted, false);
  assert.equal(Number(nodeRow(first.id).rev), revBefore);
  assert.equal(countRows("nodes", scanId), 1);
});

test("node delete clears fts", () => {
  const scanId = newScan();
  const node = dbApi.upsertNode(db, scanId, {
    key: "GET https://scan-delete-fts.test/node",
    type: "page",
    origin: "seed",
    url: "https://scan-delete-fts.test/node",
  });
  putBody(node.id, "deleteme token lives here", "delete me");
  assert.equal(dbApi.search(db, scanId, "deleteme").length, 1);

  db.raw.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);

  assert.equal(dbApi.search(db, scanId, "deleteme").length, 0);
  const ftsRow = db.raw
    .prepare("SELECT node_id FROM fts_docs WHERE node_id = ?")
    .get(node.id);
  assert.equal(ftsRow, undefined);
});

test("stats counts", () => {
  const scanId = newScan();
  const page = addNode(scanId, "GET https://scan-stats.test/", "page").id;
  const endpoint = addNode(scanId, "GET https://scan-stats.test/api", "endpoint").id;
  const asset = addNode(scanId, "GET https://scan-stats.test/app.js", "asset").id;
  assert.equal(dbApi.addEdge(db, scanId, page, endpoint, "request"), true);
  assert.equal(dbApi.addEdge(db, scanId, page, asset, "link"), true);

  const result = dbApi.stats(db, scanId);
  assert.equal(result.nodes, 3);
  assert.equal(result.edges, 2);
  assert.equal(result.pending, 0);
  assert.equal(result.inflight, 0);
  assert.equal(result.done, 0);
  assert.equal(result.err, 0);
  assert.deepEqual({ ...result.byType }, { page: 1, endpoint: 1, asset: 1 });
});

test("stats queue states", () => {
  const scanId = newScan();
  const insertQueue = db.raw.prepare(
    "INSERT INTO queue(scan_id, url, kind, origin, state) VALUES(?, ?, 'page', 'seed', ?)"
  );
  insertQueue.run(scanId, "https://scan-queue.test/pending", "pending");
  insertQueue.run(scanId, "https://scan-queue.test/inflight", "inflight");
  insertQueue.run(scanId, "https://scan-queue.test/done", "done");
  insertQueue.run(scanId, "https://scan-queue.test/err", "err");

  const result = dbApi.stats(db, scanId);
  assert.equal(result.pending, 1);
  assert.equal(result.inflight, 1);
  assert.equal(result.done, 1);
  assert.equal(result.err, 1);
});

test("bulk upsert and edges in one transaction", () => {
  const scanId = newScan();
  const nodes = [
    { key: "GET https://scan-bulk.test/a", type: "page", origin: "crawl" },
    { key: "GET https://scan-bulk.test/b", type: "page", origin: "crawl" },
    { key: "GET https://scan-bulk.test/c", type: "endpoint", origin: "crawl" },
  ];

  const inserted = dbApi.upsertNodes(db, scanId, nodes);
  assert.equal(bulkCount(inserted), 3);
  const ids = inserted.map(idOf);
  assert.deepEqual(ids, [
    dbApi.getNodeByKey(db, scanId, nodes[0].key).id,
    dbApi.getNodeByKey(db, scanId, nodes[1].key).id,
    dbApi.getNodeByKey(db, scanId, nodes[2].key).id,
  ]);
  assert.equal(countRows("nodes", scanId), 3);

  const edgeSpecs = [
    { src: ids[0], dst: ids[1], kind: "link" },
    { src: ids[1], dst: ids[2], kind: "request" },
  ];
  const added = dbApi.addEdges(db, scanId, edgeSpecs);
  assert.equal(bulkCount(added), 2);
  assert.equal(countRows("edges", scanId), 2);

  const again = dbApi.upsertNodes(db, scanId, nodes);
  assert.equal(bulkCount(again), 3);
  for (const entry of again) {
    assert.equal(idOf(entry), ids[again.indexOf(entry)]);
    assert.ok(
      entry && typeof entry === "object" && entry.inserted === false,
      "re-upsert must report inserted === false"
    );
  }
  assert.equal(countRows("nodes", scanId), 3);
  assert.equal(countRows("edges", scanId), 2);
});

test("openReadOnly does not write", () => {
  const ro = dbApi.openReadOnly(dbPath);
  try {
    assert.equal(ro.readOnly, true);
    assert.throws(() => {
      ro.raw
        .prepare(
          "INSERT INTO scans(target, mode, status, started_at) VALUES('x', 'active', 'running', 0)"
        )
        .run();
    }, /readonly|read-only/i);
  } finally {
    ro.close();
  }

  assert.throws(() => dbApi.openReadOnly(path.join(tmpDir, "missing.sqlite")));
});
