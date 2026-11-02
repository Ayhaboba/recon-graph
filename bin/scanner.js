#!/usr/bin/env node
"use strict";

/**
 * recon-graph scanner CLI (stage 3, spec §8).
 *
 * The scanner is the only writer of a scan database. It claims queue rows
 * through lib/crawl.js, which owns fetching/parsing, while this file owns:
 *   - CLI parsing and validation;
 *   - scan id / file layout (`<data-dir>/scans/<id>.sqlite`);
 *   - scan lifecycle (running -> done|stopped), including SIGINT/SIGTERM;
 *   - the guarantee that no queue row is left `inflight` after exit.
 */

const fs = require("node:fs");
const path = require("node:path");

const USAGE = [
  "Usage: node bin/scanner.js <target-url> [options]",
  "",
  "Crawl a target and record the live recon graph.",
  "",
  "Options:",
  "  --max-depth <n>         maximum crawl depth (default: 6)",
  "  --concurrency <n>       global concurrent requests (default: 8)",
  "  --per-host <n>          per-host concurrent requests (default: 4)",
  "  --delay <ms>            delay between requests (default: 100)",
  "  --timeout <ms>          request timeout in ms (default: 15000)",
  "  --scope <mode>          same-origin | host | any (default: same-origin)",
  "  --ignore-robots         do not honour robots.txt",
  '  --header "Name: value"  extra request header (repeatable)',
  "  --wordlist <file>       fuzz crawled directories with this wordlist",
  "  --max-body-bytes <n>    response body cap in bytes (default: 10485760)",
  "  --max-redirects <n>     redirect hop limit (default: 10)",
  "  --data-dir <dir>        data directory (default: ./data)",
  "  --resume <scan-id>      resume an existing scan",
  "  -h, --help              show this help",
  "",
  "Examples:",
  "  node bin/scanner.js https://example.test --max-depth 3",
  "  node bin/scanner.js --resume 4",
].join("\n");

const VALUE_OPTIONS = new Set([
  "--max-depth",
  "--concurrency",
  "--per-host",
  "--delay",
  "--timeout",
  "--scope",
  "--header",
  "--wordlist",
  "--max-body-bytes",
  "--max-redirects",
  "--data-dir",
  "--resume",
]);

const SCOPES = new Set(["same-origin", "host", "any"]);

function failure(error) {
  return { ok: false, error: String(error), help: false };
}

function parseInteger(value, name, minimum) {
  const text = String(value);
  if (!/^-?\d+$/.test(text)) {
    return { error: `invalid value for ${name}: "${text}" (expected an integer)` };
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < minimum) {
    return {
      error: `invalid value for ${name}: "${text}" (expected an integer >= ${minimum})`,
    };
  }
  return { value: number };
}

function parseHeader(value) {
  if (typeof value !== "string" || value === "") {
    return { error: "invalid --header value: expected \"Name: value\"" };
  }
  if (/[\r\n]/.test(value)) {
    return { error: "invalid --header value: newlines are not allowed" };
  }
  const colon = value.indexOf(":");
  if (colon <= 0) {
    return { error: `invalid --header value: "${value}" (expected "Name: value")` };
  }
  const name = value.slice(0, colon).trim();
  const headerValue = value.slice(colon + 1).trim();
  if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    return { error: `invalid --header name: "${name}"` };
  }
  return {
    value: {
      name,
      value: headerValue,
      raw: `${name}: ${headerValue}`,
    },
  };
}

/**
 * Parse CLI argv (without node/script). Pure: never writes to stdio, never
 * exits, so tests can exercise it directly.
 */
