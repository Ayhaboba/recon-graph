"use strict";

/**
 * Dictionary fuzzer with soft-404 detection (spec §8, stage 4).
 *
 * For every directory (`http://h/`, `http://h/api/`, ...) and every wordlist
 * entry the fuzzer requests `dir + encodeURI(word)` and turns non-soft hits
 * into graph nodes with `origin=fuzz` plus a `fuzzed` edge from the directory
 * node. Unknown paths that mirror the reference soft-404 page are skipped.
 *
 * Zero dependencies beyond Node builtins. Fetching is plain node:http /
 * node:https GET with no redirect following: a 3xx status is itself a hit.
 */

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");

const { upsertNode, getNodeByKey, addEdge } = require("./db");
const { key, normalizeUrl, originOf } = require("./norm");

const HIT_STATUSES = new Set([200, 204, 301, 302, 307, 401, 403]);
const MISS_STATUSES = new Set([404, 410]);

const MAX_BODY_BYTES = 1024 * 1024;

const ASSET_EXTENSIONS = new Set([
  "7z", "avi", "bmp", "bz2", "css", "csv", "doc", "docx", "eot", "gif",
  "gz", "ico", "jpeg", "jpg", "js", "json", "map", "mjs", "mov", "mp3",
  "mp4", "ogg", "otf", "pdf", "png", "rar", "svg", "tar", "tgz", "ttf",
  "txt", "wav", "webm", "webp", "woff", "woff2", "xls", "xlsx", "xml",
  "zip",
]);

const DEFAULTS = {
  concurrency: 4,
  delay: 100,
  timeout: 10000,
  userAgent: "recon-graph/1.0",
  soft404Tolerance: 0.05,
  maxPaths: 5000,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const rounded = Math.floor(number);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function clampFloat(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number < min) return min;
  if (number > max) return max;
  return number;
}

function sha256Of(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null || value === undefined ? null : String(value);
  }
  const wanted = String(name).toLowerCase();
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === wanted) {
      const value = headers[candidate];
      return value === null || value === undefined ? null : String(value);
    }
  }
  return null;
}

// Uniform view of a response, whether it came from the local GET or from an
// injected test request. Never throws.
function normalizeResponse(response) {
  if (!response || typeof response !== "object") {
    throw new TypeError("fuzz request returned no response");
  }

  let body = response.body;
  if (body === undefined || body === null) body = Buffer.alloc(0);
  else if (!Buffer.isBuffer(body)) body = Buffer.from(body);

  const size =
    response.size === undefined || response.size === null
      ? body.length
      : Number(response.size);

  const digest =
    typeof response.sha256 === "string" && response.sha256
      ? response.sha256
      : sha256Of(body);

  return {
    status: Number(response.status),
    headers: response.headers || {},
    body,
    sha256: digest,
    size: Number.isFinite(size) ? size : body.length,
  };
}

// ---------------------------------------------------------------------------
// Wordlist
// ---------------------------------------------------------------------------

function parseWordlist(text) {
  const lines = Array.isArray(text)
    ? text.map((line) => String(line))
    : String(text === undefined || text === null ? "" : text).split(/\r?\n/);

  const seen = new Set();
  const words = [];
  for (const line of lines) {
    const word = line.trim();
    if (!word) continue;
    if (word.startsWith("#")) continue;
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  return words;
}

// ---------------------------------------------------------------------------
// HTTP GET (minimal, buffers capped at 1 MiB, no redirects)
// ---------------------------------------------------------------------------

function makeRequest(options) {
  const userAgent = options.userAgent;
  const timeout = options.timeout;

  return function request(url) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (err) {
        reject(err);
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        reject(new Error(`unsupported protocol: ${parsed.protocol}`));
        return;
      }

      const module = parsed.protocol === "https:" ? https : http;
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };

      const req = module.get(
        parsed,
        {
          headers: {
            "User-Agent": userAgent,
            Accept: "*/*",
            Connection: "close",
          },
        },
        (res) => {
          const chunks = [];
          let received = 0;
          let truncated = false;

          res.on("data", (chunk) => {
            if (received >= MAX_BODY_BYTES) {
              truncated = true;
              res.destroy();
              return;
            }
            const remaining = MAX_BODY_BYTES - received;
            if (chunk.length > remaining) {
              chunks.push(chunk.subarray(0, remaining));
              received += remaining;
              truncated = true;
              res.destroy();
            } else {
              chunks.push(chunk);
              received += chunk.length;
            }
          });

          const deliver = () => {
            const body = Buffer.concat(chunks);
            finish({
              status: res.statusCode,
              headers: res.headers,
              body,
              sha256: sha256Of(body),
              size: body.length,
              truncated,
            });
          };

          res.on("end", deliver);
          res.on("close", deliver);
          res.on("error", (err) => finish(null, err));
        }
      );

      req.setTimeout(timeout, () => {
        req.destroy(new Error(`request timed out after ${timeout}ms`));
      });
      req.on("error", (err) => finish(null, err));
    });
  };
}

