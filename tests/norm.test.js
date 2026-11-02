"use strict";

// Stage-2 contract tests for lib/norm.js (spec §4.1, §9 row 2).
//
// Invocation: `node --test tests/norm.test.js` (or `npm test`, which globs
// tests/*.test.js). No dependencies outside node:test / node:assert.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeUrl,
  key,
  paramKey,
  resolveUrl,
  sameOrigin,
  originOf,
  hostOf,
} = require("../lib/norm.js");

// 1. Stage-2 criterion: the two spellings collapse to one key.
test("key normalises the criterion pair", () => {
  const fromRelative = key("//host/a?b=2&a=1");
  const fromAbsolute = key("https://host/a?a=1&b=2");

  assert.equal(fromRelative, fromAbsolute);
  assert.equal(fromRelative, "GET https://host/a?a=1&b=2");
  assert.equal(fromAbsolute, "GET https://host/a?a=1&b=2");
});

// 2. Default ports are dropped; non-default ports survive.
test("default ports are dropped", () => {
  assert.equal(normalizeUrl("http://h.test:80/x"), "http://h.test/x");
  assert.equal(normalizeUrl("https://h.test:443/x"), "https://h.test/x");
  assert.equal(normalizeUrl("https://h.test:8443/x"), "https://h.test:8443/x");
  assert.equal(normalizeUrl("HTTPS://H.TEST:443/A/"), "https://h.test/A");
});

// 3. index.html collapses to its directory root.
test("index.html collapses to directory root", () => {
  assert.equal(normalizeUrl("https://host/index.html"), "https://host/");
  assert.equal(normalizeUrl("https://host/dir/index.html"), "https://host/dir");
  assert.equal(
    normalizeUrl("https://host/dir/index.html?b=2&a=1"),
    "https://host/dir?a=1&b=2"
  );
});

// 4. Trailing slash and duplicate slashes.
test("trailing slash and duplicate slashes", () => {
  assert.equal(normalizeUrl("https://host/a/"), "https://host/a");
  assert.equal(normalizeUrl("https://host/a//b"), "https://host/a/b");
  assert.equal(normalizeUrl("https://host/"), "https://host/");
  assert.equal(normalizeUrl("https://host"), "https://host/");
});

// 5. Query sorted by name then value; duplicates kept; empty ? dropped.
test("query sorting and duplicates", () => {
  assert.equal(
    normalizeUrl("https://host/a?b=2&a=1&a=0"),
    "https://host/a?a=0&a=1&b=2"
  );
  assert.equal(normalizeUrl("https://host/a?"), "https://host/a");
  assert.equal(normalizeUrl("https://host/a?flag"), "https://host/a?flag");
});

// 6. Fragment is removed, including when combined with a query.
test("fragment removed", () => {
  assert.equal(normalizeUrl("https://host/a#x"), "https://host/a");
  assert.equal(normalizeUrl("https://host/a?b=2#x"), "https://host/a?b=2");
});

// 7. Dot segments are resolved.
test("dot segments resolved", () => {
  assert.equal(normalizeUrl("https://host/a/./b/../c"), "https://host/a/c");
  assert.equal(normalizeUrl("https://host/a/b/../../c"), "https://host/c");
  assert.equal(normalizeUrl("https://host/a/.."), "https://host/");
});

// 8. Non-http(s) schemes are rejected.
test("non-http schemes rejected", () => {
  const rejected = [
    "mailto:a@b.test",
    "javascript:alert(1)",
    "data:text/html,hi",
    "tel:+123456",
    "file:///etc/passwd",
    "ftp://host/x",
  ];
  for (const value of rejected) {
    assert.equal(normalizeUrl(value), null, value);
  }
});

// 9. Relative reference forms against a directory-like base.
test("resolveUrl relative forms", () => {
  const base = "http://site.test/dir/page.html";

  assert.equal(resolveUrl("../x", base), "http://site.test/x");
  assert.equal(resolveUrl("./y", base), "http://site.test/dir/y");
  assert.equal(resolveUrl("y", base), "http://site.test/dir/y");
  assert.equal(
    resolveUrl("?q=1", base),
    "http://site.test/dir/page.html?q=1"
  );
  assert.equal(resolveUrl("//cdn.test/z", base), "http://cdn.test/z");
  assert.equal(resolveUrl("/abs", base), "http://site.test/abs");
  assert.equal(resolveUrl("#frag", base), null);
  assert.equal(resolveUrl("mailto:a@b.test", base), null);

  // Protocol-relative default when no base is supplied.
  assert.equal(normalizeUrl("//cdn.test/z"), "https://cdn.test/z");
});

// 10. paramKey strips values and keeps sorted names only.
test("paramKey drops values", () => {
  assert.equal(
    paramKey("https://host/a?id=5&z=1"),
    "param:https://host/a?id&z"
  );
  assert.equal(
    paramKey("https://host/a?b=2&a=1"),
    "param:https://host/a?a&b"
  );
  assert.equal(paramKey("https://host/a"), null);
  assert.equal(paramKey("https://host/a?"), null);
});

