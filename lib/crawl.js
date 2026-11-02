"use strict";

/**
 * recon-graph crawler core (stage 3, spec §8).
 *
 * One crawler owns one scan. The queue lives in SQLite (`queue` table), and
 * every claim is a transaction, so a resumed scanner and a stopped process
 * never fight over the same row. Fetching is plain node:http/node:https:
 * redirects are followed by hand so that every hop becomes a graph node.
 *
 * Invariants:
 *  - a URL whose node already has a status is never fetched twice;
 *  - one body file per sha256, written only when the response is under
 *    maxBodyBytes (oversized responses are marked attrs.truncated);
 *  - the per-URL DB writes (nodes, edges, body, findings) happen in one
 *    transaction, so a crash cannot leave edges pointing at missing nodes;
 *  - stop() only freezes the queue: in-flight requests are allowed to finish.
 */

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const norm = require("./norm");
const extract = require("./extract");
const rules = require("./rules");
const dbApi = require("./db");
const { withTransaction } = require("./migrate");

const DEFAULTS = {
  maxDepth: 6,
  concurrency: 8,
  perHost: 4,
  delay: 100,
  timeout: 15000,
  scope: "same-origin",
  ignoreRobots: false,
  headers: {},
  userAgent: "recon-graph/1.0",
  maxBodyBytes: 10 * 1024 * 1024,
  maxRedirects: 10,
};

const SCOPES = new Set(["same-origin", "host", "any"]);

const ASSET_EXTENSIONS = new Set([
  "js",
  "css",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "woff2",
  "woff",
  "ttf",
  "ico",
  "pdf",
  "zip",
  "gz",
  "map",
  "txt",
  "xml",
]);

const TEXT_EXTENSIONS = new Set([
  "html",
  "htm",
  "js",
  "css",
  "json",
  "xml",
  "txt",
  "map",
]);

const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_ROBOTS_REDIRECTS = 5;

class StopSignal extends Error {
  constructor() {
    super("crawler stopped");
    this.name = "StopSignal";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInt(value, fallback, minimum) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.floor(number));
}

// ---------------------------------------------------------------------------
// URL / response helpers
// ---------------------------------------------------------------------------

function pathAndQuery(url) {
  const marker = url.indexOf("://");
  if (marker < 0) return "/";
  const rest = url.slice(marker + 3);
  const slash = rest.indexOf("/");
  return slash >= 0 ? rest.slice(slash) : "/";
}

function extensionOf(url) {
  const rest = pathAndQuery(url);
  const question = rest.indexOf("?");
  const pathname = question >= 0 ? rest.slice(0, question) : rest;
  const slash = pathname.lastIndexOf("/");
  const name = pathname.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

function hostnameOf(url) {
  const origin = norm.originOf(url);
  if (!origin) return null;
  const authority = origin.slice(origin.indexOf("://") + 3);
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    return close >= 0 ? authority.slice(0, close + 1) : authority;
  }
  const colon = authority.lastIndexOf(":");
  return colon >= 0 ? authority.slice(0, colon) : authority;
}

function isAssetUrl(url) {
  const extension = extensionOf(url);
  return extension !== null && ASSET_EXTENSIONS.has(extension);
}

function pathLabel(url) {
  return pathAndQuery(url) || "/";
}

function mimeOf(headers) {
  if (!headers) return "";
  const raw = headers["content-type"] || headers["Content-Type"];
  if (!raw) return "";
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value).split(";")[0].trim().toLowerCase();
}

// Header names are stored lowercased; duplicate response headers keep the
// first value (set-cookie is the common array case).
function storedResponseHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const name of Object.keys(headers)) {
    const value = headers[name];
    if (value === undefined || value === null) continue;
    const key = String(name).trim().toLowerCase();
    if (!key) continue;
    out[key] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return out;
}

function charsetOf(contentType) {
  if (!contentType) return null;
  const raw = Array.isArray(contentType) ? contentType[0] : contentType;
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(String(raw));
  return match ? match[1].toLowerCase() : null;
}

function decodeBody(buffer, contentType) {
  if (!buffer || buffer.length === 0) return "";
  const charset = charsetOf(contentType);
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch (_err) {
      // Unknown label: fall through to UTF-8.
    }
  }
  return buffer.toString("utf8");
}

