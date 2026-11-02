"use strict";

/**
 * Stage 8 server-side search over a scan database (spec §6, §8, §9 row 8).
 *
 * Two modes:
 *  - "fts"   — FTS5 MATCH through lib/db.js search() with a LIMIT of maxIds+1.
 *              The true total comes from a separate SELECT count(*) FTS query
 *              (countFts), so millions of hits are never materialised.
 *  - "regex" — a JS regex (case-insensitive) over bodies.text, falling back to
 *              url/title when a node has no body text. The scan runs in batches
 *              (200 nodes), yields to the event loop with setImmediate between
 *              batches, and enforces a 2000 ms wall-clock budget. Catastrophic
 *              patterns are rejected by a ReDoS heuristic before compiling.
 *
 * Failure shapes: { error: "bad-regex" | "regex-unsafe" | "regex-timeout" ... }.
 * The regex path is async; fts stays synchronous.
 */

const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");

const DEFAULT_MAX_IDS = 200000;
const DEFAULT_CHUNK_SIZE = 5000;
const MAX_PATTERN_LENGTH = 200;
const MAX_REGEX_NODES = 20000;
const MAX_REGEX_BYTES = 200 * 1024 * 1024;
const REGEX_BATCH_NODES = 200;
const REGEX_YIELD_BYTES = 4 * 1024 * 1024;
const REGEX_BUDGET_MS = 2000;
const REGEX_TIMEOUT_MS = 2000;
const REGEX_CHUNK_NODES = 500;
const REGEX_CHUNK_BYTES = 2 * 1024 * 1024;
const REGEX_WORKER_PATH = path.join(__dirname, "regex-worker.js");

let workerThreads = null;
try {
  workerThreads = require("node:worker_threads");
} catch (_err) {
  workerThreads = null;
}

function rawOf(dbHandle) {
  return dbHandle && dbHandle.raw ? dbHandle.raw : dbHandle;
}

function positiveInt(value, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function dedupeSorted(ids) {
  const unique = Array.from(new Set(ids));
  unique.sort((left, right) => left - right);
  return unique;
}

/**
 * Mirror of buildFtsQuery in lib/db.js (not exported there). Kept in sync so
 * countFts counts exactly what db.search matches.
 */
function buildFtsMatch(query) {
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

/**
 * True FTS hit count without materialising rows.
 * Malformed FTS expressions count as zero hits (same contract as db.search).
 */
function countFts(dbHandle, scanId, q) {
  const raw = rawOf(dbHandle);
  const match = buildFtsMatch(q);
  if (!match) return 0;
  try {
    const row = raw
      .prepare(
        `SELECT count(*) AS c FROM node_fts ` +
          `JOIN fts_docs AS d ON node_fts.rowid = d.node_id ` +
          `WHERE node_fts MATCH ? AND d.scan_id = ?`
      )
      .get(match, scanId);
    return Number(row && row.c) || 0;
  } catch (err) {
    const message = String((err && err.message) || err);
    if (/fts5|syntax|malformed|unterminated/i.test(message)) return 0;
    throw err;
  }
}

function ftsSearch(dbHandle, scanId, q, maxIds) {
  // Bound the row materialisation at maxIds+1; the true total is countFts.
  const hits = db.search(dbHandle, scanId, q, { limit: maxIds + 1 });
  const ids = dedupeSorted(
    hits
      .map((hit) => Number(hit.nodeId))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
  );

  const count = countFts(dbHandle, scanId, q);
  const truncated = count > maxIds || ids.length > maxIds;
  return {
    count,
    ids: truncated ? ids.slice(0, maxIds) : ids,
    truncated,
    mode: "fts",
  };
}

function bodyOf(row) {
  const text = row.text;
  if (text !== null && text !== undefined) return String(text);
  // Text-less bodies: fall back to url + title (spec §8).
  const url = row.url === null || row.url === undefined ? "" : String(row.url);
  const title =
    row.title === null || row.title === undefined ? "" : String(row.title);
  if (!url && !title) return null;
  return url + "\n" + title;
}

/**
 * ReDoS heuristic. Flags a quantified group whose body contains another
 * quantifier, another quantified group, or alternation combined with `+`.
 * Handles one level of nesting explicitly (`((a+))+`).
 */
function isUnsafeRegex(pattern) {
  const hasQuantifier = /[+*]|\{\d+(?:,\d*)?\}/;
  const stack = [];

  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === "\\") {
      index += 1;
      if (stack.length) stack[stack.length - 1].body += ch + (pattern[index] || "");
      continue;
    }
    if (ch === "(") {
      stack.push({ body: "", alt: false, plus: false });
      continue;
    }
    if (ch === ")") {
      const group = stack.pop();
      const next = pattern[index + 1];
      const quantified = next === "*" || next === "+" || next === "{";
      if (
        group &&
        quantified &&
        (hasQuantifier.test(group.body) || (group.alt && group.plus))
      ) {
        return true;
      }
      if (stack.length && group) {
        const parent = stack[stack.length - 1];
        parent.body += group.body;
        parent.alt = parent.alt || group.alt;
        parent.plus = parent.plus || group.plus;
      }
      continue;
    }
    if (!stack.length) continue;
    const top = stack[stack.length - 1];
    top.body += ch;
    if (ch === "|") top.alt = true;
    if (ch === "+") top.plus = true;
  }

  return false;
}

