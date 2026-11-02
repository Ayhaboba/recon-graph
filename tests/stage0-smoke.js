"use strict";

/**
 * Stage 0 smoke test — CURRENT page reality, not the old demo.
 *
 * Usage: node tests/stage0-smoke.js
 * Exit codes: 0 = all checks pass, 1 = at least one FAIL.
 *
 * Vendored hashes are read from VENDOR.md at run time (the table is the single
 * source of truth; graph-view.js uses its documented patched hash).
 */

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WEB_ROOT = path.join(ROOT, "web");
const VENDOR_MD = path.join(ROOT, "VENDOR.md");

const VENDORED = [
  "graph-view.js",
  "shims.js",
  "sim.js",
  "pixi.min.js",
  "graph.css",
];

let pass = 0;
let fail = 0;

function recordPass(name) {
  pass += 1;
  console.log(`PASS ${name}`);
}

function recordFail(name, detail) {
  fail += 1;
  console.log(`FAIL ${name} — ${detail}`);
}

async function check(name, fn) {
  try {
    await fn();
    recordPass(name);
    return true;
  } catch (err) {
    recordFail(name, err && err.message ? err.message : String(err));
    return false;
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function exists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseVendorHashes(markdown) {
  const hashes = new Map();
  for (const line of markdown.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 8) continue;
    const fileCell = cells[0].replace(/`/g, "");
    if (!fileCell.startsWith("web/vendor/")) continue;
    const original = cells[3].replace(/`/g, "");
    const patched = cells[5].replace(/`/g, "");
    const expected = /^[0-9a-f]{64}$/.test(patched) ? patched : original;
    if (/^[0-9a-f]{64}$/.test(expected)) {
      hashes.set(path.basename(fileCell), expected);
    }
  }
  return hashes;
}

function rawRequest(port, pathWithQuery, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: pathWithQuery,
        headers: { Connection: "close" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

function startServer() {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, "bin", "server.js"), "--port", "0"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 1000).unref();
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, detail: `no listening line within 8s (stderr: ${stderr.trim() || "empty"})` });
    }, 8000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (settled) return;
      const match = stdout.match(/listening on (https?:\/\/[^\s]+)/);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      let port = 0;
      try {
        port = Number(new URL(match[1]).port);
      } catch {
        port = 0;
      }
      if (!port) {
        cleanup();
        resolve({ ok: false, detail: `could not parse port from "${match[1]}"` });
        return;
      }
      resolve({ ok: true, url: match[1], port, cleanup });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, detail: err.message });
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ok: false,
        detail: `server exited before listening (code=${code}, signal=${signal}, stderr: ${stderr.trim() || "empty"})`,
      });
    });
  });
}

async function main() {
  const vendorHashes = parseVendorHashes(await fsp.readFile(VENDOR_MD, "utf8"));

  await check("vendored-files-exist", async () => {
    const missing = [];
    for (const name of VENDORED) {
      const full = path.join(WEB_ROOT, "vendor", name);
      if (!(await exists(full))) missing.push(`web/vendor/${name}`);
    }
    if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  });

  await check("vendored-sha256-matches-VENDOR.md", async () => {
    const problems = [];
    for (const name of VENDORED) {
      const expected = vendorHashes.get(name);
      if (!expected) {
        problems.push(`${name}: no hash row in VENDOR.md`);
        continue;
      }
      const full = path.join(WEB_ROOT, "vendor", name);
      if (!(await exists(full))) {
        problems.push(`${name}: file missing`);
        continue;
      }
      const actual = sha256(await fsp.readFile(full));
      if (actual !== expected) {
        problems.push(`${name}: sha256=${actual} VENDOR.md=${expected}`);
      }
    }
    if (problems.length) throw new Error(problems.join("; "));
  });

  let server = null;
  try {
    server = await startServer();
  } catch (err) {
    server = { ok: false, detail: err.message };
  }

  const started = await check("server-start", async () => {
    if (!server.ok) throw new Error(server.detail);
  });

  if (!started) {
    recordFail("http-index-assets", "server did not start");
    recordFail("vendor-sim-content-type", "server did not start");
    recordFail("traversal-blocked", "server did not start");
    recordFail("404", "server did not start");
  } else {
    const port = server.port;
    const origin = `http://127.0.0.1:${port}`;

    await check("http-index-assets", async () => {
      const res = await fetch(`${origin}/`);
      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (res.status !== 200) throw new Error(`GET / -> ${res.status}`);
      if (!type.startsWith("text/html")) throw new Error(`content-type: ${type}`);
      const html = await res.text();
      const problems = [];
      for (const token of [
        "recon.js",
        "vendor/pixi.min.js",
        "vendor/shims.js",
        "vendor/graph-view.js",
        "search.js",
        "panel.js",
      ]) {
        if (!html.includes(token)) problems.push(`missing ${token}`);
      }
      // inspector.js is loaded by recon.js on demand; accept a direct tag or
      // the dynamic loader reference, and require the asset itself to exist.
      if (!html.includes("inspector.js")) {
        const recon = await fetch(`${origin}/recon.js`);
        const source = await recon.text();
        if (recon.status !== 200 || !source.includes("inspector.js")) {
          problems.push("page never references inspector.js");
        }
      }
      const inspector = await fetch(`${origin}/inspector.js`);
      if (inspector.status !== 200) problems.push(`inspector.js -> ${inspector.status}`);
      if (problems.length) throw new Error(problems.join("; "));
    });

    await check("vendor-sim-content-type", async () => {
      const res = await fetch(`${origin}/vendor/sim.js`);
      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (res.status !== 200) throw new Error(`GET /vendor/sim.js -> ${res.status}`);
      if (!type.startsWith("text/javascript")) throw new Error(`content-type: ${type}`);
      const body = await res.arrayBuffer();
      if (!body.byteLength) throw new Error("empty body");
    });

    await check("traversal-blocked", async () => {
      const attempts = [
        "/../package.json",
        "/vendor/../../package.json",
        "/%2e%2e/package.json",
        "/vendor/%2e%2e/%2e%2e/package.json",
      ];
      const bad = [];
      for (const attempt of attempts) {
        const res = await rawRequest(port, attempt);
        if (res.status === 200) bad.push(`${attempt} -> 200`);
        else if (![400, 403, 404].includes(res.status)) {
          bad.push(`${attempt} -> unexpected ${res.status}`);
        }
      }
      if (bad.length) throw new Error(bad.join("; "));
    });

    await check("404", async () => {
      const res = await fetch(`${origin}/definitely-not-here`);
      if (res.status !== 404) throw new Error(`status ${res.status}`);
      const type = (res.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("text/plain")) throw new Error(`content-type: ${type}`);
      const body = await res.text();
      if (!body.includes("not found: /definitely-not-here")) {
        throw new Error(`unexpected body: ${JSON.stringify(body)}`);
      }
    });
  }

  if (server && server.cleanup) server.cleanup();

  console.log(`SUMMARY pass=${pass} fail=${fail} total=${pass + fail}`);
  return fail === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`FAIL smoke-runner — ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