function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const options = {
    maxDepth: 6,
    concurrency: 8,
    perHost: 4,
    delay: 100,
    timeout: 15000,
    scope: "same-origin",
    ignoreRobots: false,
    headers: [],
    wordlist: null,
    maxBodyBytes: 10 * 1024 * 1024,
    maxRedirects: 10,
    dataDir: "./data",
  };

  // Which crawler-facing options were explicitly present in argv. Resume uses
  // this to decide between stored scan options and CLI overrides.
  const explicit = {
    maxDepth: false,
    concurrency: false,
    perHost: false,
    delay: false,
    timeout: false,
    scope: false,
    ignoreRobots: false,
    headers: false,
    wordlist: false,
    maxBodyBytes: false,
    maxRedirects: false,
  };

  let help = false;
  let target = null;
  let resume = null;

  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    if (arg === "--ignore-robots") {
      options.ignoreRobots = true;
      explicit.ignoreRobots = true;
      continue;
    }

    if (arg.startsWith("--")) {
      let name = arg;
      let inlineValue = null;
      const equals = arg.indexOf("=");
      if (equals !== -1) {
        name = arg.slice(0, equals);
        inlineValue = arg.slice(equals + 1);
      }

      if (!VALUE_OPTIONS.has(name)) {
        return failure(`unknown option: ${name}`);
      }

      let value;
      if (inlineValue !== null) {
        value = inlineValue;
      } else {
        if (index + 1 >= list.length) {
          return failure(`option ${name} requires a value`);
        }
        index += 1;
        value = list[index];
      }

      if (name === "--max-depth") {
        const parsed = parseInteger(value, name, 0);
        if (parsed.error) return failure(parsed.error);
        options.maxDepth = parsed.value;
        explicit.maxDepth = true;
      } else if (name === "--concurrency") {
        const parsed = parseInteger(value, name, 1);
        if (parsed.error) return failure(parsed.error);
        options.concurrency = parsed.value;
        explicit.concurrency = true;
      } else if (name === "--per-host") {
        const parsed = parseInteger(value, name, 1);
        if (parsed.error) return failure(parsed.error);
        options.perHost = parsed.value;
        explicit.perHost = true;
      } else if (name === "--delay") {
        const parsed = parseInteger(value, name, 0);
        if (parsed.error) return failure(parsed.error);
        options.delay = parsed.value;
        explicit.delay = true;
      } else if (name === "--timeout") {
        const parsed = parseInteger(value, name, 1);
        if (parsed.error) return failure(parsed.error);
        options.timeout = parsed.value;
        explicit.timeout = true;
      } else if (name === "--scope") {
        if (!SCOPES.has(value)) {
          return failure(
            `invalid value for --scope: "${value}" (expected same-origin, host or any)`
          );
        }
        options.scope = value;
        explicit.scope = true;
      } else if (name === "--header") {
        const parsed = parseHeader(value);
        if (parsed.error) return failure(parsed.error);
        options.headers.push(parsed.value);
        explicit.headers = true;
      } else if (name === "--wordlist") {
        if (value === "") {
          return failure("option --wordlist requires a non-empty value");
        }
        options.wordlist = value;
        explicit.wordlist = true;
      } else if (name === "--max-body-bytes") {
        const parsed = parseInteger(value, name, 1);
        if (parsed.error) return failure(parsed.error);
        options.maxBodyBytes = parsed.value;
        explicit.maxBodyBytes = true;
      } else if (name === "--max-redirects") {
        const parsed = parseInteger(value, name, 0);
        if (parsed.error) return failure(parsed.error);
        options.maxRedirects = parsed.value;
        explicit.maxRedirects = true;
      } else if (name === "--data-dir") {
        if (value === "") {
          return failure("option --data-dir requires a non-empty value");
        }
        options.dataDir = value;
      } else if (name === "--resume") {
        const parsed = parseInteger(value, name, 1);
        if (parsed.error) return failure(parsed.error);
        resume = parsed.value;
      }

      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      return failure(`unknown option: ${arg}`);
    }

    if (target !== null) {
      return failure(`unexpected argument: ${arg}`);
    }
    target = arg;
  }

  if (!help && target === null && resume === null) {
    return failure("missing target URL");
  }

  return {
    ok: true,
    help,
    target,
    resume,
    options,
    explicit,
  };
}

/** Smallest positive N whose scan database file does not exist yet. */
function pickScanId(scansDir) {
  let id = 1;
  while (fs.existsSync(path.join(scansDir, `${id}.sqlite`))) {
    id += 1;
  }
  return id;
}

