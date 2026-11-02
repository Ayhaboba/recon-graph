"use strict";

/**
 * Explicit node refetch (stage 7, spec §8/§9 row 7).
 *
 * The server is read-only for everything except this action. `refetchNode`
 * opens a short-lived writable connection, fetches one already-known URL,
 * updates the node + body + findings, and closes. The rev trigger makes the
 * change visible to the 250 ms delta poller.
 */

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const dbApi = require("./db");
const rules = require("./rules");
const extract = require("./extract");
const { withTransaction } = require("./migrate");

const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY = 10 * 1024 * 1024;
const PREVIEW_CAP = 200 * 1024;

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

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha1Short(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 20);
}

function extensionOf(url) {
  let pathname;
  try {
    pathname = new URL(String(url)).pathname;
  } catch (_err) {
    return null;
  }
  const slash = pathname.lastIndexOf("/");
  const name = pathname.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

function mimeOf(headers) {
  if (!headers) return "";
  const raw = headers["content-type"];
  if (!raw) return "";
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value).split(";")[0].trim().toLowerCase();
}

function charsetOf(headers) {
  if (!headers) return null;
  const raw = headers["content-type"];
  if (!raw) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(String(value));
  return match ? match[1].toLowerCase() : null;
}

function decodeBody(buffer, headers) {
  if (!buffer || buffer.length === 0) return "";
  const charset = charsetOf(headers);
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    try {
      return new TextDecoder(charset).decode(buffer);
    } catch (_err) {
      // Unknown label: fall through to UTF-8.
    }
  }
  return buffer.toString("utf8");
}

function isTextual(mime, extension) {
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

function normalizeResponseHeaders(headers) {
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

function urlFromKey(key) {
  const text = String(key == null ? "" : key).trim();
  const match = /^[A-Za-z]+\s+(.+)$/.exec(text);
  const candidate = match ? match[1].trim() : text;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch (_err) {
    // not a URL
  }
  return null;
}

function requestHeaders(options) {
  const out = {
    "user-agent": options.userAgent || "recon-graph/1.0",
    accept: "*/*",
    "accept-encoding": "identity",
    connection: "close",
  };
  const extra = options.headers;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const name of Object.keys(extra)) {
      const value = extra[name];
      if (value === undefined || value === null) continue;
      out[String(name).toLowerCase()] = String(value);
    }
  }
  return out;
}

function fetchOnce(url, options) {
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
    const cap = options.maxBodyBytes;
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
          headers: requestHeaders(options),
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
                error: errorMessage(err),
              });
            }
          });
        }
      );
    } catch (err) {
      resolve({ url, error: errorMessage(err) });
      return;
    }

    timer = setTimeout(() => {
      request.destroy(new Error("timeout"));
    }, options.timeout);

    request.on("error", (err) => {
      finish({ error: errorMessage(err) });
    });
    request.end();
  });
}

async function fetchFollow(url, options) {
  let current = url;
  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const response = await fetchOnce(current, options);
    if (response.error) return response;

    const status = Number(response.status);
    const rawLocation = response.headers && response.headers.location;
    if (
      status >= 300 &&
      status < 400 &&
      rawLocation &&
      hop < options.maxRedirects
    ) {
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation;
      let next;
      try {
        next = new URL(String(location), current).toString();
      } catch (_err) {
        return Object.assign({}, response, { finalUrl: current });
      }
      if (!/^https?:/i.test(next)) {
        return Object.assign({}, response, { finalUrl: current });
      }
      current = next;
      continue;
    }

    return Object.assign({}, response, { finalUrl: current });
  }
  return { url, error: "redirect loop" };
}

function parseAttrs(row) {
  if (!row || row.attrs_json == null) return {};
  try {
    const parsed = JSON.parse(String(row.attrs_json));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_err) {
    return {};
  }
}