// 11. Origin helpers, including default-port equivalence.
test("sameOrigin and originOf", () => {
  assert.equal(sameOrigin("https://a.test/x", "https://a.test:443/y"), true);
  assert.equal(sameOrigin("http://a.test:80/x", "http://a.test/y"), true);
  assert.equal(sameOrigin("http://a.test/x", "https://a.test/x"), false);
  assert.equal(sameOrigin("https://a.test:8443/x", "https://a.test/y"), false);
  assert.equal(sameOrigin("https://a.test/x", "https://b.test/x"), false);

  assert.equal(originOf("https://a.test:8443/x"), "https://a.test:8443");
  assert.equal(originOf("https://a.test:443/x"), "https://a.test");
  assert.equal(originOf("mailto:a@b.test"), null);

  assert.equal(hostOf("https://a.test:443/x"), "a.test");
  assert.equal(hostOf("http://a.test:8080/"), "a.test:8080");
  assert.equal(hostOf("tel:+1"), null);
});

// 12. Normalisation is idempotent on already-canonical input.
test("idempotent normalisation", () => {
  const urls = [
    "//host/a?b=2&a=1",
    "HTTPS://H.TEST/A?Z=1&A=2",
    "https://host/dir/index.html",
    "https://host/a/./b/../c?b=2&a=1&a=0",
    "http://host:80/x//y/#frag",
  ];
  for (const url of urls) {
    const once = normalizeUrl(url);
    assert.notEqual(once, null, url);
    assert.equal(normalizeUrl(once), once, url);
  }
});

// 13. Junk never throws; unparsable input is null.
test("never throws on junk", () => {
  const cases = [undefined, null, "", "   ", "http://", "https:///x"];
  for (const value of cases) {
    assert.doesNotThrow(() => normalizeUrl(value));
    assert.equal(normalizeUrl(value), null, String(value));
  }

  // Not junk: a valueless query param survives.
  assert.equal(normalizeUrl("https://h/a?b"), "https://h/a?b");

  // Unicode hosts are lowercased with toLowerCase (path case preserved).
  assert.equal(normalizeUrl("https://HÖST.test/A"), "https://höst.test/A");
});

// 14. Percent-encoding: hex uppercased, reserved characters not decoded.
test("percent-encoding hex uppercased, reserved kept encoded", () => {
  assert.equal(normalizeUrl("https://h/a%2fb?x=%2f"), "https://h/a%2Fb?x=%2F");
  // %2F must not turn into a path separator.
  assert.equal(normalizeUrl("https://h/a%2Fb").indexOf("%2F") >= 0, true);
});

// 15. Credentials never enter canonical URLs, keys, origins or labels.
test("userinfo is stripped from keys", () => {
  assert.equal(key("https://u:p@h.test/x"), "GET https://h.test/x");
  assert.equal(normalizeUrl("https://u:p@h.test/x"), "https://h.test/x");
  assert.equal(originOf("https://u:p@h.test/x"), "https://h.test");
  assert.equal(hostOf("https://u:p@h.test/x"), "h.test");
  assert.equal(originOf("https://u:p@h.test/x").includes("@"), false);
  assert.equal(hostOf("https://u:p@h.test/x").includes("@"), false);
  // paramKey shares the same normalisation path.
  assert.equal(
    paramKey("https://u:p@h.test/x?a=1"),
    "param:https://h.test/x?a"
  );
});

// 16. Host lowercasing is Unicode-aware (toLowerCase, not ASCII-only).
test("unicode host is lowercased", () => {
  assert.equal(
    normalizeUrl("https://HÖST.test/A"),
    normalizeUrl("https://höst.test/A")
  );
  // Path case must survive; only the host is lowercased.
  assert.equal(normalizeUrl("https://HÖST.test/A"), "https://höst.test/A");
});

// 17. A single trailing dot is not part of the canonical host.
test("trailing dot host is canonicalised", () => {
  assert.equal(normalizeUrl("https://host./x"), normalizeUrl("https://host/x"));
  assert.equal(normalizeUrl("https://host./x"), "https://host/x");
  // Exactly one dot is removed; a second dot remains (and is still a host).
  assert.equal(normalizeUrl("https://host../x"), "https://host./x");
});

// 18. IPv6 literals keep their bracketed form; no dot stripping inside.
test("ipv6 literal keeps its form", () => {
  assert.equal(normalizeUrl("http://[::1]:8080/x"), "http://[::1]:8080/x");
  assert.equal(normalizeUrl("http://[::1]:80/x"), "http://[::1]/x");
  assert.equal(hostOf("http://[::1]:8080/x"), "[::1]:8080");
  assert.equal(normalizeUrl("http://[::1]/x"), "http://[::1]/x");
});