function isAbsoluteHttpUrl(value, normalizeUrl) {
  if (typeof value !== "string" || value === "") return false;
  if (!/^https?:\/\//i.test(value)) return false;
  return normalizeUrl(value) !== null;
}

function hasQueueRows(db, scanId, queueCounts) {
  try {
    if (db && db.raw && typeof db.raw.prepare === "function") {
      const row = db.raw
        .prepare("SELECT count(*) AS c FROM queue WHERE scan_id = ?")
        .get(scanId);
      return Number(row.c) > 0;
    }
  } catch (_err) {
    // fall through to the public helper
  }

  try {
    const counts = queueCounts(db, scanId);
    if (Array.isArray(counts)) {
      return counts.reduce((sum, row) => {
        if (row && typeof row === "object") {
          return sum + Number(row.count ?? row.c ?? row.n ?? 0);
        }
        return sum + Number(row || 0);
      }, 0) > 0;
    }
    if (counts && typeof counts === "object") {
      if (Number.isFinite(Number(counts.total))) return Number(counts.total) > 0;
      let seen = false;
      let sum = 0;
      for (const key of ["pending", "inflight", "done", "err", "skip"]) {
        if (counts[key] !== undefined) {
          seen = true;
          sum += Number(counts[key]) || 0;
        }
      }
      if (seen) return sum > 0;
      const numeric = Object.values(counts).filter(
        (value) => typeof value === "number" && Number.isFinite(value)
      );
      if (numeric.length > 0) {
        return numeric.reduce((left, right) => left + right, 0) > 0;
      }
    }
  } catch (_err) {
    // treat as empty
  }

  return false;
}

function countOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function summarize(result, db, scanId, stats) {
  let fallback = { nodes: 0, edges: 0, pending: 0, done: 0, err: 0 };
  try {
    const current = stats(db, scanId);
    fallback = {
      nodes: countOr(current.nodes, 0),
      edges: countOr(current.edges, 0),
      pending: countOr(current.pending, 0),
      done: countOr(current.done, 0),
      err: countOr(current.err, 0),
    };
  } catch (_err) {
    // keep zeroes
  }

  const source = result && typeof result === "object" ? result : {};
  return {
    nodes: countOr(source.nodes, fallback.nodes),
    edges: countOr(source.edges, fallback.edges),
    pending: countOr(source.pending, fallback.pending),
    done: countOr(source.done, fallback.done),
    err: countOr(source.err, fallback.err),
  };
}

function optionsForScan(options, dataDir, resume) {
  return {
    maxDepth: options.maxDepth,
    concurrency: options.concurrency,
    perHost: options.perHost,
    delay: options.delay,
    timeout: options.timeout,
    scope: options.scope,
    ignoreRobots: options.ignoreRobots,
    headers: options.headers.map((header) => header.raw),
    wordlist:
      options.wordlist === null || options.wordlist === undefined
        ? null
        : path.resolve(options.wordlist),
    maxBodyBytes: options.maxBodyBytes,
    maxRedirects: options.maxRedirects,
    dataDir,
    resume: resume === undefined ? null : resume,
  };
}

function optionsForCrawler(options, dataDir) {
  return {
    maxDepth: options.maxDepth,
    concurrency: options.concurrency,
    perHost: options.perHost,
    delay: options.delay,
    timeout: options.timeout,
    scope: options.scope,
    ignoreRobots: options.ignoreRobots,
    headers: options.headers.map((header) => ({
      name: header.name,
      value: header.value,
      raw: header.raw,
    })),
    wordlist:
      options.wordlist === null || options.wordlist === undefined
        ? null
        : path.resolve(options.wordlist),
    maxBodyBytes: options.maxBodyBytes,
    maxRedirects: options.maxRedirects,
    dataDir,
  };
}

/**
 * Build the effective crawler options for `--resume`: the scan's stored
 * options_json is the base, and only flags explicitly present in argv win.
 */
function mergeResumeOptions(storedJson, cliOptions, explicit) {
  const merged = { ...cliOptions };

  let stored = {};
  try {
    const parsedStored = JSON.parse(storedJson || "{}");
    if (parsedStored && typeof parsedStored === "object") stored = parsedStored;
  } catch (_err) {
    // Corrupt/legacy options_json: keep sane CLI defaults.
  }

  const numeric = [
    ["maxDepth", 0],
    ["concurrency", 1],
    ["perHost", 1],
    ["delay", 0],
    ["timeout", 1],
    ["maxBodyBytes", 1],
    ["maxRedirects", 0],
  ];
  for (const [name, minimum] of numeric) {
    if (explicit[name] || stored[name] === undefined || stored[name] === null) {
      continue;
    }
    const number = Number(stored[name]);
    if (Number.isSafeInteger(number) && number >= minimum) {
      merged[name] = number;
    }
  }

  if (!explicit.scope && SCOPES.has(stored.scope)) {
    merged.scope = stored.scope;
  }
  if (!explicit.ignoreRobots && stored.ignoreRobots !== undefined) {
    merged.ignoreRobots = stored.ignoreRobots === true;
  }
  if (
    !explicit.wordlist &&
    typeof stored.wordlist === "string" &&
    stored.wordlist !== ""
  ) {
    merged.wordlist = stored.wordlist;
  }
  if (!explicit.headers && Array.isArray(stored.headers)) {
    const headers = [];
    for (const raw of stored.headers) {
      if (typeof raw !== "string") continue;
      const parsedHeader = parseHeader(raw);
      if (!parsedHeader.error) headers.push(parsedHeader.value);
    }
    merged.headers = headers;
  }

  return merged;
}

/** Directory URL for a crawled node: strip the last path segment, keep `/`. */
function directoryOf(rawUrl) {
  try {
    const url = new URL(rawUrl);
    let pathname = url.pathname || "/";
    if (!pathname.startsWith("/")) pathname = `/${pathname}`;
    const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    const cut = trimmed.lastIndexOf("/");
    const dirPath = cut <= 0 ? "/" : trimmed.slice(0, cut + 1);
    return `${url.origin}${dirPath}`;
  } catch (_err) {
    return null;
  }
}

/** Distinct parent directories of successfully crawled pages/endpoints. */
function collectFuzzDirs(db, scanId, cap = 200) {
  if (!db || !db.raw || typeof db.raw.prepare !== "function") return [];
  let rows = [];
  try {
    rows = db.raw
      .prepare(
        `SELECT url FROM nodes
          WHERE scan_id = ? AND status BETWEEN 200 AND 399
            AND type IN ('page', 'endpoint') AND url IS NOT NULL`
      )
      .all(scanId);
  } catch (_err) {
    return [];
  }

  const dirs = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.url !== "string") continue;
    const dir = directoryOf(row.url);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
    if (dirs.length >= cap) break;
  }
  return dirs;
}