function bodyPayload(db, row, dataDir, cap) {
  const body = db.raw
    .prepare("SELECT * FROM bodies WHERE node_id = ?")
    .get(Number(row.id));
  if (!body) {
    return { mime: null, size: null, truncated: false, preview: "" };
  }

  const url = row.url || urlFromKey(row.key) || "";
  const textual = isTextual(body.mime, extensionOf(url));
  let text = body.text;
  if (text === null || text === undefined) {
    text = "";
    if (textual && body.file_path) {
      try {
        text = fs.readFileSync(path.resolve(dataDir, String(body.file_path)), "utf8");
      } catch (_err) {
        text = "";
      }
    }
  }

  let preview = String(text);
  let truncated = Number(body.fts_truncated) === 1;
  const bytes = Buffer.from(preview, "utf8");
  if (bytes.length > cap) {
    preview = bytes.subarray(0, cap).toString("utf8");
    truncated = true;
  }

  const size =
    body.size === null || body.size === undefined
      ? bytes.length
      : Number(body.size);

  return {
    mime: body.mime === undefined ? null : body.mime,
    size,
    truncated,
    preview,
  };
}

/**
 * Build the exact `node` frame payload from a node row.
 * Shared by the read-only stream handler and refetchNode.
 */
function buildNodePayload(db, row, options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || "./data");
  const cap = Number(opts.cap) > 0 ? Number(opts.cap) : PREVIEW_CAP;
  const attrs = parseAttrs(row);

  const findings = db.raw
    .prepare(
      `SELECT id, rule, severity, snippet, offset, attrs_json
         FROM findings WHERE node_id = ? ORDER BY offset, id`
    )
    .all(Number(row.id))
    .map((finding) => {
      let findingAttrs = {};
      try {
        const parsed = JSON.parse(String(finding.attrs_json || "{}"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          findingAttrs = parsed;
        }
      } catch (_err) {
        findingAttrs = {};
      }
      return {
        id: Number(finding.id),
        rule: finding.rule,
        severity: finding.severity,
        snippet: finding.snippet,
        offset: finding.offset == null ? null : Number(finding.offset),
        attrs: findingAttrs,
      };
    });

  return {
    node: {
      id: Number(row.id),
      key: row.key,
      type: row.type,
      label: row.label == null ? null : String(row.label),
      url: row.url == null ? null : String(row.url),
      method: row.method == null ? null : String(row.method),
      status: row.status == null ? null : Number(row.status),
      depth: row.depth == null ? null : Number(row.depth),
      degree: Number(row.degree || 0),
      origin: row.origin,
      rev: Number(row.rev || 0),
      attrs,
    },
    headers:
      attrs.headers && typeof attrs.headers === "object" && !Array.isArray(attrs.headers)
        ? attrs.headers
        : {},
    findings,
    body: bodyPayload(db, row, dataDir, cap),
  };
}

/**
 * refetchNode({ dataDir, scanId, nodeId, options })
 *   -> { node, headers, findings, body, revBefore, revAfter } | { error }
 */