function isTextualMime(mime, extension) {
  if (!mime) {
    return extension === null || TEXT_EXTENSIONS.has(extension);
  }
  if (mime.startsWith("text/")) return true;
  if (
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript" ||
    mime === "application/ecmascript" ||
    mime === "application/ld+json" ||
    mime === "image/svg+xml"
  ) {
    return true;
  }
  return mime.endsWith("+json") || mime.endsWith("+xml");
}

function classifyResponse(url, response) {
  const status = Number(response.status);
  const mime = mimeOf(response.headers);
  const extension = extensionOf(url);

  // Bodies that carry no representation are endpoints even when a broken
  // server labels them text/html.
  if (status === 204 || status === 205 || status === 304) return "endpoint";

  if (mime === "text/html" || mime === "application/xhtml+xml") return "page";

  if (!mime) {
    if (!extension || extension === "html" || extension === "htm") return "page";
    if (ASSET_EXTENSIONS.has(extension)) return "asset";
    return "endpoint";
  }

  if (ASSET_EXTENSIONS.has(extension)) return "asset";
  return "endpoint";
}

function buildRequestHeaders(input, userAgent) {
  const out = Object.create(null);

  const add = (name, value) => {
    if (name === undefined || name === null || value === undefined || value === null) {
      return;
    }
    const key = String(name).trim().toLowerCase();
    if (!key) return;
    out[key] = String(value);
  };

  if (Array.isArray(input)) {
    for (const entry of input) {
      if (!entry) continue;
      if (typeof entry === "string") {
        const colon = entry.indexOf(":");
        if (colon <= 0) continue;
        add(entry.slice(0, colon), entry.slice(colon + 1).trim());
      } else if (typeof entry === "object") {
        add(entry.name, entry.value);
      }
    }
  } else if (input && typeof input === "object") {
    for (const key of Object.keys(input)) add(key, input[key]);
  }

  if (!("user-agent" in out)) out["user-agent"] = String(userAgent);
  if (!("accept" in out)) out.accept = "*/*";
  if (!("accept-encoding" in out)) out["accept-encoding"] = "identity";
  if (!("connection" in out)) out.connection = "close";
  return out;
}

// robots.txt: consecutive User-agent lines form one group; Allow/Disallow rules
// apply to that group. The crawler unions the `*` group and its own token.
function parseRobots(text, uaToken) {
  const groups = [];
  let group = null;
  let lastWasAgent = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (!group || (!lastWasAgent && group.rules.length > 0)) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    if (key === "allow" || key === "disallow") {
      if (!group) {
        group = { agents: ["*"], rules: [] };
        groups.push(group);
      }
      if (value !== "") {
        group.rules.push({ allow: key === "allow", path: value });
      }
      lastWasAgent = false;
      continue;
    }

    lastWasAgent = false;
  }

  const token = String(uaToken || "")
    .split(/[\/\s]/)[0]
    .toLowerCase();
  const applicable = [];

  for (const candidate of groups) {
    const matches = candidate.agents.some((agent) => {
      if (agent === "*") return true;
      if (!agent) return false;
      if (!token) return false;
      return agent.includes(token) || token.includes(agent);
    });
    if (matches) applicable.push(...candidate.rules);
  }

  return applicable;
}

