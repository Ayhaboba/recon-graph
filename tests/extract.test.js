"use strict";

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HTML_DIR = path.join(__dirname, "fixtures", "html");
const JS_DIR = path.join(__dirname, "fixtures", "js");

const HTML_FIXTURES = ["attrs.html", "basic.html", "css.html", "flag.html", "nested.html"];
const JS_FIXTURES = ["bundle.js", "endpoints.js", "secrets.js"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Short retry only: a missing fixture must fail the suite, never stall it.
async function waitForFile(filePath, intervalMs = 5000, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (fs.existsSync(filePath)) return true;
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  return fs.existsSync(filePath);
}

function readHtml(name) {
  return fs.readFileSync(path.join(HTML_DIR, name), "utf8");
}

function readJs(name) {
  return fs.readFileSync(path.join(JS_DIR, name), "utf8");
}

let extract;

before(async () => {
  const required = [
    ...HTML_FIXTURES.map((name) => path.join(HTML_DIR, name)),
    ...JS_FIXTURES.map((name) => path.join(JS_DIR, name)),
    path.join(ROOT, "lib", "extract.js"),
    path.join(ROOT, "lib", "norm.js"),
  ];
  const missing = [];
  for (const filePath of required) {
    if (!(await waitForFile(filePath))) missing.push(path.relative(ROOT, filePath));
  }
  if (missing.length > 0) {
    throw new Error(`missing fixture(s) after retry: ${missing.join(", ")}`);
  }
  extract = require("../lib/extract.js");
});

test("fixture set is complete", () => {
  const htmlFiles = fs
    .readdirSync(HTML_DIR)
    .filter((name) => fs.statSync(path.join(HTML_DIR, name)).isFile())
    .sort();
  const jsFiles = fs
    .readdirSync(JS_DIR)
    .filter((name) => fs.statSync(path.join(JS_DIR, name)).isFile())
    .sort();

  assert.deepEqual(htmlFiles, [...HTML_FIXTURES].sort());
  assert.deepEqual(jsFiles, [...JS_FIXTURES].sort());
  assert.equal(htmlFiles.length, 5);
  assert.equal(jsFiles.length, 3);
});

test("basic.html extracts 13 links and the title", () => {
  const result = extract.extractHtml(readHtml("basic.html"), {
    baseUrl: "http://site.test/",
  });

  assert.equal(result.title, "Basic fixture");

  const urls = result.links.map((link) => link.url);
  const expected = [
    "http://site.test/css/app.css",
    "http://site.test/js/main.js",
    "http://site.test/refresh-target",
    "http://site.test/img/inline.png",
    "http://site.test/about",
    "https://other.test/x",
    "http://cdn.test/lib.js",
    "http://site.test/map",
    "http://site.test/img/logo.png",
    "http://site.test/img/logo@2x.png",
    "http://site.test/frame.html",
    "http://site.test/contact",
    "http://site.test/img/bg.png",
  ];

  assert.equal(urls.length, 13);
  for (const url of expected) assert.ok(urls.includes(url), `missing ${url}`);
});

test("basic.html excludes mailto javascript data and fragment-only", () => {
  const result = extract.extractHtml(readHtml("basic.html"), {
    baseUrl: "http://site.test/",
  });
  const urls = result.links.map((link) => link.url);

  for (const url of urls) {
    assert.ok(!/^mailto:/i.test(url), `mailto leaked: ${url}`);
    assert.ok(!/^javascript:/i.test(url), `javascript leaked: ${url}`);
    assert.ok(!/^data:/i.test(url), `data leaked: ${url}`);
    assert.ok(!url.includes("#"), `fragment leaked: ${url}`);
  }
  assert.ok(!urls.some((url) => url.includes("mailto")));
  assert.ok(!urls.some((url) => url.includes("javascript")));
  assert.ok(!urls.some((url) => url.includes("data:text")));
  assert.ok(!urls.includes("http://site.test/"));
});

test("nested.html resolves relative forms against a deep base", () => {
  const result = extract.extractHtml(readHtml("nested.html"), {
    baseUrl: "http://site.test/dir/page.html",
  });
  const urls = result.links.map((link) => link.url);

  assert.equal(result.title, "Nested");
  assert.equal(urls.length, 6);

  const expected = [
    "http://site.test/x",
    "http://site.test/dir/y",
    "http://site.test/dir/page.html?q=1",
    "http://site.test/root",
    // href is absolute https; the scheme must survive dot-segment resolution.
    "https://site.test/b",
    "http://site.test/dir/sub/page.html",
  ];
  for (const url of expected) assert.ok(urls.includes(url), `missing ${url}`);

  assert.ok(!urls.some((url) => url.includes("#frag")));
});

test("attrs.html dedupes equivalent URLs", () => {
  const result = extract.extractHtml(readHtml("attrs.html"), {
    baseUrl: "http://site.test/",
  });
  const urls = result.links.map((link) => link.url);

  assert.equal(urls.length, 5);

  const expected = [
    "http://site.test/a?a=1&b=2",
    "https://host.test/q?y=2&z=1",
    "http://host.test/",
    "http://site.test/",
    "http://site.test/a/b",
  ];
  for (const url of expected) assert.ok(urls.includes(url), `missing ${url}`);

  const aVariants = urls.filter((url) => url.includes("/a?"));
  assert.equal(aVariants.length, 1);
  assert.equal(aVariants[0], "http://site.test/a?a=1&b=2");
});

test("css.html resolves url() and @font-face relative to the stylesheet", () => {
  const result = extract.extractHtml(readHtml("css.html"), {
    baseUrl: "http://site.test/css/site.css",
  });
  const urls = result.links.map((link) => link.url);

  assert.equal(result.title, "Css");
  assert.equal(urls.length, 4);

  const expected = [
    "http://site.test/fonts/x.woff2",
    "http://site.test/img/bg.png",
    "https://cdn.test/i.svg",
    "http://site.test/css/site.css",
  ];
  for (const url of expected) assert.ok(urls.includes(url), `missing ${url}`);

  assert.equal(urls.filter((url) => url === "http://site.test/img/bg.png").length, 1);
  assert.ok(!urls.some((url) => url.startsWith("data:")));
});

test("flag.html extracts only the single link", () => {
  const result = extract.extractHtml(readHtml("flag.html"), {
    baseUrl: "http://site.test/",
  });

  assert.equal(result.title, "Findings");
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].url, "http://site.test/linked");
  assert.equal(result.links[0].tag, "a");
  assert.equal(result.links[0].attr, "href");
});

