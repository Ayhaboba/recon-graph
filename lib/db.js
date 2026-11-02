"use strict";

/**
 * recon-graph SQLite layer.
 *
 * Zero dependencies beyond Node builtins. `node:sqlite` is loaded lazily so
 * `--help` works even on Node builds where the module is flag-gated.
 *
 * Design rules enforced here:
 *  - rev/degree are owned by SQL triggers in lib/migrate.js. This module never
 *    recomputes or writes them.
 *  - upsertNode performs no UPDATE when nothing changed (an unconditional
 *    UPDATE would fire the rev trigger and spam delta consumers). Absent node
 *    fields mean "keep existing"; an explicit null means "set NULL".
 *  - bodies larger than 2 MiB never enter the FTS index (spec §5): their text
 *    is kept truncated in `bodies` for preview, `fts_docs.body` stays NULL.
 *  - search() emits no LIMIT clause when opts.limit is 0/falsy.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// Transaction helper owned by the migration module (shared savepoint depth).
const { withTransaction } = require("./migrate");

// FTS5 excluded-body threshold. Measured in UTF-8 bytes because the spec cap
// is a byte size; bodies at or below it are indexed in full.
const FTS_TEXT_CAP = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Driver loading / re-exec
// ---------------------------------------------------------------------------

function loadSqlite() {
  try {
    return require("node:sqlite");
  } catch (err) {
    const code = (err && err.code) || "";
    const message = String((err && err.message) || err);
    const needsFlag =
      code === "ERR_UNKNOWN_BUILTIN_MODULE" || /experimental/i.test(message);

    if (!needsFlag) throw err;
    // Never loop: child sets RECON_SQLITE_REEXEC=1.
    if (process.env.RECON_SQLITE_REEXEC === "1") throw err;
    // Only the CLI entry point may restart the process; as a library we let
    // the caller deal with the missing driver.
    if (require.main !== module) throw err;

    const { spawnSync } = require("node:child_process");
    const result = spawnSync(
      process.execPath,
      ["--experimental-sqlite", __filename, ...process.argv.slice(2)],
      {
        stdio: "inherit",
        env: Object.assign({}, process.env, { RECON_SQLITE_REEXEC: "1" }),
      }
    );
    process.exit(result.status == null ? 1 : result.status);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rawOf(db) {
  return db && db.raw ? db.raw : db;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Canonical attrs: recursively sorted object keys, arrays keep their order.
// `{a:1,b:2}` and `{b:2,a:1}` serialise identically, so they neither create a
// spurious UPDATE nor bump rev.
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

function attrsToJson(attrs) {
  if (attrs === undefined || attrs === null) return "{}";
  return JSON.stringify(sortKeys(attrs));
}

function nullish(value) {
  return value === undefined ? null : value;
}

function toNullableText(value) {
  return value === undefined || value === null ? null : String(value);
}

function toNullableInt(value) {
  return value === undefined || value === null ? null : Number(value);
}

// Caller-supplied FTS syntax is passed through untouched; otherwise every bare
// whitespace token is quoted so user input can never act as FTS operators.
function buildFtsQuery(query) {
  const raw = query == null ? "" : String(query).trim();
  if (!raw) return "";

  const explicitSyntax =
    raw.includes('"') || /(^|[\s(])(?:OR|AND|NOT|NEAR)(?=[\s)]|$)/.test(raw);
  if (explicitSyntax) return raw;

  const tokens = raw
    .split(/\s+/)
    .map((token) => token.replace(/["*():^+\-]/g, " "))
    .flatMap((token) => token.split(/\s+/))
    .filter(Boolean);

  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"`).join(" ");
}

// Only malformed FTS expressions are downgraded to "no hits". Anything else
// (missing table, corrupt schema, SQL bug) must surface.
function isFtsSyntaxError(err) {
  const message = String((err && err.message) || err);
  // SQLITE_ERROR (errcode 1) with an FTS5 parser complaint. "unterminated"
  // is what the tokenizer says for an unclosed quoted phrase.
  if (!/fts5|syntax|malformed|unterminated/i.test(message)) return false;
  const errcode = err && typeof err.errcode === "number" ? err.errcode : null;
  return errcode === null || errcode === 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function openDb(filePath) {
  if (filePath === undefined || filePath === null || filePath === "") {
    throw new TypeError("openDb(filePath): filePath is required");
  }

  const requested = String(filePath);
  const isMemory = requested === ":memory:";
  const absolute = isMemory ? requested : path.resolve(requested);

  if (!isMemory) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
  }

  const { DatabaseSync } = loadSqlite();
  const raw = new DatabaseSync(absolute);

  const migrate = require("./migrate");
  if (!migrate || typeof migrate.applyMigrations !== "function") {
    throw new Error("lib/migrate.js must export applyMigrations(db)");
  }

  const pragmas = Array.isArray(migrate.PRAGMAS) ? migrate.PRAGMAS : [];
  for (const pragma of pragmas) {
    try {
      raw.exec(String(pragma));
    } catch (_err) {
      // WAL is not supported for :memory:; pragmas are best-effort by contract.
    }
  }

  migrate.applyMigrations(raw);

  let closed = false;
  return {
    raw,
    path: absolute,
    close() {
      if (closed) return;
      closed = true;
      raw.close();
    },
  };
}

// Stage-5 server opener: never migrates, never creates the file, never takes a
// write lock. Only busy_timeout is applied (a connection hint, not DDL/DML).
function openReadOnly(filePath) {
  if (filePath === undefined || filePath === null || filePath === "") {
    throw new TypeError("openReadOnly(filePath): filePath is required");
  }

  const absolute = path.resolve(String(filePath));
  if (!fs.existsSync(absolute)) {
    throw new Error(`openReadOnly: database not found: ${absolute}`);
  }

  const { DatabaseSync } = loadSqlite();
  const raw = new DatabaseSync(absolute, { readOnly: true });

  try {
    raw.exec("PRAGMA busy_timeout=5000");
  } catch (_err) {
    // best effort: a read-only handle must still open if the pragma is denied
  }

  let closed = false;
  return {
    raw,
    path: absolute,
    readOnly: true,
    close() {
      if (closed) return;
      closed = true;
      raw.close();
    },
  };
}

function createScan(db, opts) {
  const raw = rawOf(db);
  const options = opts || {};
  if (!options.target) throw new TypeError("createScan: opts.target required");

  const mode = options.mode == null ? "active" : String(options.mode);
  const rootKey = options.rootKey == null ? null : String(options.rootKey);
  const optionsJson = JSON.stringify(
    options.options == null ? {} : options.options
  );
  const startedAt = Date.now();

  // Caller-chosen scan ids let bin/scanner.js keep the id == file name
  // (`data/scans/<id>.sqlite`) before the row exists.
  if (options.id !== undefined && options.id !== null) {
    const id = Number(options.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new TypeError("createScan: opts.id must be a positive integer");
    }
    raw
      .prepare(
        `INSERT INTO scans(id, target, mode, root_key, status, options_json, started_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, String(options.target), mode, rootKey, "running", optionsJson, startedAt);
    return id;
  }

  const info = raw
    .prepare(
      `INSERT INTO scans(target, mode, root_key, status, options_json, started_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    )
    .run(String(options.target), mode, rootKey, "running", optionsJson, startedAt);

  return Number(info.lastInsertRowid);
}

function getScan(db, scanId) {
  const raw = rawOf(db);
  const row = raw.prepare("SELECT * FROM scans WHERE id = ?").get(scanId);
  return row === undefined ? null : row;
}

function setScanStatus(db, scanId, status, extra) {
  const raw = rawOf(db);
  const options = extra || {};
  const finishedAt = options.finishedAt == null ? null : Number(options.finishedAt);

  if (options.stats !== undefined) {
    raw.prepare(
      `UPDATE scans
          SET status = ?, finished_at = COALESCE(?, finished_at), stats_json = ?
        WHERE id = ?`
    ).run(String(status), finishedAt, JSON.stringify(options.stats), scanId);
  } else {
    raw.prepare(
      `UPDATE scans
          SET status = ?, finished_at = COALESCE(?, finished_at)
        WHERE id = ?`
    ).run(String(status), finishedAt, scanId);
  }
}

// Column names are constants, never caller input.
const NODE_FIELDS = [
  "type",
  "label",
  "url",
  "method",
  "status",
  "depth",
  "attrs_json",
];

function upsertNode(db, scanId, node) {
  const raw = rawOf(db);
  if (!node) throw new TypeError("upsertNode: node required");
  if (node.key === undefined || node.key === null) {
    throw new TypeError("upsertNode: node.key required");
  }
  if (node.type === undefined || node.type === null) {
    throw new TypeError("upsertNode: node.type required");
  }
  if (node.origin === undefined || node.origin === null) {
    throw new TypeError("upsertNode: node.origin required");
  }

  const key = String(node.key);

  // Only fields explicitly present in the payload may change. Absent fields
  // keep their stored value on UPDATE and become NULL on INSERT.
  const incoming = {};
  incoming.type = String(node.type);
  if ("label" in node) incoming.label = toNullableText(node.label);
  if ("url" in node) incoming.url = toNullableText(node.url);
  if ("method" in node) incoming.method = toNullableText(node.method);
  if ("status" in node) incoming.status = toNullableInt(node.status);
  if ("depth" in node) incoming.depth = toNullableInt(node.depth);
  if ("attrs" in node) incoming.attrs_json = attrsToJson(node.attrs);

  const existing = raw
    .prepare("SELECT * FROM nodes WHERE scan_id = ? AND key = ?")
    .get(scanId, key);

  if (existing === undefined) {
    const info = raw
      .prepare(
        `INSERT INTO nodes(
           scan_id, key, type, label, url, method, status, depth,
           origin, attrs_json, first_seen
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        scanId,
        key,
        incoming.type,
        "label" in incoming ? incoming.label : null,
        "url" in incoming ? incoming.url : null,
        "method" in incoming ? incoming.method : null,
        "status" in incoming ? incoming.status : null,
        "depth" in incoming ? incoming.depth : null,
        String(node.origin),
        "attrs_json" in incoming ? incoming.attrs_json : "{}",
        Date.now()
      );
    return { id: Number(info.lastInsertRowid), inserted: true };
  }

  // Build a SET list containing only columns whose persisted value differs.
  // Naming fewer columns also keeps the AFTER UPDATE OF trigger honest: a
  // label-only change does not bump rev.
  const changes = {};
  for (const field of NODE_FIELDS) {
    if (!(field in incoming)) continue;
    const before = existing[field];
    const after = incoming[field];
    if (before !== after) changes[field] = after;
  }

  const columns = Object.keys(changes);
  if (columns.length === 0) {
    // No UPDATE: keeps the AFTER UPDATE OF ... rev trigger silent.
    return { id: Number(existing.id), inserted: false };
  }

  raw
    .prepare(
      `UPDATE nodes SET ${columns.map((column) => `${column} = ?`).join(", ")}
        WHERE id = ?`
    )
    .run(...columns.map((column) => changes[column]), existing.id);

  return { id: Number(existing.id), inserted: false };
}

function upsertNodes(db, scanId, nodesArray) {
  const raw = rawOf(db);
  const list = Array.isArray(nodesArray) ? nodesArray : [];
  if (list.length === 0) return [];

  return withTransaction(raw, () =>
    list.map((node) => upsertNode(raw, scanId, node))
  );
}

function getNodeByKey(db, scanId, key) {
  const raw = rawOf(db);
  const row = raw
    .prepare("SELECT * FROM nodes WHERE scan_id = ? AND key = ?")
    .get(scanId, String(key));
  return row === undefined ? null : row;
}

function getNodeById(db, nodeId) {
  const raw = rawOf(db);
  const row = raw.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId);
  return row === undefined ? null : row;
}

// ---------------------------------------------------------------------------
// Queue (spec §5): pending -> inflight -> done|skip|err
// ---------------------------------------------------------------------------

const QUEUE_STATES = new Set(["pending", "inflight", "done", "skip", "err"]);

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function enqueue(db, scanId, item) {
  const raw = rawOf(db);
  if (!item) throw new TypeError("enqueue: item required");
  if (item.url === undefined || item.url === null || item.url === "") {
    throw new TypeError("enqueue: item.url required");
  }
  if (item.kind === undefined || item.kind === null || item.kind === "") {
    throw new TypeError("enqueue: item.kind required");
  }

  const info = raw
    .prepare(
      `INSERT OR IGNORE INTO queue(
         scan_id, url, kind, depth, origin, state, priority
       ) VALUES(?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      scanId,
      String(item.url),
      String(item.kind),
      finiteOr(item.depth, 0),
      item.origin == null ? "crawl" : String(item.origin),
      finiteOr(item.priority, 0)
    );

  return Number(info.changes) === 1;
}

// SELECT + UPDATE in one transaction: two writers can never claim the same
// row. BEGIN IMMEDIATE (withTransaction) also serialises this against other
// processes opening the same scan database.
function claimNext(db, scanId) {
  const raw = rawOf(db);

  return withTransaction(raw, () => {
    const row = raw
      .prepare(
        `SELECT * FROM queue
          WHERE scan_id = ? AND state = 'pending'
          ORDER BY priority DESC, id ASC
          LIMIT 1`
      )
      .get(scanId);
    if (row === undefined) return null;

    const info = raw
      .prepare(
        `UPDATE queue
            SET state = 'inflight', attempts = attempts + 1
          WHERE id = ? AND state = 'pending'`
      )
      .run(row.id);
    if (Number(info.changes) !== 1) return null;

    row.state = "inflight";
    row.attempts = Number(row.attempts) + 1;
    return row;
  });
}

function setQueueState(db, queueId, state, opts) {
  const raw = rawOf(db);
  const next = String(state);
  if (!QUEUE_STATES.has(next)) {
    throw new TypeError(`setQueueState: invalid state "${next}"`);
  }

  const options = opts || {};
  const error =
    options.error === undefined || options.error === null
      ? null
      : String(options.error);

  const info = raw
    .prepare("UPDATE queue SET state = ?, last_error = ? WHERE id = ?")
    .run(next, error, queueId);

  return Number(info.changes);
}

function requeueInflight(db, scanId) {
  const raw = rawOf(db);
  const info = raw
    .prepare(
      "UPDATE queue SET state = 'pending' WHERE scan_id = ? AND state = 'inflight'"
    )
    .run(scanId);
  return Number(info.changes);
}

function queueCounts(db, scanId) {
  const raw = rawOf(db);
  const row = raw
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN state = 'pending'  THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN state = 'inflight' THEN 1 ELSE 0 END), 0) AS inflight,
         COALESCE(SUM(CASE WHEN state = 'done'     THEN 1 ELSE 0 END), 0) AS done,
         COALESCE(SUM(CASE WHEN state = 'skip'     THEN 1 ELSE 0 END), 0) AS skip,
         COALESCE(SUM(CASE WHEN state = 'err'      THEN 1 ELSE 0 END), 0) AS err
       FROM queue WHERE scan_id = ?`
    )
    .get(scanId);

  return {
    pending: Number(row.pending),
    inflight: Number(row.inflight),
    done: Number(row.done),
    skip: Number(row.skip),
    err: Number(row.err),
  };
}

function addEdge(db, scanId, srcId, dstId, kind, attrs) {
  const raw = rawOf(db);
  if (kind === undefined || kind === null) {
    throw new TypeError("addEdge: kind required");
  }

  const info = raw
    .prepare(
      `INSERT OR IGNORE INTO edges(scan_id, src, dst, kind, attrs_json)
       VALUES(?, ?, ?, ?, ?)`
    )
    .run(scanId, srcId, dstId, String(kind), attrsToJson(attrs));

  return Number(info.changes) === 1;
}

function addEdges(db, scanId, edgesArray) {
  const raw = rawOf(db);
  const list = Array.isArray(edgesArray) ? edgesArray : [];
  if (list.length === 0) return 0;

  return withTransaction(raw, () => {
    let inserted = 0;
    for (const edge of list) {
      if (!edge) throw new TypeError("addEdges: edge entry required");
      if (addEdge(raw, scanId, edge.src, edge.dst, edge.kind, edge.attrs)) {
        inserted += 1;
      }
    }
    return inserted;
  });
}

function putBody(db, nodeId, body) {
  const raw = rawOf(db);
  const input = body || {};

  const sourceText =
    input.text === undefined || input.text === null ? null : String(input.text);

  // Oversized bodies are excluded from FTS entirely (spec §5): keep a
  // truncated copy in `bodies` for the preview pane, index url/title only.
  let text = sourceText;
  let ftsBody = sourceText;
  let ftsTruncated = input.truncated ? 1 : 0;
  if (sourceText !== null && Buffer.byteLength(sourceText, "utf8") > FTS_TEXT_CAP) {
    text = sourceText.slice(0, FTS_TEXT_CAP);
    ftsBody = null;
    ftsTruncated = 1;
  }

  const mime = nullish(input.mime);
  const encoding = nullish(input.encoding);
  const size = input.size === undefined || input.size === null ? null : Number(input.size);
  const sha256 = nullish(input.sha256);
  const filePath = nullish(input.filePath);
  const title = nullish(input.title);

  // One transaction: bodies and fts_docs must never drift apart.
  withTransaction(raw, () => {
    const node = raw
      .prepare("SELECT id, scan_id, url FROM nodes WHERE id = ?")
      .get(nodeId);
    if (node === undefined) {
      throw new Error(`putBody: node ${nodeId} not found`);
    }

    raw.prepare(
      `INSERT INTO bodies(
         node_id, mime, encoding, size, sha256, file_path, title, text, fts_truncated
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         mime = excluded.mime,
         encoding = excluded.encoding,
         size = excluded.size,
         sha256 = excluded.sha256,
         file_path = excluded.file_path,
         title = excluded.title,
         text = excluded.text,
         fts_truncated = excluded.fts_truncated`
    ).run(nodeId, mime, encoding, size, sha256, filePath, title, text, ftsTruncated);

    // fts_docs scan_id/url come from the node row, never from the body payload.
    // The AFTER INSERT/UPDATE trigger on fts_docs mirrors this into node_fts;
    // body=NULL means "url/title searchable, body not indexed".
    raw.prepare(
      `INSERT INTO fts_docs(node_id, scan_id, url, title, body)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         url = excluded.url,
         title = excluded.title,
         body = excluded.body`
    ).run(nodeId, node.scan_id, node.url, title, ftsBody);
  });
}

function search(db, scanId, query, opts) {
  const raw = rawOf(db);
  const match = buildFtsQuery(query);
  if (!match) return [];

  const options = opts || {};
  const limit = Number(options.limit) || 0;

  // One query: FTS match + first finding rule per node (NULL when none).
  let sql =
    `SELECT d.node_id AS nodeId, d.url AS url, d.title AS title, ` +
    `snippet(node_fts, 2, '[', ']', '…', 12) AS snippet, ` +
    `f.rule AS rule ` +
    `FROM node_fts ` +
    `JOIN fts_docs AS d ON node_fts.rowid = d.node_id ` +
    `LEFT JOIN findings AS f ON f.id = (` +
    `  SELECT MIN(f2.id) FROM findings AS f2 WHERE f2.node_id = d.node_id` +
    `) ` +
    `WHERE node_fts MATCH ? AND d.scan_id = ?`;
  const params = [match, scanId];

  if (limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }

  let rows;
  try {
    rows = raw.prepare(sql).all(...params);
  } catch (err) {
    // Only a malformed caller-supplied FTS expression is "no hits".
    if (isFtsSyntaxError(err)) return [];
    throw err;
  }

  return rows.map((row) => ({
    nodeId: Number(row.nodeId),
    url: row.url,
    title: row.title,
    // snippet() is NULL for url/title-only matches (or excluded bodies).
    snippet: row.snippet == null ? "" : String(row.snippet),
    rule: row.rule == null ? null : row.rule,
  }));
}

function delta(db, scanId, afterRev) {
  const raw = rawOf(db);
  const after = Number(afterRev) || 0;

  const run = () => {
    const nodes = raw
      .prepare("SELECT * FROM nodes WHERE scan_id = ? AND rev > ? ORDER BY rev")
      .all(scanId, after);
    const edges = raw
      .prepare("SELECT * FROM edges WHERE scan_id = ? AND rev > ? ORDER BY rev")
      .all(scanId, after);

    // nodes.rev and edges.rev share one monotonic sequence (rev_seq), so the
    // max over both result sets is a safe cross-table cursor.
    let rev = after;
    for (const row of nodes) {
      const value = Number(row.rev) || 0;
      if (value > rev) rev = value;
    }
    for (const row of edges) {
      const value = Number(row.rev) || 0;
      if (value > rev) rev = value;
    }

    return { nodes, edges, cursor: { rev } };
  };

  // A read-only handle cannot BEGIN IMMEDIATE; use a plain deferred read
  // transaction there. Writer handles get the shared helper (and savepoint
  // nesting when called inside another transaction).
  if (db && db.readOnly === true) {
    raw.exec("BEGIN");
    try {
      const result = run();
      raw.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        raw.exec("ROLLBACK");
      } catch (_) {
        // keep the original error
      }
      throw err;
    }
  }

  return withTransaction(raw, run);
}

function stats(db, scanId) {
  const raw = rawOf(db);

  const nodes = Number(
    raw.prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?").get(scanId).c
  );
  const edges = Number(
    raw.prepare("SELECT count(*) AS c FROM edges WHERE scan_id = ?").get(scanId).c
  );

  const byType = {};
  const typeRows = raw
    .prepare(
      "SELECT type, count(*) AS c FROM nodes WHERE scan_id = ? GROUP BY type"
    )
    .all(scanId);
  for (const row of typeRows) {
    byType[row.type] = Number(row.c);
  }

  let pending = 0;
  let inflight = 0;
  let done = 0;
  let err = 0;
  try {
    const row = raw
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN state = 'pending'  THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN state = 'inflight' THEN 1 ELSE 0 END), 0) AS inflight,
           COALESCE(SUM(CASE WHEN state = 'done'     THEN 1 ELSE 0 END), 0) AS done,
           COALESCE(SUM(CASE WHEN state = 'err'      THEN 1 ELSE 0 END), 0) AS err
         FROM queue WHERE scan_id = ?`
      )
      .get(scanId);
    pending = Number(row.pending);
    inflight = Number(row.inflight);
    done = Number(row.done);
    err = Number(row.err);
  } catch (_err) {
    // queue absent on partially migrated databases: report zeroes.
  }

  return { nodes, edges, byType, pending, inflight, done, err };
}

function closeDb(db) {
  if (!db) return;
  if (typeof db.close === "function") {
    db.close();
    return;
  }
  if (db.raw && typeof db.raw.close === "function") {
    db.raw.close();
  }
}

// ---------------------------------------------------------------------------
// CLI: --self-test / --help
// ---------------------------------------------------------------------------

function usage() {
  console.log("Usage: node lib/db.js --self-test");
  console.log("       node lib/db.js --help");
  console.log("");
  console.log("--self-test  run end-to-end SQLite layer self-test (needs lib/migrate.js)");
  console.log("--help       show this help");
}

function selfTest() {
  const results = [];
  const ctx = {};
  let tmpdir = null;
  let db = null;

  const check = (name, fn) => {
    try {
      const detail = fn() || "";
      results.push({ name, ok: true, detail });
      console.log(`PASS ${name}${detail ? ": " + detail : ""}`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      results.push({ name, ok: false, detail: message });
      console.log(`FAIL ${name}: ${message}`);
    }
  };

  check("tmpdir", () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "recon-db-"));
    const dbPath = path.join(tmpdir, "scan.sqlite");
    db = openDb(dbPath);
    assert(
      db.path === path.resolve(dbPath),
      `db.path ${db.path} is not the resolved absolute path`
    );
    return db.path;
  });

  check("schema", () => {
    const raw = rawOf(db);
    const wanted = [
      "scans",
      "nodes",
      "edges",
      "bodies",
      "fts_docs",
      "findings",
      "queue",
      "node_fts",
    ];
    const names = new Set(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        .all()
        .map((row) => row.name)
    );
    const missing = wanted.filter((name) => !names.has(name));
    assert(missing.length === 0, `missing tables: ${missing.join(", ")}`);
    return wanted.join(",");
  });

  check("scan", () => {
    ctx.scanId = createScan(db, { target: "https://t.local/", mode: "active" });
    assert(
      Number.isInteger(ctx.scanId) && ctx.scanId > 0,
      `createScan returned ${ctx.scanId}`
    );
    const scan = getScan(db, ctx.scanId);
    assert(scan !== null, "getScan returned null");
    assert(scan.status === "running", `status=${scan.status}`);
    return `id=${ctx.scanId} status=running`;
  });

  check("nodes=3", () => {
    const a = upsertNode(db, ctx.scanId, {
      key: "GET https://t.local/",
      type: "page",
      origin: "crawl",
    });
    const b = upsertNode(db, ctx.scanId, {
      key: "GET https://t.local/a",
      type: "page",
      origin: "crawl",
    });
    const c = upsertNode(db, ctx.scanId, {
      key: "GET https://t.local/api/x",
      type: "endpoint",
      origin: "crawl",
    });
    assert(a.inserted === true, "A not inserted");
    assert(b.inserted === true, "B not inserted");
    assert(c.inserted === true, "C not inserted");
    ctx.A = a.id;
    ctx.B = b.id;
    ctx.C = c.id;
    const count = Number(
      rawOf(db)
        .prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?")
        .get(ctx.scanId).c
    );
    assert(count === 3, `node count=${count}`);
    return `A=${ctx.A} B=${ctx.B} C=${ctx.C}`;
  });

  check("edges=2", () => {
    const ab = addEdge(db, ctx.scanId, ctx.A, ctx.B, "link");
    const bc = addEdge(db, ctx.scanId, ctx.B, ctx.C, "request");
    assert(ab === true, "addEdge(A,B link) returned false");
    assert(bc === true, "addEdge(B,C request) returned false");
    const duplicate = addEdge(db, ctx.scanId, ctx.A, ctx.B, "link");
    assert(duplicate === false, "duplicate addEdge did not return false");
    const count = Number(
      rawOf(db)
        .prepare("SELECT count(*) AS c FROM edges WHERE scan_id = ?")
        .get(ctx.scanId).c
    );
    assert(count === 2, `edge count=${count}`);
    return "count=2 duplicate=ignored";
  });

  check("degree", () => {
    const raw = rawOf(db);
    const degreeOf = (id) =>
      Number(raw.prepare("SELECT degree FROM nodes WHERE id = ?").get(id).degree);

    assert(degreeOf(ctx.A) === 1, `degree(A)=${degreeOf(ctx.A)}`);
    assert(degreeOf(ctx.B) === 2, `degree(B)=${degreeOf(ctx.B)}`);
    assert(degreeOf(ctx.C) === 1, `degree(C)=${degreeOf(ctx.C)}`);

    // Trigger probe: a raw INSERT/DELETE must move degree without any JS help.
    raw
      .prepare(
        "INSERT INTO edges(scan_id, src, dst, kind, attrs_json) VALUES(?, ?, ?, 'probe', '{}')"
      )
      .run(ctx.scanId, ctx.C, ctx.A);
    assert(degreeOf(ctx.A) === 2, `probe: degree(A)=${degreeOf(ctx.A)}`);
    assert(degreeOf(ctx.C) === 2, `probe: degree(C)=${degreeOf(ctx.C)}`);
    raw
      .prepare("DELETE FROM edges WHERE scan_id = ? AND src = ? AND dst = ? AND kind = 'probe'")
      .run(ctx.scanId, ctx.C, ctx.A);
    assert(degreeOf(ctx.A) === 1, `restore: degree(A)=${degreeOf(ctx.A)}`);
    assert(degreeOf(ctx.C) === 1, `restore: degree(C)=${degreeOf(ctx.C)}`);

    return "degree A=1 B=2 C=1 (shared node B = 2)";
  });

  check("fts", () => {
    const hash = "0123456789abcdef".repeat(4);
    putBody(db, ctx.B, {
      mime: "text/html",
      encoding: "utf8",
      size: 42,
      sha256: hash,
      filePath: `bodies/aa/${hash}`,
      title: "Doc",
      text: "<html>delta-flag-marker ALPHA</html>",
    });
    const hits = search(db, ctx.scanId, "delta");
    assert(hits.length === 1, `hits=${hits.length}`);
    assert(hits[0].nodeId === ctx.B, `nodeId=${hits[0].nodeId}`);
    assert(typeof hits[0].snippet === "string" && hits[0].snippet.length > 0, "empty snippet");
    assert(hits[0].snippet.includes("delta"), `snippet=${hits[0].snippet}`);
    assert(/flag.marker/.test(hits[0].snippet), `snippet=${hits[0].snippet}`);
    assert(search(db, ctx.scanId, "").length === 0, "empty query returned hits");
    return `hits=1 snippet=${JSON.stringify(hits[0].snippet)}`;
  });

  check("upsert-idempotent", () => {
    const raw = rawOf(db);
    const rowA = () => raw.prepare("SELECT * FROM nodes WHERE id = ?").get(ctx.A);
    const revBefore = Number(rowA().rev);

    const same = upsertNode(db, ctx.scanId, {
      key: "GET https://t.local/",
      type: "page",
      origin: "crawl",
    });
    assert(same.inserted === false, "identical upsert reported inserted=true");
    assert(same.id === ctx.A, `identical upsert id=${same.id}`);
    assert(Number(rowA().rev) === revBefore, "identical upsert bumped rev");

    const count = Number(
      raw.prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?").get(ctx.scanId).c
    );
    assert(count === 3, `node count=${count}`);

    const updated = upsertNode(db, ctx.scanId, {
      key: "GET https://t.local/",
      type: "page",
      origin: "crawl",
      status: 200,
    });
    assert(updated.inserted === false, "status upsert reported inserted=true");
    assert(updated.id === ctx.A, `status upsert id=${updated.id}`);
    const revAfter = Number(rowA().rev);
    assert(revAfter > revBefore, `rev did not increase: ${revBefore} -> ${revAfter}`);
    return `id=${updated.id} rev ${revBefore}->${revAfter}`;
  });

  check("rev", () => {
    const raw = rawOf(db);
    const nodes = raw.prepare("SELECT id, rev FROM nodes WHERE scan_id = ?").all(ctx.scanId);
    const edges = raw.prepare("SELECT id, rev FROM edges WHERE scan_id = ?").all(ctx.scanId);
    const badNodes = nodes.filter((row) => !(Number(row.rev) > 0));
    const badEdges = edges.filter((row) => !(Number(row.rev) > 0));
    assert(badNodes.length === 0, `nodes with rev<=0: ${badNodes.length}`);
    assert(badEdges.length === 0, `edges with rev<=0: ${badEdges.length}`);
    const maxNodeRev = Math.max(...nodes.map((row) => Number(row.rev)));
    const maxEdgeRev = Math.max(...edges.map((row) => Number(row.rev)));
    return `maxNodeRev=${maxNodeRev} maxEdgeRev=${maxEdgeRev}`;
  });

  check("delta", () => {
    const first = delta(db, ctx.scanId, 0);
    assert(first.nodes.length === 3, `delta(0).nodes=${first.nodes.length}`);
    assert(first.edges.length === 2, `delta(0).edges=${first.edges.length}`);
    assert(first.cursor.rev > 0, `delta(0).cursor.rev=${first.cursor.rev}`);

    const second = delta(db, ctx.scanId, first.cursor.rev);
    assert(second.nodes.length === 0, `delta(cursor).nodes=${second.nodes.length}`);
    assert(second.edges.length === 0, `delta(cursor).edges=${second.edges.length}`);
    return `nodes=3 edges=2 cursor=${first.cursor.rev} then 0/0`;
  });

  check("edge-delete-degree", () => {
    const raw = rawOf(db);
    raw
      .prepare(
        "DELETE FROM edges WHERE scan_id = ? AND src = ? AND dst = ? AND kind = 'link'"
      )
      .run(ctx.scanId, ctx.A, ctx.B);
    const degreeOf = (id) =>
      Number(raw.prepare("SELECT degree FROM nodes WHERE id = ?").get(id).degree);
    assert(degreeOf(ctx.A) === 0, `degree(A)=${degreeOf(ctx.A)}`);
    assert(degreeOf(ctx.B) === 1, `degree(B)=${degreeOf(ctx.B)}`);
    return `degree A=0 B=1`;
  });

  check("fts-excludes-oversized", () => {
    const raw = rawOf(db);
    const url = "https://t.local/oversized-node";
    const node = upsertNode(db, ctx.scanId, {
      key: "GET " + url,
      type: "page",
      origin: "crawl",
      url,
    });
    ctx.D = node.id;

    const head = "HEADTOKEN" + "h".repeat(91); // 100 bytes
    const tail = "TAILTOKEN" + "t".repeat(41); // 50 bytes
    const middle = 2 * 1024 * 1024 + 200 - head.length - tail.length;
    const text = head + "m".repeat(middle) + tail;
    const bytes = Buffer.byteLength(text, "utf8");
    assert(bytes === 2 * 1024 * 1024 + 200, `body bytes=${bytes}`);

    putBody(db, node.id, {
      mime: "text/plain",
      encoding: "utf8",
      size: bytes,
      sha256: "a".repeat(64),
      filePath: "bodies/oversized",
      title: "Oversized Doc",
      text,
    });

    assert(
      search(db, ctx.scanId, "HEADTOKEN").length === 0,
      "HEADTOKEN from oversized body is searchable"
    );
    assert(
      search(db, ctx.scanId, "TAILTOKEN").length === 0,
      "TAILTOKEN from oversized body is searchable"
    );

    const row = raw
      .prepare("SELECT text, fts_truncated FROM bodies WHERE node_id = ?")
      .get(node.id);
    assert(Number(row.fts_truncated) === 1, `fts_truncated=${row.fts_truncated}`);
    assert(row.text.length === 2 * 1024 * 1024, `bodies.text length=${row.text.length}`);

    const doc = raw.prepare("SELECT body FROM fts_docs WHERE node_id = ?").get(node.id);
    assert(doc !== undefined, "fts_docs row missing");
    assert(doc.body === null, `fts_docs.body length=${doc.body === null ? "null" : doc.body.length}`);
    return "no body tokens indexed, fts_truncated=1, fts body NULL";
  });

  check("fts-url-still-searchable", () => {
    const hits = search(db, ctx.scanId, "oversized");
    assert(hits.length === 1, `hits=${hits.length}`);
    assert(hits[0].nodeId === ctx.D, `nodeId=${hits[0].nodeId}`);
    assert(hits[0].snippet === "", `snippet=${JSON.stringify(hits[0].snippet)}`);
    return `hit node=${hits[0].nodeId} via url/title, snippet=""`;
  });

  check("delta-edge-after-cursor", () => {
    const raw = rawOf(db);
    const cursor = delta(db, ctx.scanId, 0).cursor.rev;

    const inserted = addEdge(db, ctx.scanId, ctx.A, ctx.D, "test-edge");
    assert(inserted === true, "addEdge after cursor returned false");

    const edgeRow = raw
      .prepare(
        "SELECT id, rev FROM edges WHERE scan_id = ? AND src = ? AND dst = ? AND kind = 'test-edge'"
      )
      .get(ctx.scanId, ctx.A, ctx.D);
    assert(edgeRow !== undefined, "inserted edge not found");

    const next = delta(db, ctx.scanId, cursor);
    assert(next.edges.length === 1, `delta(cursor).edges=${next.edges.length}`);
    assert(Number(next.edges[0].id) === Number(edgeRow.id), "wrong edge returned");
    assert(
      Number(next.edges[0].rev) > cursor,
      `edge rev=${next.edges[0].rev} not above cursor=${cursor}`
    );

    // Degree triggers legitimately bump both endpoints above the cursor; no
    // other node may appear.
    for (const row of next.nodes) {
      assert(
        row.id === ctx.A || row.id === ctx.D,
        `unexpected node id=${row.id} in delta`
      );
    }
    return `cursor=${cursor} edgeRev=${next.edges[0].rev} edges=1 nodes=${next.nodes.length}(degree)`;
  });

  check("partial-upsert-preserves", () => {
    const raw = rawOf(db);
    const key = "GET https://t.local/partial";
    const first = upsertNode(db, ctx.scanId, {
      key,
      type: "page",
      origin: "crawl",
      label: "Partial",
      url: "https://t.local/partial",
      status: 204,
      depth: 3,
      attrs: { a: 1, b: { c: 2, d: 3 } },
    });
    const before = raw.prepare("SELECT * FROM nodes WHERE id = ?").get(first.id);

    const again = upsertNode(db, ctx.scanId, { key, type: "page", origin: "crawl" });
    assert(again.inserted === false, "partial upsert reported inserted=true");
    assert(again.id === first.id, `partial upsert id=${again.id}`);

    const after = raw.prepare("SELECT * FROM nodes WHERE id = ?").get(first.id);
    assert(after.label === "Partial", `label=${after.label}`);
    assert(after.url === "https://t.local/partial", `url=${after.url}`);
    assert(Number(after.status) === 204, `status=${after.status}`);
    assert(Number(after.depth) === 3, `depth=${after.depth}`);
    assert(after.attrs_json === before.attrs_json, `attrs=${after.attrs_json}`);
    assert(
      Number(after.rev) === Number(before.rev),
      `rev changed ${before.rev} -> ${after.rev}`
    );
    return `id=${first.id} fields preserved rev=${after.rev}`;
  });

  check("attrs-key-order-noop", () => {
    const raw = rawOf(db);
    const key = "GET https://t.local/attrs-order";
    const first = upsertNode(db, ctx.scanId, {
      key,
      type: "page",
      origin: "crawl",
      attrs: { a: 1, b: 2 },
    });
    const before = raw.prepare("SELECT * FROM nodes WHERE id = ?").get(first.id);
    const countBefore = Number(
      raw.prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?").get(ctx.scanId).c
    );

    const again = upsertNode(db, ctx.scanId, {
      key,
      type: "page",
      origin: "crawl",
      attrs: { b: 2, a: 1 },
    });
    assert(again.inserted === false, "reordered-attrs upsert reported inserted=true");

    const after = raw.prepare("SELECT * FROM nodes WHERE id = ?").get(first.id);
    assert(
      Number(after.rev) === Number(before.rev),
      `key order bumped rev ${before.rev} -> ${after.rev}`
    );
    assert(after.attrs_json === '{"a":1,"b":2}', `attrs_json=${after.attrs_json}`);
    const countAfter = Number(
      raw.prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?").get(ctx.scanId).c
    );
    assert(countAfter === countBefore, `node count ${countBefore} -> ${countAfter}`);
    return `rev=${after.rev} attrs_json=${after.attrs_json}`;
  });

  check("node-delete-clears-fts", () => {
    const raw = rawOf(db);
    const token = "deletetokenunique";
    const node = upsertNode(db, ctx.scanId, {
      key: "GET https://t.local/delete-me",
      type: "page",
      origin: "crawl",
      url: "https://t.local/delete-me",
    });
    putBody(db, node.id, {
      mime: "text/plain",
      encoding: "utf8",
      size: token.length,
      sha256: "b".repeat(64),
      filePath: "bodies/delete-me",
      title: "Delete me",
      text: "body " + token,
    });
    assert(search(db, ctx.scanId, token).length === 1, "token not indexed before delete");

    raw.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);
    assert(search(db, ctx.scanId, token).length === 0, "FTS still returns deleted node");
    const docs = Number(
      raw.prepare("SELECT count(*) AS c FROM fts_docs WHERE node_id = ?").get(node.id).c
    );
    assert(docs === 0, `fts_docs rows after delete=${docs}`);
    return "search=0 fts_docs=0 after node delete";
  });

  check("stats-queue-states", () => {
    const raw = rawOf(db);
    const insert = raw.prepare(
      "INSERT INTO queue(scan_id, url, kind, origin, state) VALUES(?, ?, 'page', 'seed', ?)"
    );
    insert.run(ctx.scanId, "https://t.local/q-pending", "pending");
    insert.run(ctx.scanId, "https://t.local/q-inflight", "inflight");
    insert.run(ctx.scanId, "https://t.local/q-done", "done");
    insert.run(ctx.scanId, "https://t.local/q-err", "err");

    const result = stats(db, ctx.scanId);
    assert(result.pending === 1, `pending=${result.pending}`);
    assert(result.inflight === 1, `inflight=${result.inflight}`);
    assert(result.done === 1, `done=${result.done}`);
    assert(result.err === 1, `err=${result.err}`);
    return "pending=1 inflight=1 done=1 err=1";
  });

  check("open-readonly", () => {
    const roPath = path.join(tmpdir, "readonly.sqlite");
    const writer = openDb(roPath);
    createScan(writer, { target: "https://ro.local/" });
    closeDb(writer);

    const ro = openReadOnly(roPath);
    assert(ro.readOnly === true, "readOnly flag missing");
    const row = ro.raw.prepare("SELECT count(*) AS c FROM scans").get();
    assert(Number(row.c) === 1, `read count=${row.c}`);

    let wrote = false;
    try {
      ro.raw.exec("CREATE TABLE should_fail(x)");
      wrote = true;
    } catch (_err) {
      wrote = false;
    }
    assert(wrote === false, "write through read-only handle succeeded");
    ro.close();

    const missing = path.join(tmpdir, "definitely-missing.sqlite");
    let threw = false;
    try {
      openReadOnly(missing);
    } catch (_err) {
      threw = true;
    }
    assert(threw, "openReadOnly on missing file did not throw");
    assert(!fs.existsSync(missing), "openReadOnly created the missing file");
    return "read ok, write blocked, missing throws";
  });

  check("cleanup", () => {
    if (db) closeDb(db);
    db = null;
    if (tmpdir) {
      fs.rmSync(tmpdir, { recursive: true, force: true });
      assert(!fs.existsSync(tmpdir), `tmpdir still exists: ${tmpdir}`);
    }
    return "closed + tmpdir removed";
  });

  const pass = results.filter((row) => row.ok).length;
  const fail = results.length - pass;
  console.log(`SUMMARY pass=${pass} fail=${fail}`);
  return fail === 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === "--help") {
    usage();
    process.exit(0);
  }

  if (args.length === 1 && args[0] === "--self-test") {
    let ok = false;
    try {
      ok = selfTest();
    } catch (err) {
      console.error(`FATAL ${err && err.stack ? err.stack : err}`);
      ok = false;
    }
    process.exit(ok ? 0 : 1);
  }

  if (args.length === 0) {
    usage();
    process.exit(1);
  }

  console.error(`Unknown arguments: ${args.join(" ")}`);
  usage();
  process.exit(1);
}

module.exports = {
  openDb,
  openReadOnly,
  createScan,
  getScan,
  setScanStatus,
  upsertNode,
  upsertNodes,
  getNodeByKey,
  getNodeById,
  enqueue,
  claimNext,
  setQueueState,
  requeueInflight,
  queueCounts,
  addEdge,
  addEdges,
  putBody,
  search,
  delta,
  stats,
  closeDb,
};