function robotsRulesAllow(ruleList, pathQuery) {
  let best = null;
  for (const rule of ruleList) {
    if (!rule.path) continue;
    if (!pathQuery.startsWith(rule.path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best === null ? true : best.allow;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha1Short(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 20);
}

// ---------------------------------------------------------------------------
// createCrawler
// ---------------------------------------------------------------------------

function createCrawler(config) {
  if (!config || typeof config !== "object") {
    throw new TypeError("createCrawler: config required");
  }
  if (!config.db) throw new TypeError("createCrawler: config.db required");

  const db = config.db;
  const scanId = Number(config.scanId);
  if (!Number.isSafeInteger(scanId) || scanId <= 0) {
    throw new TypeError("createCrawler: config.scanId must be a positive integer");
  }

  const target = norm.normalizeUrl(config.target);
  if (!target) {
    throw new TypeError("createCrawler: config.target must be an absolute http(s) URL");
  }

  const given = config.options || {};
  const options = {
    maxDepth: clampInt(given.maxDepth, DEFAULTS.maxDepth, 0),
    concurrency: clampInt(given.concurrency, DEFAULTS.concurrency, 1),
    perHost: clampInt(given.perHost, DEFAULTS.perHost, 1),
    delay: clampInt(given.delay, DEFAULTS.delay, 0),
    timeout: clampInt(given.timeout, DEFAULTS.timeout, 1),
    scope: given.scope == null ? DEFAULTS.scope : String(given.scope),
    ignoreRobots: given.ignoreRobots === true,
    headers: given.headers == null ? DEFAULTS.headers : given.headers,
    userAgent:
      given.userAgent == null ? DEFAULTS.userAgent : String(given.userAgent),
    maxBodyBytes: clampInt(given.maxBodyBytes, DEFAULTS.maxBodyBytes, 1),
    maxRedirects: clampInt(given.maxRedirects, DEFAULTS.maxRedirects, 0),
    dataDir: given.dataDir == null ? null : String(given.dataDir),
  };

  if (!SCOPES.has(options.scope)) {
    throw new TypeError('createCrawler: options.scope must be "same-origin", "host" or "any"');
  }

  const dataDir = path.resolve(config.dataDir || options.dataDir || "./data");
  const requestHeaders = buildRequestHeaders(options.headers, options.userAgent);

  let stopped = false;
  let runPromise = null;
  let active = 0;
  const tasks = new Set();
  const hostSlots = new Map();
  let robotsRules = [];
  let wake = null;
  let wakeTimer = null;

  function notify() {
    if (!wake) return;
    const resolve = wake;
    wake = null;
    if (wakeTimer) {
      clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    resolve();
  }

  function waitForChange() {
    return new Promise((resolve) => {
      wake = resolve;
      wakeTimer = setTimeout(() => {
        if (wake === resolve) {
          wake = null;
          wakeTimer = null;
          resolve();
        }
      }, 50);
    });
  }

  function inScope(url) {
    const normalized = norm.normalizeUrl(url);
    if (!normalized) return false;
    if (options.scope === "any") return true;
    if (options.scope === "host") {
      return hostnameOf(normalized) === hostnameOf(target);
    }
    return norm.originOf(normalized) === norm.originOf(target);
  }

  function robotsAllows(url) {
    if (options.ignoreRobots || robotsRules.length === 0) return true;
    const normalized = norm.normalizeUrl(url);
    if (!normalized) return true;
    return robotsRulesAllow(robotsRules, pathAndQuery(normalized));
  }

  function markQueueSkip(url, kind, depth) {
    const raw = db.raw;
    const info = raw
      .prepare(
        `INSERT OR IGNORE INTO queue(
           scan_id, url, kind, depth, origin, state, priority
         ) VALUES(?, ?, ?, ?, 'crawl', 'skip', 0)`
      )
      .run(scanId, url, kind, depth);
    if (Number(info.changes) === 0) {
      raw
        .prepare(
          `UPDATE queue SET state = 'skip'
            WHERE scan_id = ? AND url = ? AND kind = ? AND state = 'pending'`
        )
        .run(scanId, url, kind);
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  function fetchOnce(url, maxBytes) {
    return new Promise((resolve) => {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_err) {
        resolve({ url, error: "invalid url" });
        return;
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        resolve({ url, error: "unsupported scheme" });
        return;
      }

      const transport = parsed.protocol === "https:" ? https : http;
      const cap = maxBytes === undefined ? options.maxBodyBytes : maxBytes;
      let settled = false;
      let timer = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(Object.assign({ url }, result));
      };

      let request;
      try {
        request = transport.request(
          {
            protocol: parsed.protocol,
            hostname: parsed.hostname.replace(/^\[|\]$/g, ""),
            port: parsed.port ? Number(parsed.port) : undefined,
            path: parsed.pathname + parsed.search,
            method: "GET",
            headers: requestHeaders,
          },
          (response) => {
            const chunks = [];
            let bytes = 0;
            let truncated = false;

            response.on("data", (chunk) => {
              if (truncated) return;
              bytes += chunk.length;
              if (bytes > cap) {
                truncated = true;
                finish({
                  status: response.statusCode,
                  headers: response.headers,
                  body: Buffer.concat(chunks),
                  bytes,
                  truncated: true,
                });
                response.destroy();
                return;
              }
              chunks.push(chunk);
            });

            const settle = () => {
              finish({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
                bytes,
                truncated,
              });
            };

            response.on("end", settle);
            response.on("close", () => {
              if (!settled) settle();
            });
            response.on("error", (err) => {
              if (!truncated) {
                finish({
                  status: response.statusCode,
                  headers: response.headers,
                  error: err && err.message ? err.message : "response error",
                });
              }
            });
          }
        );
      } catch (err) {
        resolve({ url, error: err && err.message ? err.message : String(err) });
        return;
      }

      timer = setTimeout(() => {
        request.destroy(new Error("timeout"));
      }, options.timeout);

      request.on("error", (err) => {
        finish({ error: err && err.message ? err.message : String(err) });
      });
      request.end();
    });
  }

  function noteHostActivity(url) {
    const host = norm.hostOf(url);
    if (!host) return;
    const slot = hostSlots.get(host) || { active: 0, last: 0 };
    slot.last = Date.now();
    hostSlots.set(host, slot);
  }

  async function loadRobots() {
    if (options.ignoreRobots) return;
    const origin = norm.originOf(target);
    if (!origin) return;

    let url = origin + "/robots.txt";
    for (let hop = 0; hop <= MAX_ROBOTS_REDIRECTS; hop += 1) {
      if (stopped) return;
      const response = await fetchOnce(url, MAX_ROBOTS_BYTES);
      noteHostActivity(url);
      if (response.error) return;

      const status = Number(response.status);
      if (status >= 300 && status < 400 && response.headers && response.headers.location) {
        const location = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location;
        const next = norm.resolveUrl(String(location), url);
        if (!next) return;
        url = next;
        continue;
      }

      if (status >= 200 && status < 300) {
        const text = decodeBody(
          response.body || Buffer.alloc(0),
          response.headers && response.headers["content-type"]
        );
        robotsRules = parseRobots(text, options.userAgent);
      }
      return;
    }
  }

  async function acquireHost(host) {
    for (;;) {
      if (stopped) throw new StopSignal();
      const slot = hostSlots.get(host) || { active: 0, last: 0 };
      hostSlots.set(host, slot);
      const wait = slot.last
        ? Math.max(0, slot.last + options.delay - Date.now())
        : 0;

      if (slot.active < options.perHost && wait <= 0) {
        slot.active += 1;
        slot.last = Date.now();
        return slot;
      }

      await sleep(wait > 0 ? Math.min(wait, 50) : 10);
    }
  }

  function releaseHost(slot) {
    if (!slot) return;
    slot.active = Math.max(0, slot.active - 1);
  }

  // -------------------------------------------------------------------------
  // Graph writes
  // -------------------------------------------------------------------------

  function enqueueDiscovered(rawUrl, depth) {
    const normalized = norm.normalizeUrl(rawUrl);
    if (!normalized) return null;
    const nodeKey = norm.key(normalized);
    if (!nodeKey) return null;

    let existing = dbApi.getNodeByKey(db, scanId, nodeKey);
    let nodeId;

    if (existing) {
      nodeId = Number(existing.id);
    } else {
      const created = dbApi.upsertNode(db, scanId, {
        key: nodeKey,
        type: "unresolved",
        origin: "crawl",
        url: normalized,
        depth,
        label: pathLabel(normalized),
      });
      nodeId = Number(created.id);
      existing = null;
    }

    if (!inScope(normalized) || depth > options.maxDepth) {
      return { nodeId };
    }

    if (existing && existing.status !== null && existing.status !== undefined) {
      return { nodeId };
    }

    const kind = isAssetUrl(normalized) ? "asset" : "page";

    if (!robotsAllows(normalized)) {
      markQueueSkip(normalized, kind, depth);
      return { nodeId };
    }

    dbApi.enqueue(db, scanId, {
      url: normalized,
      kind,
      depth,
      origin: "crawl",
      priority: 0,
    });

    return { nodeId };
  }

  function addParamNode(url, sourceId, depth) {
    const paramKey = norm.paramKey(url);
    if (!paramKey) return;
    const node = dbApi.upsertNode(db, scanId, {
      key: paramKey,
      type: "param",
      origin: "crawl",
      url,
      depth,
      label: paramKey.slice("param:".length),
    });
    if (Number(node.id) !== Number(sourceId)) {
      dbApi.addEdge(db, scanId, sourceId, Number(node.id), "link");
    }
  }

  // -------------------------------------------------------------------------
  // Per-URL processing
  // -------------------------------------------------------------------------

  async function processRow(row) {
    const normalized = norm.normalizeUrl(row.url);
    const host = normalized ? norm.hostOf(normalized) : "";
    const slot = await acquireHost(host || "-");
    try {
      await handleRow(row, normalized);
    } finally {
      releaseHost(slot);
    }
  }

  async function handleRow(row, startUrl) {
    if (!startUrl) {
      dbApi.setQueueState(db, row.id, "skip", { error: "invalid url" });
      return;
    }

    if (!robotsAllows(startUrl)) {
      dbApi.setQueueState(db, row.id, "skip");
      return;
    }

    if (stopped) {
      dbApi.setQueueState(db, row.id, "pending");
      return;
    }

    const rowDepth = Number.isFinite(Number(row.depth)) ? Number(row.depth) : 0;
    const startKey = norm.key(startUrl);
    const existing = startKey ? dbApi.getNodeByKey(db, scanId, startKey) : null;
    if (existing && existing.status !== null && existing.status !== undefined) {
      dbApi.setQueueState(db, row.id, "skip");
      return;
    }

    // Network phase: no DB writes until the chain is complete, so a slow
    // request never holds the write transaction open.
    const hops = [];
    const visited = new Set();
    let current = startUrl;
    let loopTarget = null;
    let knownTarget = null;

    for (let hopIndex = 0; ; hopIndex += 1) {
      if (visited.has(current)) {
        loopTarget = current;
        break;
      }
      visited.add(current);

      if (stopped) break;
      if (hopIndex > options.maxRedirects) break;

      const response = await fetchOnce(current);
      hops.push({ url: current, response });

      if (response.error) break;

      const status = Number(response.status);
      if (!(status >= 300 && status < 400)) break;

      const rawLocation = response.headers && response.headers.location;
      if (!rawLocation) break;
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      const next = norm.resolveUrl(String(location), current);
      if (!next) break;

      if (visited.has(next)) {
        loopTarget = next;
        break;
      }

      const nextKey = norm.key(next);
      const nextNode = nextKey ? dbApi.getNodeByKey(db, scanId, nextKey) : null;
      if (nextNode && nextNode.status !== null && nextNode.status !== undefined) {
        knownTarget = { url: next, nodeId: Number(nextNode.id) };
        break;
      }

      current = next;
    }

    if (hops.length === 0) {
      // stop() arrived before the first request of this row
      dbApi.setQueueState(db, row.id, "pending");
      return;
    }

    const last = hops[hops.length - 1];
    const finalResponse = last.response;
    const finalUrl = last.url;
    const finalStatus = finalResponse.error ? null : Number(finalResponse.status);
    const finalMime = finalResponse.error ? "" : mimeOf(finalResponse.headers);
    const finalExtension = extensionOf(finalUrl);

    let finalType;
    if (finalResponse.error) {
      finalType = "unresolved";
    } else if (finalStatus >= 300 && finalStatus < 400) {
      finalType = "endpoint";
    } else {
      finalType = classifyResponse(finalUrl, finalResponse);
    }

    const bodyBuffer = finalResponse.error
      ? null
      : finalResponse.body || Buffer.alloc(0);
    const truncated = Boolean(finalResponse.truncated);

    const isPage = finalType === "page";
    const isCssAsset =
      finalType === "asset" && (finalMime === "text/css" || finalExtension === "css");
    const isJsAsset =
      finalType === "asset" &&
      (/javascript|ecmascript/.test(finalMime) || finalExtension === "js");

    const textual =
      isPage ||
      isCssAsset ||
      isJsAsset ||
      isTextualMime(finalMime, finalExtension);

    const text =
      bodyBuffer !== null && textual
        ? decodeBody(
            bodyBuffer,
            finalResponse.headers && finalResponse.headers["content-type"]
          )
        : null;

    let title = null;
    const discovered = [];

    if (text !== null) {
      if (isPage) {
        const html = extract.extractHtml(text, { baseUrl: finalUrl });
        title = html.title;
        for (const link of html.links) {
          discovered.push({ url: link.url, kind: "link" });
        }
      } else if (isCssAsset) {
        const css = extract.extractCss(text, { baseUrl: finalUrl });
        for (const link of css.links) {
          discovered.push({
            url: link.url,
            kind: link.attr === "js-string" ? "request" : "link",
          });
        }
      } else if (isJsAsset) {
        const js = extract.extractJs(text, { baseUrl: finalUrl });
        for (const link of js.links) {
          discovered.push({
            url: link.url,
            kind: link.attr === "js-string" ? "request" : "link",
          });
        }
      }
    }

    const findings =
      text === null ? [] : rules.scan(text, { sourceUrl: finalUrl });

    let bodyRecord = null;
    if (bodyBuffer !== null && !truncated) {
      const digest = sha256Hex(bodyBuffer);
      const relativePath = "bodies/" + digest.slice(0, 2) + "/" + digest;
      const absolutePath = path.join(dataDir, "bodies", digest.slice(0, 2), digest);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, bodyBuffer);
      bodyRecord = {
        mime: finalMime || null,
        encoding:
          charsetOf(finalResponse.headers && finalResponse.headers["content-type"]) ||
          "utf-8",
        size: bodyBuffer.length,
        sha256: digest,
        filePath: relativePath,
        title,
        text,
      };
    }

    const hopPlans = hops.map((hop, index) => {
      const response = hop.response;
      const isLast = index === hops.length - 1;
      const plan = {
        url: hop.url,
        key: norm.key(hop.url),
        type: isLast ? finalType : "endpoint",
        status: null,
        depth: rowDepth,
        attrs: {},
        last: isLast,
      };

      if (response.error) {
        plan.attrs.error = String(response.error);
      } else {
        plan.status = Number(response.status);
        const hopMime = mimeOf(response.headers);
        if (hopMime) plan.attrs.mime = hopMime;
        if (response.bytes !== undefined) plan.attrs.size = Number(response.bytes);
        if (response.truncated) plan.attrs.truncated = true;
        plan.attrs.headers = storedResponseHeaders(response.headers);
      }

      return plan;
    });

    withTransaction(db.raw, () => {
      const nodeIds = [];

      for (let index = 0; index < hopPlans.length; index += 1) {
        const plan = hopPlans[index];
        if (!plan.key) {
          nodeIds.push(null);
          continue;
        }

        const label =
          plan.last && plan.type === "page" && title
            ? title
            : pathLabel(plan.url);

        const node = dbApi.upsertNode(db, scanId, {
          key: plan.key,
          type: plan.type,
          origin: "crawl",
          url: plan.url,
          status: plan.status,
          depth: plan.depth,
          label,
          attrs: plan.attrs,
        });

        nodeIds.push(Number(node.id));

        if (index > 0 && nodeIds[index - 1] !== null) {
          dbApi.addEdge(
            db,
            scanId,
            nodeIds[index - 1],
            Number(node.id),
            "link"
          );
        }
      }

      const finalId = nodeIds.length ? nodeIds[nodeIds.length - 1] : null;

      // Loop-closing redirect: the target is one of the hops we already made.
      if (loopTarget && finalId !== null) {
        const loopKey = norm.key(loopTarget);
        const loopNode = loopKey ? dbApi.getNodeByKey(db, scanId, loopKey) : null;
        if (loopNode && Number(loopNode.id) !== Number(finalId)) {
          dbApi.addEdge(db, scanId, finalId, Number(loopNode.id), "link");
        }
      }

      // Redirect into an already-resolved node: edge only, no second fetch.
      if (knownTarget && finalId !== null) {
        if (Number(knownTarget.nodeId) !== Number(finalId)) {
          dbApi.addEdge(db, scanId, finalId, knownTarget.nodeId, "link");
        }
      }

      if (bodyRecord && finalId !== null) {
        dbApi.putBody(db, finalId, bodyRecord);
      }

      if (finalId !== null && findings.length > 0) {
        const insertFinding = db.raw.prepare(
          `INSERT INTO findings(
             scan_id, node_id, rule, severity, snippet, offset, attrs_json
           ) VALUES(?, ?, ?, ?, ?, ?, ?)`
        );

        for (const finding of findings) {
          insertFinding.run(
            scanId,
            finalId,
            finding.rule,
            finding.severity,
            finding.snippet,
            Number.isFinite(Number(finding.offset)) ? Number(finding.offset) : 0,
            JSON.stringify(finding.attrs || {})
          );

          const artifactKey =
            "artifact:" + finding.rule + ":" + sha1Short(finding.match);
          const artifact = dbApi.upsertNode(db, scanId, {
            key: artifactKey,
            type: "artifact",
            origin: "crawl",
            label: finding.rule,
            depth: rowDepth,
            attrs: { rule: finding.rule, severity: finding.severity },
          });

          if (Number(artifact.id) !== Number(finalId)) {
            dbApi.addEdge(db, scanId, finalId, Number(artifact.id), "contains");
          }
        }
      }

      for (let index = 0; index < hopPlans.length; index += 1) {
        const plan = hopPlans[index];
        if (plan.type !== "endpoint" || nodeIds[index] === null) continue;
        addParamNode(plan.url, nodeIds[index], rowDepth);
      }

      if (finalId !== null) {
        for (const found of discovered) {
          const targetInfo = enqueueDiscovered(found.url, rowDepth + 1);
          if (!targetInfo) continue;
          if (Number(targetInfo.nodeId) === Number(finalId)) continue;
          dbApi.addEdge(db, scanId, finalId, targetInfo.nodeId, found.kind);
        }
      }

      if (finalResponse.error) {
        dbApi.setQueueState(db, row.id, "err", {
          error: String(finalResponse.error),
        });
      } else {
        dbApi.setQueueState(db, row.id, "done");
      }
    });
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  function startTask(row) {
    active += 1;
    const task = (async () => {
      try {
        await processRow(row);
      } catch (err) {
        if (err instanceof StopSignal) {
          try {
            dbApi.setQueueState(db, row.id, "pending");
          } catch (_updateErr) {
            // The row keeps its inflight state only if the DB itself is gone.
          }
        } else {
          try {
            dbApi.setQueueState(db, row.id, "err", {
              error: err && err.message ? err.message : String(err),
            });
          } catch (_updateErr) {
            // Never let one failed row kill the pool.
          }
        }
      } finally {
        active -= 1;
        notify();
      }
    })();

    tasks.add(task);
    task.finally(() => {
      tasks.delete(task);
    });
  }

  function seedIfEmpty() {
    const counts = dbApi.queueCounts(db, scanId);
    const total =
      counts.pending + counts.inflight + counts.done + counts.skip + counts.err;
    if (total > 0) return;

    const kind = isAssetUrl(target) ? "asset" : "page";
    if (!robotsAllows(target)) {
      markQueueSkip(target, kind, 0);
      return;
    }

    dbApi.enqueue(db, scanId, {
      url: target,
      kind,
      depth: 0,
      origin: "crawl",
      priority: 100,
    });
  }

  function summarize() {
    const counts = dbApi.queueCounts(db, scanId);
    const current = dbApi.stats(db, scanId);
    return {
      nodes: Number(current.nodes),
      edges: Number(current.edges),
      pending: counts.pending,
      done: counts.done,
      err: counts.err,
      stopped,
    };
  }

  async function execute() {
    dbApi.requeueInflight(db, scanId);

    await loadRobots();

    if (stopped) return summarize();

    seedIfEmpty();

    while (!stopped) {
      let claimed = 0;

      while (!stopped && active < options.concurrency) {
        const row = dbApi.claimNext(db, scanId);
        if (!row) break;
        startTask(row);
        claimed += 1;
      }

      if (active === 0) {
        const counts = dbApi.queueCounts(db, scanId);
        if (counts.pending === 0) break;
        if (claimed === 0) break; // nothing claimable: avoid a spin
      }

      await waitForChange();
    }

    await Promise.allSettled(Array.from(tasks));
    return summarize();
  }

  function run() {
    if (runPromise) return runPromise;
    runPromise = execute().finally(() => {
      runPromise = null;
    });
    return runPromise;
  }

  function stop() {
    stopped = true;
    notify();
  }

  return {
    scanId,
    target,
    options,
    dataDir,
    run,
    stop,
  };
}

module.exports = { createCrawler };
