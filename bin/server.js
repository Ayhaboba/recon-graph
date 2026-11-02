#!/usr/bin/env node
"use strict";

/**
 * Stage 5 HTTP + WebSocket server for the recon-graph web UI.
 *
 * Serves <repo>/web read-only over HTTP, exposes GET /api/scans as a fallback
 * listing, and routes WebSocket upgrades to the streaming hub in lib/stream.js.
 * The server never writes to scan databases: all DB access goes through the
 * hub, which uses openReadOnly.
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_PORT = 8931;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DATA_DIR = path.resolve(__dirname, "..", "data");

const STATIC_ROOT = path.resolve(__dirname, "..", "web");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".bmp", "image/bmp"],
  [".avif", "image/avif"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".txt", "text/plain; charset=utf-8"],
]);

function contentTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

/** Parse `--port N`, `--host H`, `--data-dir DIR`; returns {port, host, dataDir}. */
function parseArgs(argv) {
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  let dataDir = DEFAULT_DATA_DIR;

  const parsePort = (raw, flag) => {
    if (raw === undefined) throw new Error(`${flag} requires a value`);
    if (!/^\d+$/.test(raw)) throw new Error(`invalid --port value: ${raw}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
      throw new Error(`--port out of range: ${raw}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--port" || arg === "-p") {
      port = parsePort(argv[i + 1], arg);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length), "--port");
    } else if (arg === "--host" || arg === "-h" || arg === "--bind") {
      const raw = argv[i + 1];
      if (raw === undefined || raw === "") throw new Error(`${arg} requires a value`);
      host = raw;
      i += 1;
    } else if (arg.startsWith("--host=")) {
      const raw = arg.slice("--host=".length);
      if (raw === "") throw new Error("--host requires a value");
      host = raw;
    } else if (arg === "--data-dir" || arg === "--data") {
      const raw = argv[i + 1];
      if (raw === undefined || raw === "") throw new Error(`${arg} requires a value`);
      dataDir = path.resolve(raw);
      i += 1;
    } else if (arg.startsWith("--data-dir=")) {
      const raw = arg.slice("--data-dir=".length);
      if (raw === "") throw new Error("--data-dir requires a value");
      dataDir = path.resolve(raw);
    } else if (arg.startsWith("--data=")) {
      const raw = arg.slice("--data=".length);
      if (raw === "") throw new Error("--data requires a value");
      dataDir = path.resolve(raw);
    } else if (arg === "--help") {
      throw Object.assign(new Error("help"), { isHelp: true });
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { port, host, dataDir };
}

/**
 * Resolve a request URL to a file path inside STATIC_ROOT.
 * Returns {ok:true, filePath} | {ok:false, status, reason}.
 */
function resolveRequestPath(rawUrl) {
  const rawPath = String(rawUrl || "/").split("?")[0].split("#")[0];

  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, status: 400, reason: "malformed uri" };
  }

  // Reject any explicit parent-directory segment (raw or percent-decoded).
  const segments = decoded.split("/");
  if (segments.includes("..")) {
    return { ok: false, status: 403, reason: "path traversal" };
  }
  if (decoded.includes("\0")) {
    return { ok: false, status: 400, reason: "invalid path" };
  }

  let relative = segments.filter((seg) => seg !== "" && seg !== ".").join("/");
  if (relative === "") relative = "index.html";

  const filePath = path.resolve(STATIC_ROOT, relative);

  // Defense in depth: resolved path must stay inside the static root.
  const relFromRoot = path.relative(STATIC_ROOT, filePath);
  if (relFromRoot === "" || relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
    return { ok: false, status: 403, reason: "path traversal" };
  }

  return { ok: true, filePath, urlPath: decoded };
}

function sendText(res, status, body, extraHeaders) {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJson(res, status, value, method) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (method === "HEAD") res.end();
  else res.end(payload);
}

function sendNotFound(res, urlPath) {
  sendText(res, 404, `not found: ${urlPath}\n`);
}

function pathnameOf(rawUrl) {
  return String(rawUrl || "/").split("?")[0].split("#")[0];
}

async function handleApiScans(req, res, hub) {
  if (!hub || typeof hub.scans !== "function") {
    sendJson(res, 503, { items: [], error: "hub unavailable" }, req.method);
    return;
  }

  let items;
  try {
    items = await hub.scans();
  } catch (err) {
    sendJson(res, 500, { items: [], error: "scans listing failed" }, req.method);
    return;
  }

  sendJson(res, 200, { items: Array.isArray(items) ? items : [] }, req.method);
}