function workerAvailable() {
  return Boolean(
    workerThreads &&
      typeof workerThreads.Worker === "function" &&
      fs.existsSync(REGEX_WORKER_PATH)
  );
}

/**
 * Waits for one worker reply, bounded by timeoutMs. A timeout resolves with
 * { timedOut: true } instead of rejecting so the caller can terminate and
 * return a partial result. Worker failure/exit rejects.
 */
function waitForWorkerMessage(worker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (timer) clearTimeout(timer);
    };
    const onMessage = (message) => {
      cleanup();
      resolve({ timedOut: false, message });
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`regex worker exited (${code})`));
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    timer = setTimeout(() => {
      cleanup();
      resolve({ timedOut: true, message: null });
    }, Math.max(0, timeoutMs));
  });
}

/**
 * Runs the whole scan in a worker thread. The main thread only feeds bounded
 * chunks (REGEX_CHUNK_NODES / REGEX_CHUNK_BYTES) and never executes the
 * pattern itself, so a catastrophic regex cannot block the event loop. On
 * budget exhaustion the worker is terminated and a partial timeout result is
 * returned. The worker is always terminated in `finally`.
 */
async function regexSearchInWorker(raw, scanId, pattern, opts) {
  const batchSize = Math.min(
    positiveInt(opts && opts.batchSize, REGEX_CHUNK_NODES),
    REGEX_CHUNK_NODES
  );
  const maxIds = positiveInt(opts && opts.maxIds, DEFAULT_MAX_IDS);
  const timeoutMs = positiveInt(
    opts && opts.regexTimeoutMs,
    positiveInt(opts && opts.budgetMs, REGEX_TIMEOUT_MS)
  );
  const startedAt = Date.now();
  const remaining = () => timeoutMs - (Date.now() - startedAt);
  const timeoutResult = (scanned) => ({
    error: "regex-timeout",
    partial: true,
    scanned,
    mode: "regex",
  });

  const pageStmt = raw.prepare(
    `SELECT n.id AS id, n.url AS url, b.title AS title, b.text AS text
       FROM nodes AS n
       LEFT JOIN bodies AS b ON b.node_id = n.id
      WHERE n.scan_id = ? AND n.id > ?
      ORDER BY n.id
      LIMIT ?`
  );
  const totalRow = raw
    .prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?")
    .get(scanId);
  const totalNodes = Number(totalRow && totalRow.c) || 0;

  const worker = new workerThreads.Worker(REGEX_WORKER_PATH);
  // Persistent swallowers: a later terminate() must never surface as an
  // unhandled 'error'/'exit' event.
  worker.on("error", () => {});
  worker.on("exit", () => {});

  const ids = [];
  let count = 0;
  let scanned = 0;
  let bytes = 0;
  let cursor = 0;
  let capped = false;

  try {
    worker.postMessage({ type: "init", pattern, flags: "i" });
    const ready = await waitForWorkerMessage(worker, remaining());
    if (ready.timedOut) return timeoutResult(scanned);
    if (!ready.message || ready.message.type === "error") {
      return {
        error: "bad-regex",
        message:
          (ready.message && ready.message.message) || "invalid regex",
      };
    }
    if (ready.message.type !== "ready") {
      return { error: "search-failed", message: "unexpected regex worker reply" };
    }

    while (true) {
      if (remaining() <= 0) return timeoutResult(scanned);
      if (scanned >= MAX_REGEX_NODES || bytes >= MAX_REGEX_BYTES) {
        capped = true;
        break;
      }

      const rows = pageStmt.all(scanId, cursor, batchSize);
      if (rows.length === 0) break;

      let chunkItems = [];
      let chunkBytes = 0;

      const flush = async () => {
        if (chunkItems.length === 0) return null;
        const items = chunkItems;
        chunkItems = [];
        chunkBytes = 0;
        worker.postMessage({ type: "chunk", items });
        const answer = await waitForWorkerMessage(worker, remaining());
        if (answer.timedOut) return timeoutResult(scanned);
        if (!answer.message || answer.message.type !== "matches") {
          return { error: "search-failed", message: "regex worker chunk failed" };
        }
        const matches = Array.isArray(answer.message.ids) ? answer.message.ids : [];
        for (const matched of matches) {
          const id = Number(matched);
          if (!Number.isSafeInteger(id) || id <= 0) continue;
          count += 1;
          if (ids.length < maxIds) ids.push(id);
        }
        return null;
      };

      for (const row of rows) {
        cursor = Number(row.id);
        scanned += 1;

        const body = bodyOf(row);
        if (body !== null) {
          const size = Buffer.byteLength(body, "utf8");
          if (bytes + size > MAX_REGEX_BYTES) {
            capped = true;
            break;
          }
          if (
            chunkItems.length > 0 &&
            (chunkItems.length >= REGEX_CHUNK_NODES ||
              chunkBytes + size > REGEX_CHUNK_BYTES)
          ) {
            const failure = await flush();
            if (failure) return failure;
          }
          bytes += size;
          chunkBytes += size;
          chunkItems.push({ id: cursor, text: body });
        }

        if (scanned >= MAX_REGEX_NODES || bytes >= MAX_REGEX_BYTES) {
          capped = true;
          break;
        }
      }

      const failure = await flush();
      if (failure) return failure;

      if (capped) break;
      if (rows.length < batchSize) break;
      // Let the 250 ms poller and other sockets run between DB pages.
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    // Idle/dying worker must not keep the process alive, and must not leak.
    try {
      worker.unref();
    } catch (_unrefErr) {
      // best effort
    }
    try {
      await worker.terminate();
    } catch (_termErr) {
      // best effort
    }
  }

  const truncated =
    capped || count > maxIds || ids.length < count || scanned < totalNodes;
  return {
    count,
    ids,
    truncated,
    mode: "regex",
  };
}

/**
 * Fallback only used when node:worker_threads is unavailable. Same batched
 * scan + wall-clock budget as before; catastrophic patterns are still caught
 * by isUnsafeRegex, but this path cannot contain a heuristic miss.
 */
async function regexSearchInProcess(raw, scanId, re, opts) {
  const batchSize = positiveInt(opts && opts.batchSize, REGEX_BATCH_NODES);
  const maxIds = positiveInt(opts && opts.maxIds, DEFAULT_MAX_IDS);
  const timeoutMs = positiveInt(
    opts && opts.regexTimeoutMs,
    positiveInt(opts && opts.budgetMs, REGEX_TIMEOUT_MS)
  );
  const startedAt = Date.now();

  const pageStmt = raw.prepare(
    `SELECT n.id AS id, n.url AS url, b.title AS title, b.text AS text
       FROM nodes AS n
       LEFT JOIN bodies AS b ON b.node_id = n.id
      WHERE n.scan_id = ? AND n.id > ?
      ORDER BY n.id
      LIMIT ?`
  );
  const totalRow = raw
    .prepare("SELECT count(*) AS c FROM nodes WHERE scan_id = ?")
    .get(scanId);
  const totalNodes = Number(totalRow && totalRow.c) || 0;

  const ids = [];
  let count = 0;
  let scanned = 0;
  let bytes = 0;
  let cursor = 0;
  let capped = false;
  let yieldedAtBytes = 0;

  const timedOut = () => Date.now() - startedAt > timeoutMs;

  while (true) {
    if (timedOut()) {
      return { error: "regex-timeout", partial: true, scanned, mode: "regex" };
    }
    if (scanned >= MAX_REGEX_NODES || bytes >= MAX_REGEX_BYTES) {
      capped = true;
      break;
    }

    const rows = pageStmt.all(scanId, cursor, batchSize);
    if (rows.length === 0) break;

    for (const row of rows) {
      cursor = Number(row.id);
      scanned += 1;

      const body = bodyOf(row);
      if (body !== null) {
        bytes += Buffer.byteLength(body, "utf8");
        if (re.test(body)) {
          count += 1;
          if (ids.length < maxIds) ids.push(cursor);
        }
      }

      if (scanned >= MAX_REGEX_NODES || bytes >= MAX_REGEX_BYTES) {
        capped = true;
        break;
      }
      if (bytes - yieldedAtBytes >= REGEX_YIELD_BYTES) {
        yieldedAtBytes = bytes;
        await new Promise((resolve) => setImmediate(resolve));
      }
      if ((scanned & 63) === 0 && timedOut()) {
        return { error: "regex-timeout", partial: true, scanned, mode: "regex" };
      }
    }

    if (capped) break;
    if (rows.length < batchSize) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const truncated =
    capped || count > maxIds || ids.length < count || scanned < totalNodes;
  return { count, ids, truncated, mode: "regex" };
}

async function regexSearch(dbHandle, scanId, q, opts) {
  const pattern = String(q);

  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      error: "bad-regex",
      message: `pattern exceeds ${MAX_PATTERN_LENGTH} characters`,
    };
  }

  // Cheap fast path: known-bad shapes never reach a thread at all.
  if (isUnsafeRegex(pattern)) {
    return {
      error: "regex-unsafe",
      message: "pattern rejected by ReDoS heuristic",
    };
  }

  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    return {
      error: "bad-regex",
      message: err && err.message ? String(err.message) : "invalid regex",
    };
  }

  const raw = rawOf(dbHandle);
  if (workerAvailable()) {
    return regexSearchInWorker(raw, scanId, pattern, opts);
  }
  return regexSearchInProcess(raw, scanId, re, opts);
}