test("srcset keeps commas inside URLs and drops data URIs", () => {
  const html = [
    '<img srcset="https://cdn.test/a,b.png 1x, //cdn.test/c 2x">',
    '<img srcset="data:image/png;base64,AAA 1x, /ok.png 2x">',
  ].join("");
  const result = extract.extractHtml(html, { baseUrl: "http://site.test/" });
  const urls = result.links.map((link) => link.url);

  assert.deepEqual(urls, [
    "https://cdn.test/a,b.png",
    "http://cdn.test/c",
    "http://site.test/ok.png",
  ]);
  assert.ok(!urls.includes("http://site.test/b.png"));
  assert.ok(!urls.some((url) => url.includes("/AAA")));
});

test("<base> applies document-wide and the first one wins", () => {
  const html = '<a href="before"><base href="/sub/"><a href="after"><base href="/other/">';
  const result = extract.extractHtml(html, { baseUrl: "http://site.test/" });
  const urls = result.links.map((link) => link.url);

  assert.deepEqual(urls, [
    "http://site.test/sub/before",
    "http://site.test/sub/after",
  ]);
  assert.ok(!urls.some((url) => url.includes("/other/")));
});

test("unquoted attribute keeps a trailing slash", () => {
  const docBase = "http://site.test/dir/page.html";

  // `<base href=/sub/>`: the value is "/sub/" (the slash is part of the
  // unquoted value), so later relative links stay under /sub/.
  const first = extract.extractHtml("<base href=/sub/><a href=after>", {
    baseUrl: docBase,
  });
  assert.equal(first.base, "http://site.test/sub/");
  assert.deepEqual(
    first.links.map((link) => link.url),
    ["http://site.test/sub/after"],
  );

  const trailingSpace = extract.extractHtml("<base href=/sub/ ><a href=after>", {
    baseUrl: docBase,
  });
  assert.equal(trailingSpace.base, "http://site.test/sub/");
  assert.deepEqual(
    trailingSpace.links.map((link) => link.url),
    ["http://site.test/sub/after"],
  );

  // A space before "/>" makes it a real self-closing marker: value "/sub".
  const marker = extract.extractHtml("<base href=/sub /><a href=after>", {
    baseUrl: docBase,
  });
  assert.equal(marker.base, "http://site.test/sub");
  assert.deepEqual(
    marker.links.map((link) => link.url),
    ["http://site.test/after"],
  );

  // Unquoted link value "/x/" normalises to /x; the self-closing marker does
  // not leak into the base or the link.
  const link = extract.extractHtml("<base href=/sub/><a href=/x/>", {
    baseUrl: docBase,
  });
  assert.equal(link.base, "http://site.test/sub/");
  assert.deepEqual(
    link.links.map((l) => l.url),
    ["http://site.test/x"],
  );
});