// ---------------------------------------------------------------------------
// Soft-404 probe
// ---------------------------------------------------------------------------

/**
 * probeSoft404({ request, baseUrl|target, options, wordlist })
 *   -> Promise<{ sha256, size, status } | null>
 *
 * Requests one random path that cannot be in the wordlist and returns its
 * fingerprint. A null result means the server could not be probed; callers
 * then simply skip soft-404 filtering.
 */
async function probeSoft404(opts) {
  const input = opts || {};
  const options = Object.assign({}, DEFAULTS, input.options || {});
  const request = input.request || makeRequest(options);

  const base =
    input.baseUrl ||
    input.target ||
    options.target ||
    (Array.isArray(options.dirs) ? options.dirs[0] : options.dirs) ||
    "";

  let origin = null;
  try {
    origin = originOf(base);
  } catch (err) {
    origin = null;
  }
  if (!origin) {
    try {
      origin = new URL(String(base)).origin;
    } catch (err) {
      return null;
    }
  }
  if (!origin) return null;

  const path = `/__recon_probe_${crypto.randomBytes(12).toString("hex")}__`;

  try {
    const response = normalizeResponse(await request(origin + path));
    return {
      sha256: response.sha256,
      size: response.size,
      status: response.status,
    };
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fuzzer
// ---------------------------------------------------------------------------

function directoryUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;

  const question = normalized.indexOf("?");
  const withoutQuery = question >= 0 ? normalized.slice(0, question) : normalized;

  const schemeMarker = withoutQuery.indexOf("://");
  if (schemeMarker < 0) return null;
  const pathStart = withoutQuery.indexOf("/", schemeMarker + 3);
  if (pathStart < 0) return withoutQuery + "/";
  if (withoutQuery.charAt(withoutQuery.length - 1) === "/") return withoutQuery;
  return withoutQuery + "/";
}

function extensionOf(url) {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch (err) {
    pathname = String(url);
  }
  const match = /\.([A-Za-z0-9]+)$/.exec(pathname);
  return match ? match[1].toLowerCase() : "";
}

function classify(url, status, headers) {
  if ((status >= 300 && status < 400) || status === 401 || status === 403) {
    return "endpoint";
  }

  const extension = extensionOf(url);
  if (extension && ASSET_EXTENSIONS.has(extension)) return "asset";

  if (status >= 200 && status < 300) {
    const contentType = String(headerOf(headers, "content-type") || "").toLowerCase();
    if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml") ||
      extension === "html" ||
      extension === "htm" ||
      !extension
    ) {
      return "page";
    }
  }
  return "endpoint";
}

function looksSoft(response, reference, tolerance) {
  if (!reference || !HIT_STATUSES.has(Number(reference.status))) return false;

  if (
    response.sha256 &&
    reference.sha256 &&
    String(response.sha256) === String(reference.sha256)
  ) {
    return true;
  }

  const referenceSize = Number(reference.size);
  const responseSize = Number(response.size);
  if (!Number.isFinite(referenceSize) || !Number.isFinite(responseSize)) {
    return false;
  }
  const delta = Math.abs(responseSize - referenceSize) / Math.max(referenceSize, 1);
  return delta <= tolerance;
}