/**
 * searchScan({ dbHandle, scanId, q, mode, opts }) ->
 *   { count, ids, truncated, mode } | { error, message? } | Promise of either.
 * Regex mode is async (batched scan with a wall-clock budget).
 */
function searchScan(input) {
  try {
    const args = input || {};
    const scanId = Number(args.scanId);
    if (!Number.isSafeInteger(scanId) || scanId <= 0) {
      return { error: "no-scan" };
    }
    if (!args.dbHandle) return { error: "no-db" };

    const q = args.q === undefined || args.q === null ? "" : String(args.q);
    const mode = args.mode === "regex" ? "regex" : "fts";
    const opts = args.opts || {};

    if (q === "" || (mode === "fts" && q.trim() === "")) {
      return { count: 0, ids: [], truncated: false, mode };
    }

    const maxIds = positiveInt(opts.maxIds, DEFAULT_MAX_IDS);

    if (mode === "regex") {
      return regexSearch(args.dbHandle, scanId, q, {
        batchSize: opts.batchSize,
        maxIds,
        budgetMs: opts.budgetMs,
        regexTimeoutMs: opts.regexTimeoutMs,
      }).catch((err) => ({
        error: "search-failed",
        message: err && err.message ? String(err.message) : String(err),
      }));
    }

    return ftsSearch(args.dbHandle, scanId, q, maxIds);
  } catch (err) {
    return {
      error: "search-failed",
      message: err && err.message ? String(err.message) : String(err),
    };
  }
}

module.exports = {
  searchScan,
  countFts,
  MAX_PATTERN_LENGTH,
  MAX_REGEX_NODES,
  MAX_REGEX_BYTES,
  DEFAULT_MAX_IDS,
  DEFAULT_CHUNK_SIZE,
  REGEX_BATCH_NODES,
  REGEX_YIELD_BYTES,
  REGEX_BUDGET_MS,
  REGEX_TIMEOUT_MS,
  REGEX_CHUNK_NODES,
  REGEX_CHUNK_BYTES,
};