test("postfix increment then division keeps later links", () => {
  for (const expression of ["a++ / 2", "a-- / 2"]) {
    const source = `var b=${expression}; var api="/api/v1/real";`;
    const urls = extract
      .extractJs(source, { baseUrl: "http://site.test/" })
      .links.map((link) => link.url);
    assert.deepEqual(urls, ["http://site.test/api/v1/real"], expression);
  }
});

test("contextual keyword before division keeps later links", () => {
  for (const source of [
    'var of=1; of / 2; var api="/api/v1/real";',
    'x.return / 2; var api="/api/v1/real";',
  ]) {
    const urls = extract
      .extractJs(source, { baseUrl: "http://site.test/" })
      .links.map((link) => link.url);
    assert.deepEqual(urls, ["http://site.test/api/v1/real"], source);
  }
});

test("regex in statement position after if is not a link", () => {
  const source =
    'if (x) /"\\/api\\/v1\\/fake"/.test(y); var api = "/api/v1/real";';
  const urls = extract
    .extractJs(source, { baseUrl: "http://site.test/" })
    .links.map((link) => link.url);

  assert.deepEqual(urls, ["http://site.test/api/v1/real"]);
  assert.ok(!urls.some((url) => url.includes("/api/v1/fake")));
});

test("form empty action resolves to the document URL; poster keeps its attr", () => {
  const html = '<form action=""></form><video poster="/thumb.jpg"></video>';
  const result = extract.extractHtml(html, {
    baseUrl: "http://site.test/dir/page.html",
  });

  const form = result.links.find((link) => link.tag === "form");
  const video = result.links.find((link) => link.tag === "video");

  assert.equal(form.url, "http://site.test/dir/page.html");
  assert.equal(form.attr, "action");
  assert.equal(video.url, "http://site.test/thumb.jpg");
  assert.equal(video.attr, "poster");
});

test("extractJs finds static path literals with an exact set", () => {
  const endpoints = extract.extractJs(readJs("endpoints.js"), {
    baseUrl: "http://site.test/",
  });
  const urls = endpoints.links.map((link) => link.url);

  assert.deepEqual(urls, [
    "http://site.test/api/v1/users",
    "http://site.test/api/v1/admin",
    "http://site.test/api/v1/login",
    "https://api.test/v1/x",
    "http://site.test/static/app.4f2c.js",
    "http://site.test/api/v3",
  ]);
  assert.ok(!urls.some((url) => url.includes("not-a-path")));
  assert.equal(urls.filter((url) => url === "http://site.test/api/v1/users").length, 1);

  const bundle = extract.extractJs(readJs("bundle.js"), {
    baseUrl: "http://site.test/",
  });
  const bundleUrls = bundle.links.map((link) => link.url);
  assert.deepEqual(bundleUrls, ["http://site.test/api/v2/orders"]);
});