async function handleRequest(req, res, hub) {
  const method = req.method || "GET";
  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, "method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const pathname = pathnameOf(req.url);
  if (pathname === "/api/scans") {
    await handleApiScans(req, res, hub);
    return;
  }

  const resolved = resolveRequestPath(req.url);
  if (!resolved.ok) {
    if (resolved.status === 404) sendNotFound(res, String(req.url || "/"));
    else sendText(res, resolved.status, `${resolved.reason}\n`);
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(resolved.filePath);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      sendNotFound(res, resolved.urlPath);
      return;
    }
    if (err && err.code === "EACCES") {
      sendText(res, 403, "forbidden\n");
      return;
    }
    sendText(res, 500, "internal server error\n");
    return;
  }

  // No directory listing: directories other than the root mapping are 404.
  if (!stat.isFile()) {
    sendNotFound(res, resolved.urlPath);
    return;
  }

  let body;
  try {
    body = await fsp.readFile(resolved.filePath);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "EISDIR" || err.code === "ENOTDIR")) {
      sendNotFound(res, resolved.urlPath);
      return;
    }
    if (err && err.code === "EACCES") {
      sendText(res, 403, "forbidden\n");
      return;
    }
    sendText(res, 500, "internal server error\n");
    return;
  }

  const headers = {
    "Content-Type": contentTypeFor(resolved.filePath),
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };

  res.writeHead(200, headers);
  if (method === "HEAD") res.end();
  else res.end(body);
}

/** Build the HTTP server. `hub` is optional (stage-0 tests use no hub). */
function createServer(hub) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, hub).catch((err) => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      sendText(res, 500, "internal server error\n");
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const isWsPath = pathnameOf(req.url) === "/ws";
    const upgradeHeader = String(req.headers.upgrade || "").toLowerCase();
    const wantsWebSocket = isWsPath || upgradeHeader.includes("websocket");

    if (wantsWebSocket && hub && typeof hub.handleUpgrade === "function") {
      try {
        hub.handleUpgrade(req, socket, head);
      } catch (err) {
        socket.destroy();
      }
      return;
    }

    socket.destroy();
  });

  return server;
}

function formatHostForUrl(host) {
  // Bare IPv6 literals need brackets inside a URL.
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err && err.isHelp) {
      process.stdout.write(
        "usage: node bin/server.js [--port N] [--host H] [--data-dir DIR]\n" +
          `  --port      listening port (default ${DEFAULT_PORT}; 0 = OS-assigned free port)\n` +
          `  --host      bind address (default ${DEFAULT_HOST})\n` +
          `  --data-dir  data directory (default ${DEFAULT_DATA_DIR})\n`
      );
      process.exit(0);
    }
    process.stderr.write(`[server] ${err.message}\n`);
    process.exit(1);
  }

  let hub;
  try {
    const { createHub } = require("../lib/stream.js");
    hub = createHub({ dataDir: options.dataDir, pollMs: 250 });
  } catch (err) {
    process.stderr.write(
      `[server] failed to create stream hub: ${err && err.message ? err.message : err}\n`
    );
    process.exit(1);
  }

  const server = createServer(hub);

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      process.stderr.write(
        `[server] port ${options.port} is already in use (EADDRINUSE); ` +
          "try --port 0 or a different port\n"
      );
    } else if (err && err.code === "EACCES") {
      process.stderr.write(
        `[server] permission denied binding ${options.host}:${options.port} (EACCES)\n`
      );
    } else {
      process.stderr.write(`[server] failed to start: ${err && err.message ? err.message : err}\n`);
    }
    try {
      if (hub && typeof hub.close === "function") hub.close();
    } catch {
      /* best effort */
    }
    process.exit(1);
  });

  server.listen(options.port, options.host, () => {
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : options.port;
    process.stdout.write(
      `[server] listening on http://${formatHostForUrl(options.host)}:${boundPort}/\n`
    );
    process.stdout.write(`[server] ws: /ws data: ${options.dataDir}\n`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();

    try {
      if (hub && typeof hub.close === "function") hub.close();
    } catch {
      /* best effort */
    }

    server.close(() => {
      clearTimeout(force);
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

if (require.main === module) {
  main();
}

module.exports = {
  createServer,
  parseArgs,
  resolveRequestPath,
  contentTypeFor,
  handleRequest,
  STATIC_ROOT,
  DEFAULT_DATA_DIR,
};
