"use strict";

// Schema migrations for a single recon scan database (spec §5).
// Dependency-free: pure SQL + plain JS. The caller owns the connection.

const PRAGMAS = [
  "PRAGMA journal_mode=WAL",
  "PRAGMA synchronous=NORMAL",
  "PRAGMA busy_timeout=5000",
  "PRAGMA foreign_keys=ON",
];

const SCHEMA_VERSION = 1;

// Transaction depth per handle. A WeakMap keeps this working even if the
// native handle rejects arbitrary properties; db.__txDepth is mirrored for
// observability. A transaction opened outside this helper is detected via
// `db.isTransaction` and treated as depth 1.
const txDepths = new WeakMap();

function readDepth(db) {
  const known = txDepths.get(db);
  if (typeof known === "number" && known > 0) return known;
  if (typeof db.__txDepth === "number" && db.__txDepth > 0) return db.__txDepth;
  if (typeof db.isTransaction === "boolean" && db.isTransaction) return 1;
  return 0;
}

function writeDepth(db, depth) {
  if (depth > 0) txDepths.set(db, depth);
  else txDepths.delete(db);
  try {
    db.__txDepth = depth;
  } catch (_) {
    // non-extensible handle: WeakMap remains the source of truth
  }
}

// Runs fn inside a transaction unless one is already open.
// - depth 0: BEGIN IMMEDIATE / COMMIT / ROLLBACK on throw
// - depth N: SAVEPOINT sp_N / RELEASE / ROLLBACK TO + RELEASE on throw
// Never leaves a dangling BEGIN (including when COMMIT itself fails).
// Returns fn()'s result. Synchronous by design (node:sqlite is sync).
function withTransaction(db, fn) {
  const depth = readDepth(db);

  if (depth === 0) {
    db.exec("BEGIN IMMEDIATE");
    writeDepth(db, 1);
    let result;
    try {
      result = fn();
    } catch (err) {
      writeDepth(db, 0);
      try {
        db.exec("ROLLBACK");
      } catch (_) {
        // rollback failure must not mask the original error
      }
      throw err;
    }
    try {
      db.exec("COMMIT");
    } catch (err) {
      writeDepth(db, 0);
      try {
        db.exec("ROLLBACK");
      } catch (_) {
        // keep the COMMIT error
      }
      throw err;
    }
    writeDepth(db, 0);
    return result;
  }

  const sp = "sp_" + depth;
  db.exec("SAVEPOINT " + sp);
  writeDepth(db, depth + 1);
  let result;
  try {
    result = fn();
  } catch (err) {
    try {
      db.exec("ROLLBACK TO " + sp);
      db.exec("RELEASE " + sp);
    } catch (_) {
      // keep the original error
    }
    writeDepth(db, depth);
    throw err;
  }
  db.exec("RELEASE " + sp);
  writeDepth(db, depth);
  return result;
}