const FUZZ_RETRIES = 10;
const FUZZ_RETRY_DELAY_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** lib/fuzz.js is written by a parallel worker; wait for it up to ~200s. */
async function loadFuzzModule() {
  let lastError = null;
  for (let attempt = 1; attempt <= FUZZ_RETRIES; attempt += 1) {
    try {
      return require("../lib/fuzz");
    } catch (err) {
      const missing =
        err && err.code === "MODULE_NOT_FOUND" && /fuzz/.test(String(err.message));
      if (!missing) throw err;
      lastError = err;
      if (attempt < FUZZ_RETRIES) await sleep(FUZZ_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `lib/fuzz.js unavailable after ${FUZZ_RETRIES} attempts: ${
      lastError && lastError.message ? lastError.message : "unknown error"
    }`
  );
}

async function runFuzz({ db, scanId, target, options }) {
  const fuzzModule = await loadFuzzModule();
  const { createFuzzer, parseWordlist } = fuzzModule || {};
  if (typeof createFuzzer !== "function" || typeof parseWordlist !== "function") {
    throw new Error("lib/fuzz.js must export createFuzzer() and parseWordlist()");
  }

  const wordlistPath = path.resolve(options.wordlist);
  let text;
  try {
    text = fs.readFileSync(wordlistPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read wordlist ${wordlistPath}: ${err.message}`);
  }

  const wordlist = parseWordlist(text);
  if (!Array.isArray(wordlist)) {
    throw new Error("parseWordlist() did not return an array");
  }

  const dirs = collectFuzzDirs(db, scanId);
  const fuzzer = createFuzzer({
    db,
    scanId,
    target,
    options: {
      wordlist,
      dirs,
      concurrency: options.concurrency,
      delay: options.delay,
      timeout: options.timeout,
    },
    request: undefined,
  });
  if (!fuzzer || typeof fuzzer.run !== "function") {
    throw new Error("createFuzzer() returned no fuzzer");
  }

  const result = await fuzzer.run();
  const source = result && typeof result === "object" ? result : {};
  return {
    tested: countOr(source.tested, 0),
    hits: countOr(source.hits, 0),
    softSkips: countOr(source.softSkips, 0),
    errors: countOr(source.errors, 0),
  };
}

function stderr(message) {
  process.stderr.write(`${message}\n`);
}

function stdout(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Run the scanner. Returns the process exit code (0 ok, 2 usage, 1 fatal,
 * 130 stopped by signal). Never calls process.exit itself; the SIGINT
 * handler does, only for the second signal.
 */
async function main(argv) {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    stderr(`[scanner] error: ${parsed.error}`);
    stderr("");
    stderr(USAGE);
    return 2;
  }

  if (parsed.help) {
    stdout(USAGE);
    return 0;
  }

  const norm = require("../lib/norm");
  const normalizeUrl = norm.normalizeUrl;
  const key = norm.key;

  if (parsed.target !== null && !isAbsoluteHttpUrl(parsed.target, normalizeUrl)) {
    stderr(
      `[scanner] error: target must be an absolute http(s) URL: "${parsed.target}"`
    );
    return 2;
  }

  const dataDir = path.resolve(parsed.options.dataDir);
  const scansDir = path.join(dataDir, "scans");

  try {
    fs.mkdirSync(scansDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "bodies"), { recursive: true });
  } catch (err) {
    stderr(`[scanner] error: cannot create data directory: ${err.message}`);
    return 1;
  }

  let scanId;
  let dbPath;
  if (parsed.resume !== null) {
    scanId = parsed.resume;
    dbPath = path.join(scansDir, `${scanId}.sqlite`);
    if (!fs.existsSync(dbPath)) {
      stderr(`[scanner] error: scan ${scanId} not found`);
      return 1;
    }
  } else {
    scanId = pickScanId(scansDir);
    dbPath = path.join(scansDir, `${scanId}.sqlite`);
  }

  const dbModule = require("../lib/db");
  const {
    openDb,
    createScan,
    getScan,
    setScanStatus,
    stats,
    closeDb,
    enqueue,
    requeueInflight,
    queueCounts,
  } = dbModule;

  let db = null;
  let crawler = null;
  let listenersInstalled = false;
  const signalState = { stopped: false };

  const onSignal = () => {
    if (signalState.stopped) {
      // Second signal: do not wait for cleanup.
      process.exit(130);
    }
    signalState.stopped = true;
    if (crawler && typeof crawler.stop === "function") {
      try {
        crawler.stop();
      } catch (_err) {
        // stop is best-effort; the run promise is still awaited below.
      }
    }
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  listenersInstalled = true;

  let target = null;
  let scanOptions = parsed.options;

  try {
    db = openDb(dbPath);
    if (!db || typeof db !== "object") {
      throw new Error("openDb returned no database handle");
    }

    if (parsed.resume !== null) {
      const scan = getScan(db, scanId);
      if (!scan) {
        stderr(`[scanner] error: scan ${scanId} not found`);
        return 1;
      }
      target = String(scan.target);
      if (!isAbsoluteHttpUrl(target, normalizeUrl)) {
        stderr(
          `[scanner] error: scan ${scanId} target is not an absolute http(s) URL: "${target}"`
        );
        return 1;
      }

      scanOptions = mergeResumeOptions(
        scan.options_json,
        parsed.options,
        parsed.explicit
      );
      stdout(
        `[scanner] resume options: depth=${scanOptions.maxDepth} scope=${
          scanOptions.scope
        } wordlist=${scanOptions.wordlist ? scanOptions.wordlist : "none"}`
      );

      setScanStatus(db, scanId, "running");
      requeueInflight(db, scanId);

      if (!hasQueueRows(db, scanId, queueCounts)) {
        enqueue(db, scanId, {
          url: normalizeUrl(target),
          kind: "page",
          depth: 0,
          origin: "crawl",
          priority: 100,
        });
      }
    } else {
      target = normalizeUrl(parsed.target);
      const createdId = createScan(db, {
        id: scanId,
        target,
        mode: "crawl",
        rootKey: key(target),
        options: optionsForScan(scanOptions, dataDir, parsed.resume),
      });

      if (Number.isInteger(createdId) && createdId !== scanId) {
        throw new Error(
          `createScan returned id ${createdId}, expected explicit id ${scanId}`
        );
      }
      if (!getScan(db, scanId)) {
        throw new Error(`createScan did not create scan ${scanId}`);
      }

      enqueue(db, scanId, {
        url: normalizeUrl(target),
        kind: "page",
        depth: 0,
        origin: "crawl",
        priority: 100,
      });
    }

    const crawl = require("../lib/crawl");
    crawler = crawl.createCrawler({
      db,
      scanId,
      target,
      dataDir,
      options: optionsForCrawler(scanOptions, dataDir),
    });
    if (!crawler || typeof crawler.run !== "function") {
      throw new Error("createCrawler returned no crawler");
    }

    if (signalState.stopped) {
      if (typeof crawler.stop === "function") crawler.stop();
    }

    let result = null;
    try {
      result = await crawler.run();
    } finally {
      // Requeue before writing the final status, so stopped stats are honest.
      try {
        requeueInflight(db, scanId);
      } catch (_err) {
        // the outer finally retries; never mask the run result
      }
    }

    const stopped =
      signalState.stopped || (result && result.stopped === true);

    let fuzzStats = null;
    if (!stopped && scanOptions.wordlist) {
      fuzzStats = await runFuzz({
        db,
        scanId,
        target,
        options: scanOptions,
      });
      stdout(
        `[scanner] fuzz: tested=${fuzzStats.tested} hits=${fuzzStats.hits} soft=${fuzzStats.softSkips} err=${fuzzStats.errors}`
      );
    }

    if (stopped || signalState.stopped) {
      let finalStats = {
        nodes: 0,
        edges: 0,
        pending: 0,
        done: 0,
        err: 0,
      };
      try {
        finalStats = summarize(result, db, scanId, stats);
      } catch (_err) {
        // keep zeroes
      }
      setScanStatus(db, scanId, "stopped", {
        stats: finalStats,
        finishedAt: Date.now(),
      });
      stdout("[scanner] stopped: inflight requeued");
      return 130;
    }

    const finalStats = summarize(result, db, scanId, stats);
    if (fuzzStats) finalStats.fuzz = fuzzStats;
    setScanStatus(db, scanId, "done", {
      stats: finalStats,
      finishedAt: Date.now(),
    });

    stdout(
      `[scanner] scan ${scanId} complete: nodes=${finalStats.nodes} edges=${finalStats.edges} done=${finalStats.done} err=${finalStats.err} pending=${finalStats.pending}`
    );
    stdout(`[scanner] db: ${db.path || path.resolve(dbPath)}`);
    return 0;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    stderr(`[scanner] error: ${message}`);
    if (db && scanId !== undefined) {
      try {
        const failedStats = summarize(null, db, scanId, stats);
        setScanStatus(db, scanId, "err", {
          stats: failedStats,
          finishedAt: Date.now(),
        });
      } catch (_statusErr) {
        // status is best-effort on fatal errors
      }
    }
    return 1;
  } finally {
    if (db) {
      try {
        requeueInflight(db, scanId);
      } catch (_err) {
        // best effort: never leave inflight rows behind
      }
      try {
        closeDb(db);
      } catch (_err) {
        // already closed
      }
    }
    if (listenersInstalled) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = Number.isInteger(code) ? code : 1;
    })
    .catch((err) => {
      const message = err && err.stack ? err.stack : String(err);
      stderr(`[scanner] fatal: ${message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  parseArgs,
  main,
  usage: USAGE,
  pickScanId,
  isAbsoluteHttpUrl,
  mergeResumeOptions,
  collectFuzzDirs,
  directoryOf,
};