function createFuzzer(input) {
  const config = input || {};
  const db = config.db;
  const scanId = config.scanId;
  const options = Object.assign({}, DEFAULTS, config.options || {});

  const target =
    config.target ||
    options.target ||
    (Array.isArray(options.dirs) ? options.dirs[0] : options.dirs) ||
    "";

  const request = config.request
    ? (url) => Promise.resolve(config.request(url)).then(normalizeResponse)
    : makeRequest(options);

  const concurrency = clampInt(options.concurrency, DEFAULTS.concurrency, 1, 10);
  const delay = clampInt(options.delay, DEFAULTS.delay, 0, 60000);
  const timeout = clampInt(options.timeout, DEFAULTS.timeout, 1, 120000);
  const userAgent = String(options.userAgent || DEFAULTS.userAgent);
  const tolerance = clampFloat(
    options.soft404Tolerance,
    DEFAULTS.soft404Tolerance,
    0,
    1
  );
  const maxPaths = clampInt(options.maxPaths, DEFAULTS.maxPaths, 1, 10000000);

  const words = parseWordlist(options.wordlist || config.wordlist || "");

  const rawDirs = Array.isArray(options.dirs)
    ? options.dirs
    : options.dirs
    ? [options.dirs]
    : [target];

  const dirs = [];
  for (const rawDir of rawDirs) {
    const dir = directoryUrl(rawDir);
    if (dir) dirs.push(dir);
  }

  async function run() {
    const result = { tested: 0, hits: 0, softSkips: 0, errors: 0 };

    if (words.length === 0 || dirs.length === 0) return result;
    if (dirs.length * words.length > maxPaths) return result;

    let reference = null;
    if (tolerance > 0) {
      reference = await probeSoft404({
        request,
        baseUrl: target || dirs[0],
        target,
        options: { timeout, userAgent },
        wordlist: words,
      });
    }

    const parentCache = new Map();
    const parentFor = (dir) => {
      if (parentCache.has(dir)) return parentCache.get(dir);
      let row = null;
      try {
        row = getNodeByKey(db, scanId, key(dir));
      } catch (err) {
        row = null;
      }
      parentCache.set(dir, row);
      return row;
    };

    const tasks = [];
    for (const dir of dirs) {
      for (const word of words) tasks.push({ dir, word });
    }

    let cursor = 0;
    let nextStart = 0;

    async function handleTask(task) {
      const url = task.dir + encodeURI(task.word);

      let response;
      try {
        response = normalizeResponse(await request(url));
      } catch (err) {
        result.errors += 1;
        return;
      }
      result.tested += 1;

      const status = response.status;
      if (MISS_STATUSES.has(status)) return;
      if (!HIT_STATUSES.has(status)) return;
      if (looksSoft(response, reference, tolerance)) {
        result.softSkips += 1;
        return;
      }

      const nodeKey = key(url);
      if (!nodeKey) {
        result.errors += 1;
        return;
      }

      const parent = parentFor(task.dir);
      const parentDepth =
        parent && Number.isFinite(Number(parent.depth)) ? Number(parent.depth) : 0;
      const depth = parentDepth + 1;
      const normalized = normalizeUrl(url) || url;

      try {
        const stored = upsertNode(db, scanId, {
          key: nodeKey,
          type: classify(url, status, response.headers),
          url: normalized,
          status,
          depth,
          origin: "fuzz",
          attrs: { fuzz: true },
        });
        result.hits += 1;
        if (parent) {
          addEdge(db, scanId, parent.id, stored.id, "fuzzed");
        }
      } catch (err) {
        result.errors += 1;
      }
    }

    async function worker() {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= tasks.length) return;

        const now = Date.now();
        const start = Math.max(now, nextStart);
        nextStart = start + delay;
        if (start > now) await sleep(start - now);

        await handleTask(tasks[index]);
      }
    }

    const workerCount = Math.min(concurrency, tasks.length);
    const workers = [];
    for (let i = 0; i < workerCount; i += 1) workers.push(worker());
    await Promise.all(workers);

    return result;
  }

  return { run };
}

module.exports = {
  parseWordlist,
  probeSoft404,
  createFuzzer,
};