async function refetchNode(input) {
  const opts = input || {};
  const dataDir = path.resolve(opts.dataDir || "./data");
  const scanId = Number(opts.scanId);
  const nodeId = Number(opts.nodeId);

  if (!Number.isSafeInteger(scanId) || scanId <= 0) {
    return { error: "invalid scanId" };
  }
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
    return { error: "invalid nodeId" };
  }

  const dbPath = path.join(dataDir, "scans", `${scanId}.sqlite`);
  if (!fs.existsSync(dbPath)) return { error: "scan not found" };

  let handle = null;
  try {
    handle = dbApi.openDb(dbPath);
  } catch (err) {
    return { error: errorMessage(err) };
  }

  try {
    const before = dbApi.getNodeById(handle, nodeId);
    if (!before || Number(before.scan_id) !== scanId) {
      return { error: "node not found" };
    }

    const target =
      urlFromKey(before.key) || (before.url ? urlFromKey(before.url) : null);
    if (!target) return { error: "node key is not an http(s) URL" };

    const options = opts.options || {};
    const requestOptions = {
      timeout:
        Number(options.timeout) > 0 ? Number(options.timeout) : DEFAULT_TIMEOUT,
      maxRedirects:
        Number(options.maxRedirects) >= 0
          ? Number(options.maxRedirects)
          : DEFAULT_MAX_REDIRECTS,
      maxBodyBytes:
        Number(options.maxBodyBytes) > 0
          ? Number(options.maxBodyBytes)
          : DEFAULT_MAX_BODY,
      userAgent: options.userAgent || "recon-graph/1.0",
      headers: options.headers,
    };

    let response;
    try {
      response = await fetchFollow(target, requestOptions);
    } catch (err) {
      return { error: errorMessage(err) };
    }
    if (response.error) return { error: errorMessage(response.error) };

    const buffer = response.body || Buffer.alloc(0);
    const mime = mimeOf(response.headers);
    const extension = extensionOf(response.finalUrl || target);
    const text = isTextual(mime, extension)
      ? decodeBody(buffer, response.headers)
      : null;

    let title = null;
    if (
      text !== null &&
      (mime === "text/html" || mime === "application/xhtml+xml")
    ) {
      try {
        const document = extract.extractHtml(text, {
          baseUrl: response.finalUrl || target,
        });
        title = document.title || null;
      } catch (_err) {
        title = null;
      }
    }

    const digest = sha256Hex(buffer);
    const relativePath = "bodies/" + digest.slice(0, 2) + "/" + digest;
    const absolutePath = path.join(dataDir, "bodies", digest.slice(0, 2), digest);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, buffer);

    const revBefore = Number(before.rev) || 0;
    const status = response.status == null ? null : Number(response.status);
    const attrs = Object.assign({}, parseAttrs(before), {
      headers: normalizeResponseHeaders(response.headers),
      fetched_at: new Date().toISOString(),
    });

    const findings = text === null ? [] : rules.scan(text, { sourceUrl: target });

    withTransaction(handle.raw, () => {
      dbApi.upsertNode(handle, scanId, {
        key: before.key,
        type: before.type,
        origin: before.origin,
        status,
        attrs,
      });

      dbApi.putBody(handle, nodeId, {
        mime: mime || null,
        encoding: charsetOf(response.headers) || "utf-8",
        size: buffer.length,
        sha256: digest,
        filePath: relativePath,
        title,
        text,
        truncated: Boolean(response.truncated),
      });

      const seen = new Set(
        handle.raw
          .prepare("SELECT rule, offset FROM findings WHERE node_id = ?")
          .all(nodeId)
          .map((row) => `${row.rule}@${row.offset == null ? 0 : Number(row.offset)}`)
      );

      const insertFinding = handle.raw.prepare(
        `INSERT INTO findings(
           scan_id, node_id, rule, severity, snippet, offset, attrs_json
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`
      );

      for (const finding of findings) {
        const offset = Number.isFinite(Number(finding.offset))
          ? Number(finding.offset)
          : 0;
        const dedupeKey = `${finding.rule}@${offset}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        insertFinding.run(
          scanId,
          nodeId,
          finding.rule,
          finding.severity,
          finding.snippet,
          offset,
          JSON.stringify(finding.attrs || {})
        );

        const artifactKey =
          "artifact:" + finding.rule + ":" + sha1Short(finding.match);
        const artifact = dbApi.upsertNode(handle, scanId, {
          key: artifactKey,
          type: "artifact",
          origin: "crawl",
          label: finding.rule,
          depth: before.depth == null ? null : Number(before.depth),
          attrs: { rule: finding.rule, severity: finding.severity },
        });

        if (Number(artifact.id) !== Number(nodeId)) {
          dbApi.addEdge(handle, scanId, nodeId, Number(artifact.id), "contains");
        }
      }
    });

    const after = dbApi.getNodeById(handle, nodeId);
    const payload = buildNodePayload(handle, after, {
      dataDir,
      cap: PREVIEW_CAP,
    });

    return {
      node: payload.node,
      headers: payload.headers,
      findings: payload.findings,
      body: payload.body,
      revBefore,
      revAfter: Number(after.rev) || 0,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  } finally {
    try {
      handle.close();
    } catch (_err) {
      // best effort
    }
  }
}

module.exports = {
  refetchNode,
  buildNodePayload,
  urlFromKey,
  normalizeResponseHeaders,
  PREVIEW_CAP,
};