const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS rev_seq (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO rev_seq (id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY,
  target       TEXT NOT NULL,
  mode         TEXT NOT NULL,
  root_key     TEXT,
  status       TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  stats_json   TEXT NOT NULL DEFAULT '{}',
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE TABLE IF NOT EXISTS nodes (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  type       TEXT NOT NULL,
  label      TEXT,
  url        TEXT,
  method     TEXT,
  status     INTEGER,
  depth      INTEGER,
  origin     TEXT NOT NULL,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  degree     INTEGER NOT NULL DEFAULT 0,
  rev        INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  UNIQUE(scan_id, key)
);
CREATE INDEX IF NOT EXISTS nodes_scan_type   ON nodes(scan_id, type);
CREATE INDEX IF NOT EXISTS nodes_scan_status ON nodes(scan_id, status);
CREATE INDEX IF NOT EXISTS nodes_scan_rev    ON nodes(scan_id, rev);

CREATE TABLE IF NOT EXISTS edges (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  src        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst        INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  attrs_json TEXT NOT NULL DEFAULT '{}',
  rev        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(scan_id, src, dst, kind)
);
CREATE INDEX IF NOT EXISTS edges_scan_src ON edges(scan_id, src);
CREATE INDEX IF NOT EXISTS edges_scan_dst ON edges(scan_id, dst);
CREATE INDEX IF NOT EXISTS edges_scan_rev ON edges(scan_id, rev);

CREATE TABLE IF NOT EXISTS bodies (
  node_id       INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  mime          TEXT,
  encoding      TEXT,
  size          INTEGER,
  sha256        TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  title         TEXT,
  text          TEXT,
  fts_truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bodies_sha ON bodies(sha256);

CREATE TABLE IF NOT EXISTS fts_docs (
  node_id INTEGER PRIMARY KEY,
  scan_id INTEGER NOT NULL,
  url     TEXT,
  title   TEXT,
  body    TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  url, title, body,
  content='fts_docs', content_rowid='node_id',
  tokenize='unicode61 remove_diacritics 2', prefix='2 3'
);

CREATE TABLE IF NOT EXISTS findings (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  node_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  snippet    TEXT NOT NULL,
  offset     INTEGER,
  attrs_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS findings_scan_rule ON findings(scan_id, rule);

CREATE TABLE IF NOT EXISTS queue (
  id         INTEGER PRIMARY KEY,
  scan_id    INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  depth      INTEGER NOT NULL DEFAULT 0,
  origin     TEXT NOT NULL,
  state      TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE(scan_id, url, kind)
);
CREATE INDEX IF NOT EXISTS queue_state ON queue(scan_id, state, priority DESC);
`;

const CORE_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS nodes_rev_insert
AFTER INSERT ON nodes
BEGIN
  UPDATE rev_seq SET value = value + 1 WHERE id = 1;
  UPDATE nodes SET rev = (SELECT value FROM rev_seq WHERE id = 1) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS nodes_rev_update
AFTER UPDATE OF type, status, degree, attrs_json ON nodes
BEGIN
  UPDATE rev_seq SET value = value + 1 WHERE id = 1;
  UPDATE nodes SET rev = (SELECT value FROM rev_seq WHERE id = 1) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS edges_rev_insert
AFTER INSERT ON edges
BEGIN
  UPDATE rev_seq SET value = value + 1 WHERE id = 1;
  UPDATE edges SET rev = (SELECT value FROM rev_seq WHERE id = 1) WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS edges_degree_insert
AFTER INSERT ON edges
BEGIN
  UPDATE nodes SET degree = degree + 1 WHERE id = NEW.src;
  UPDATE nodes SET degree = degree + 1 WHERE id = NEW.dst;
END;

CREATE TRIGGER IF NOT EXISTS edges_degree_delete
AFTER DELETE ON edges
BEGIN
  UPDATE nodes SET degree = degree - 1 WHERE id = OLD.src;
  UPDATE nodes SET degree = degree - 1 WHERE id = OLD.dst;
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad
AFTER DELETE ON nodes
BEGIN
  DELETE FROM fts_docs WHERE node_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS fts_docs_ai
AFTER INSERT ON fts_docs
BEGIN
  INSERT INTO node_fts(rowid, url, title, body) VALUES (NEW.node_id, NEW.url, NEW.title, NEW.body);
END;

CREATE TRIGGER IF NOT EXISTS fts_docs_ad
AFTER DELETE ON fts_docs
BEGIN
  INSERT INTO node_fts(node_fts, rowid, url, title, body) VALUES ('delete', OLD.node_id, OLD.url, OLD.title, OLD.body);
END;

CREATE TRIGGER IF NOT EXISTS fts_docs_au
AFTER UPDATE ON fts_docs
BEGIN
  INSERT INTO node_fts(node_fts, rowid, url, title, body) VALUES ('delete', OLD.node_id, OLD.url, OLD.title, OLD.body);
  INSERT INTO node_fts(rowid, url, title, body) VALUES (NEW.node_id, NEW.url, NEW.title, NEW.body);
END;
`;

const MIGRATIONS = [
  {
    version: 1,
    name: "core-schema",
    up(db) {
      withTransaction(db, () => {
        db.exec(CORE_SCHEMA);
        db.exec(CORE_TRIGGERS);
      });
    },
  },
];

function readUserVersion(db) {
  const row = db.prepare("PRAGMA user_version").get();
  if (!row) return 0;
  const raw = row.user_version !== undefined ? row.user_version : row["user_version"];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function applyMigrations(db) {
  const from = readUserVersion(db);

  if (from > SCHEMA_VERSION) {
    throw new Error(
      "schema version " + from + " is newer than supported " + SCHEMA_VERSION
    );
  }

  const applied = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;

    // Joins an already-open transaction via savepoint; user_version is set
    // inside the same transaction so DDL and version cannot drift apart.
    withTransaction(db, () => {
      migration.up(db);
      // Integer is validated by construction (literal in MIGRATIONS).
      db.exec("PRAGMA user_version = " + migration.version);
    });
    applied.push(migration.version);
  }

  return { from, to: readUserVersion(db), applied };
}

module.exports = { PRAGMAS, MIGRATIONS, SCHEMA_VERSION, applyMigrations, withTransaction };