test("extractJs skips regex literals and keeps the following string", () => {
  const source = 'var re = /<a href="([^"]+)"/g; var api = "/api/v1/users";';
  const result = extract.extractJs(source, { baseUrl: "http://site.test/" });
  const urls = result.links.map((link) => link.url);

  assert.deepEqual(urls, ["http://site.test/api/v1/users"]);
});

test("extractJs decodes string escapes before path matching", () => {
  const source = [
    'var a = "\\u002fapi\\u002fv1\\u002fusers";',
    'var b = "\\x2fapi\\x2fv1\\x2fadmin";',
    'var c = "/api\\n/x";',
  ].join("\n");
  const result = extract.extractJs(source, { baseUrl: "http://site.test/" });
  const urls = result.links.map((link) => link.url);

  assert.deepEqual(urls, [
    "http://site.test/api/v1/users",
    "http://site.test/api/v1/admin",
  ]);
  assert.ok(!urls.some((url) => url.includes("apin")));
  assert.ok(!urls.includes("http://site.test/api/x"));
});

test("extractJs ignores non-path literals and interpolated templates", () => {
  const source = [
    'const a = "/api/v1/users";',
    "const b = '/api/v1/users';",
    "const c = `/api/${id}/detail`;",
    "const d = `/static/${ver}/app.js`;",
    'const e = "not-a-path";',
    'const f = "x";',
    'const g = "http://other.test/p?q=1";',
    'const h = "relative/page.html";',
  ].join("\n");

  const result = extract.extractJs(source, { baseUrl: "http://site.test/" });
  const urls = result.links.map((link) => link.url);

  assert.equal(urls.filter((url) => url === "http://site.test/api/v1/users").length, 1);
  assert.ok(urls.includes("http://site.test/api"));
  assert.ok(urls.includes("http://site.test/static"));
  assert.ok(urls.includes("http://other.test/p?q=1"));

  assert.ok(!urls.some((url) => url.includes("${")));
  assert.ok(!urls.some((url) => url.includes("not-a-path")));
  // A bare relative path with a slash in it is not one of the accepted shapes.
  assert.ok(!urls.some((url) => url.includes("relative/page.html")));
});

test("extractSitemap and extractRobots", () => {
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<urlset>",
    "<url><loc>https://site.test/one</loc></url>",
    "<url><loc> https://site.test/two?a=2&amp;b=1 </loc></url>",
    "</urlset>",
  ].join("\n");

  const sitemapResult = extract.extractSitemap(sitemap, {
    baseUrl: "https://site.test/",
  });
  const sitemapUrls = sitemapResult.links.map((link) => link.url);
  assert.deepEqual(sitemapUrls, [
    "https://site.test/one",
    "https://site.test/two?a=2&b=1",
  ]);

  const robots = [
    "User-agent: *",
    "Disallow: /private",
    "Sitemap: https://site.test/sitemap.xml",
    "Sitemap: /sitemap2.xml",
  ].join("\n");

  const robotsResult = extract.extractRobots(robots, {
    baseUrl: "https://site.test/",
  });
  const robotsUrls = robotsResult.links.map((link) => link.url);
  assert.deepEqual(robotsUrls, [
    "https://site.test/sitemap.xml",
    "https://site.test/sitemap2.xml",
  ]);
  assert.ok(!robotsUrls.some((url) => url.includes("/private")));
});

test("malformed html does not throw", () => {
  const inputs = [
    '<html><body><a href=',
    '<div><a href="/x">unclosed <span',
    "<div>".repeat(40000),
    "<div".repeat(40000),
    '<a href="/ok">a</a><script>var s = "<div>";</script><a href="',
  ];

  for (const input of inputs) {
    let result;
    assert.doesNotThrow(() => {
      result = extract.extractHtml(input, { baseUrl: "http://site.test/" });
    });
    assert.ok(result && Array.isArray(result.links));
  }

  const truncated = extract.extractHtml(inputs[1], { baseUrl: "http://site.test/" });
  assert.ok(truncated.links.some((link) => link.url === "http://site.test/x"));
});
