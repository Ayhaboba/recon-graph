"use strict";

// Reference fixture HTTP server for stages 3, 4 and 8.
//
//   node tests/site/server.js [--port 0] [--host 127.0.0.1]
//
// Prints "[fixture] listening on http://127.0.0.1:<port>/" and stays up.
// Unknown paths return a fixed soft-404 page with status 200 so the fuzzer
// can hash-compare it.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;

const SOFT_404 = Buffer.from(
  "<html><title>Not found</title><body><p>Nothing here.</p></body></html>\n",
  "utf8"
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function parseArgs(argv) {
  let port = 0;
  let host = "127.0.0.1";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") {
      port = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--host") {
      host = String(argv[i + 1]);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: node tests/site/server.js [--port 0] [--host 127.0.0.1]\n"
      );
      process.exit(0);
    } else {
      process.stderr.write(`[fixture] unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) port = 0;
  return { port, host };
}

function send(res, status, headers, body) {
  const payload = body === null || body === undefined ? null : body;
  const out = {
    "Cache-Control": "no-store",
    ...headers,
  };
  if (payload !== null) out["Content-Length"] = String(payload.length);
  res.writeHead(status, out);
  if (res.req && res.req.method === "HEAD") {
    res.end();
  } else if (payload !== null) {
    res.end(payload);
  } else {
    res.end();
  }
}

function sendText(req, res, status, text, type) {
  send(
    res,
    status,
    { "Content-Type": type || "text/plain; charset=utf-8" },
    Buffer.from(text, "utf8")
  );
}

function resolveRequestPath(rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch (_err) {
    return { error: 403 };
  }

  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    /(^|\/)\.\.(\/|$)/.test(decoded) ||
    rawPathname.includes("\0")
  ) {
    return { error: 403 };
  }

  let rel = decoded.replace(/^\/+/, "");
  if (rel === "") rel = "index.html";

  let full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    return { error: 403 };
  }

  let stat = null;
  try {
    stat = fs.statSync(full);
  } catch (_err) {
    stat = null;
  }

  if (stat && stat.isDirectory()) {
    full = path.join(full, "index.html");
    try {
      stat = fs.statSync(full);
    } catch (_err) {
      stat = null;
    }
    if (!stat || !stat.isFile()) return { error: 404 };
  }

  if (!stat && !path.extname(full)) {
    // /secret -> secret.html, a convenience the fixture promises.
    const withHtml = full + ".html";
    try {
      const htmlStat = fs.statSync(withHtml);
      if (htmlStat.isFile()) {
        full = withHtml;
        stat = htmlStat;
      }
    } catch (_err) {
      // keep the miss
    }
  }

  if (!stat || !stat.isFile()) return { error: 404 };
  return { file: full, size: stat.size };
}

function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(
      res,
      405,
      {
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8",
      },
      Buffer.from("Method Not Allowed\n", "utf8")
    );
    return;
  }

  const rawPathname = String(req.url || "/").split("?")[0].split("#")[0];
  let rawDecoded = rawPathname;
  try {
    rawDecoded = decodeURIComponent(rawPathname);
  } catch (_err) {
    sendText(req, res, 403, "Forbidden\n");
    return;
  }
  if (
    rawDecoded.includes("\0") ||
    rawDecoded.includes("\\") ||
    /(^|\/)\.\.(\/|$)/.test(rawDecoded)
  ) {
    sendText(req, res, 403, "Forbidden\n");
    return;
  }

  let parsed;
  try {
    parsed = new URL(req.url, "http://fixture.invalid");
  } catch (_err) {
    sendText(req, res, 400, "Bad Request\n");
    return;
  }

  const pathname = parsed.pathname;

  if (pathname === "/forbidden") {
    sendText(
      req,
      res,
      403,
      "<html><title>Forbidden</title><body><p>Forbidden.</p></body></html>\n",
      "text/html; charset=utf-8"
    );
    return;
  }
  if (pathname === "/missing-thing") {
    sendText(req, res, 404, "missing thing\n");
    return;
  }
  if (pathname === "/redirect-1") {
    send(res, 302, { Location: "/page4.html" }, Buffer.alloc(0));
    return;
  }
  if (pathname === "/redirect-2") {
    send(res, 301, { Location: "/redirect-1" }, Buffer.alloc(0));
    return;
  }

  const resolved = resolveRequestPath(pathname);
  if (resolved.error === 403) {
    sendText(req, res, 403, "Forbidden\n");
    return;
  }
  if (resolved.error === 404) {
    send(
      res,
      200,
      { "Content-Type": "text/html; charset=utf-8" },
      SOFT_404
    );
    return;
  }

  const type = MIME[path.extname(resolved.file).toLowerCase()] ||
    "application/octet-stream";

  // Stage 7 inspector fixture: one JSON node carries a custom header so the
  // headers table and generated curl command both have something to show.
  const extra =
    pathname === "/api/v1/status.json" ? { "X-Demo": "inspector" } : {};

  if (req.method === "HEAD") {
    send(
      res,
      200,
      { "Content-Type": type, "Content-Length": String(resolved.size), ...extra },
      null
    );
    return;
  }

  let body;
  try {
    body = fs.readFileSync(resolved.file);
  } catch (_err) {
    sendText(req, res, 403, "Forbidden\n");
    return;
  }

  send(res, 200, { "Content-Type": type, ...extra }, body);
}

function main() {
  const { port, host } = parseArgs(process.argv.slice(2));

  const server = http.createServer(handle);

  server.on("error", (err) => {
    process.stderr.write(`[fixture] server error: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    process.stdout.write(
      `[fixture] listening on http://${shownHost}:${addr.port}/\n`
    );
  });

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(0), 1000);
    timer.unref();
    server.close(() => process.exit(0));
    void signal;
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
