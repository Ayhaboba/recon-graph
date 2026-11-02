"use strict";

/**
 * recon-graph URL normalisation (spec §4.1, stage 2).
 *
 * Zero dependencies, no `new URL()` and no URL polyfill: canonicalisation is
 * hand-rolled so the same input always yields the same key, on every Node
 * build. Only http(s) URLs are fetchable; everything else normalises to null.
 *
 * Canonical shape:
 *   <scheme>://<host>[:port]<path>[?<query>]
 *
 * Rules (spec §4.1):
 *  - userinfo discarded (credentials never enter keys or labels);
 *  - scheme lowercased, host lowercased (Unicode-aware), one trailing dot
 *    stripped from the host, default ports dropped;
 *  - trailing slash removed except at root, duplicate slashes collapsed;
 *  - `.` / `..` segments resolved, `index.html` collapsed to its directory;
 *  - query params sorted by name then value, duplicates preserved;
 *  - fragment dropped, empty `?` dropped;
 *  - percent-encoding kept, hex digits uppercased (never decoded).
 *
 * Scheme-less (protocol-relative, `//host/path`) input defaults to https.
 */

var DEFAULT_PORTS = { http: "80", https: "443" };
var SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;
var HOST_BAD_RE = /[\u0000-\u0020\u007f<>{}|\\^`"/?#@:]/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clean(value) {
  if (typeof value !== "string") return "";
  // Tabs/CR/LF are stripped by browsers before parsing; trim the edges.
  return value.replace(/[\t\r\n]/g, "").trim();
}

// Lowercase ASCII letters only: used for schemes, which are ASCII by grammar.
function asciiLower(value) {
  return value.replace(/[A-Z]/g, function (ch) {
    return ch.toLowerCase();
  });
}

// Uppercase percent-encoding hex digits without decoding anything.
function upperHex(value) {
  return value.replace(/%([0-9a-fA-F]{2})/g, function (_, hex) {
    return "%" + hex.toUpperCase();
  });
}

function hostIsValid(host) {
  if (!host || host === "." || host === "..") return false;
  if (host.charAt(0) === "[") {
    return /^\[[0-9a-fA-F:.]+\]$/.test(host);
  }
  if (host.indexOf("[") >= 0 || host.indexOf("]") >= 0) return false;
  return !HOST_BAD_RE.test(host);
}

// Split an authority into host / port. Userinfo is parsed only to discard it:
// credentials never enter canonical URLs, keys, origins or labels.
function splitAuthority(authority) {
  var at = authority.lastIndexOf("@");
  if (at >= 0) {
    authority = authority.slice(at + 1);
  }

  var host;
  var port = null;

  if (authority.charAt(0) === "[") {
    // IPv6 literal; the colon inside brackets is not a port separator.
    var close = authority.indexOf("]");
    if (close < 0) return null;
    host = authority.slice(0, close + 1);
    var tail = authority.slice(close + 1);
    if (tail) {
      if (tail.charAt(0) !== ":") return null;
      port = tail.slice(1);
    }
  } else {
    var colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      port = authority.slice(colon + 1);
      host = authority.slice(0, colon);
      if (!/^[0-9]*$/.test(port)) return null;
    } else {
      host = authority;
    }
  }

  if (port === "") port = null;
  if (port !== null) {
    var numeric = parseInt(port, 10);
    if (!isFinite(numeric) || numeric < 0 || numeric > 65535) return null;
    port = String(numeric);
  }

  host = host.toLowerCase();
  // Strip exactly one trailing dot from a non-bracketed host ("host." ->
  // "host"); IPv6 literals keep their bracketed form untouched.
  if (host.charAt(0) !== "[" && host.charAt(host.length - 1) === ".") {
    host = host.slice(0, -1);
  }
  if (!hostIsValid(host)) return null;

  return { host: host, port: port };
}

// Canonical path: dot segments, // collapse, trailing slash, index.html.
function normalizePath(rawPath) {
  var path = rawPath || "/";
  var segments = path.split("/");
  var out = [];

  for (var i = 0; i < segments.length; i++) {
    var segment = segments[i];
    if (segment === ".") continue;
    if (segment === "..") {
      // Keep the leading empty segment that represents the root.
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(segment);
  }

  var joined = out.join("/");
  if (joined.charAt(0) !== "/") joined = "/" + joined;
  joined = joined.replace(/\/{2,}/g, "/");

  if (joined.length > 1 && joined.charAt(joined.length - 1) === "/") {
    joined = joined.replace(/\/+$/, "");
  }
  if (joined === "") joined = "/";

  if (joined === "/index.html") {
    joined = "/";
  } else if (
    joined.length > "/index.html".length &&
    joined.slice(-"/index.html".length) === "/index.html"
  ) {
    joined = joined.slice(0, -"/index.html".length);
  }

  return upperHex(joined);
}

// Canonical query: sort by name then value, keep duplicates, drop empties.
function normalizeQuery(rawQuery) {
  if (rawQuery === null || rawQuery === undefined || rawQuery === "") {
    return null;
  }

  var parts = rawQuery.split("&");
  var pairs = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part === "") continue;

    var eq = part.indexOf("=");
    if (eq >= 0) {
      pairs.push({
        name: upperHex(part.slice(0, eq)),
        value: upperHex(part.slice(eq + 1)),
      });
    } else {
      pairs.push({ name: upperHex(part), value: null });
    }
  }

  if (pairs.length === 0) return null;

  pairs.sort(function (a, b) {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    var av = a.value === null ? "" : a.value;
    var bv = b.value === null ? "" : b.value;
    if (av !== bv) return av < bv ? -1 : 1;
    return 0;
  });

  var encoded = [];
  for (var j = 0; j < pairs.length; j++) {
    encoded.push(
      pairs[j].value === null
        ? pairs[j].name
        : pairs[j].name + "=" + pairs[j].value
    );
  }
  return encoded.join("&");
}

// Build a canonical absolute URL from scheme + "<authority><path>?<query>".
function normaliseAbsolute(scheme, rest) {
  var hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);

  var question = rest.indexOf("?");
  var rawQuery = null;
  if (question >= 0) {
    rawQuery = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }

  var slash = rest.indexOf("/");
  var authority = slash >= 0 ? rest.slice(0, slash) : rest;
  var rawPath = slash >= 0 ? rest.slice(slash) : "";

  var parts = splitAuthority(authority);
  if (!parts) return null;

  var path = normalizePath(rawPath);
  var query = normalizeQuery(rawQuery);

  var result = scheme + "://" + parts.host;
  if (parts.port !== null && parts.port !== DEFAULT_PORTS[scheme]) {
    result += ":" + parts.port;
  }
  result += path;
  if (query !== null) result += "?" + query;
  return result;
}

// Scheme to inherit for protocol-relative references.
function protoScheme(base) {
  if (typeof base !== "string") return "https";
  var match = SCHEME_RE.exec(clean(base));
  if (!match) return "https";
  var scheme = asciiLower(match[1]);
  return scheme === "http" || scheme === "https" ? scheme : "https";
}

// Parse a base for relative resolution without normalising its path: the
// trailing-slash distinction ("/dir/" vs "/dir") decides how refs merge.
function parseBase(base) {
  if (typeof base !== "string") return null;
  var raw = clean(base);
  if (!raw) return null;

  var match = SCHEME_RE.exec(raw);
  if (!match) return null;

  var scheme = asciiLower(match[1]);
  if (scheme !== "http" && scheme !== "https") return null;

  var rest = raw.slice(match[0].length);
  if (rest.slice(0, 2) !== "//") return null;
  rest = rest.slice(2);

  var hash = rest.indexOf("#");
  if (hash >= 0) rest = rest.slice(0, hash);
  var question = rest.indexOf("?");
  if (question >= 0) rest = rest.slice(0, question);

  var slash = rest.indexOf("/");
  var authority = slash >= 0 ? rest.slice(0, slash) : rest;
  var path = slash >= 0 ? rest.slice(slash) : "/";
  if (!authority) return null;

  return { scheme: scheme, authority: authority, path: path };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function normalizeUrl(url, base) {
  try {
    if (typeof url !== "string") return null;
    var raw = clean(url);
    if (!raw) return null;
    if (raw.charAt(0) === "#") return null;

    var match = SCHEME_RE.exec(raw);
    if (match) {
      var scheme = asciiLower(match[1]);
      if (scheme !== "http" && scheme !== "https") return null;
      var rest = raw.slice(match[0].length);
      if (rest.slice(0, 2) !== "//") return null;
      return normaliseAbsolute(scheme, rest.slice(2));
    }

    // Protocol-relative: inherit the base scheme, or default to https.
    if (raw.slice(0, 2) === "//") {
      return normaliseAbsolute(protoScheme(base), raw.slice(2));
    }

    // Relative reference: resolvable only against an absolute http(s) base.
    if (base === null || base === undefined) return null;
    return resolveUrl(raw, base);
  } catch (err) {
    return null;
  }
}

function resolveUrl(href, base) {
  try {
    if (typeof href !== "string") return null;
    var ref = clean(href);
    if (!ref) return null;
    if (ref.charAt(0) === "#") return null;

    var match = SCHEME_RE.exec(ref);
    if (match) {
      var scheme = asciiLower(match[1]);
      if (scheme !== "http" && scheme !== "https") return null;
      return normalizeUrl(ref);
    }

    if (ref.slice(0, 2) === "//") {
      return normalizeUrl(protoScheme(base) + ":" + ref);
    }

    if (base === null || base === undefined) return null;
    var parsed = parseBase(base);
    if (!parsed) return null;

    var hash = ref.indexOf("#");
    if (hash >= 0) ref = ref.slice(0, hash);

    var question = ref.indexOf("?");
    var query = null;
    var refPath = ref;
    if (question >= 0) {
      query = ref.slice(question + 1);
      refPath = ref.slice(0, question);
    }

    var targetPath;
    if (question === 0) {
      targetPath = parsed.path;
    } else if (refPath.charAt(0) === "/") {
      targetPath = refPath;
    } else {
      var dir = parsed.path.slice(0, parsed.path.lastIndexOf("/") + 1);
      targetPath = dir + refPath;
    }

    var assembled = parsed.scheme + "://" + parsed.authority + targetPath;
    if (query !== null) assembled += "?" + query;
    return normalizeUrl(assembled);
  } catch (err) {
    return null;
  }
}

function key(url, method) {
  var verb = method === null || method === undefined ? "GET" : String(method);
  verb = verb.trim();
  if (!verb) verb = "GET";
  verb = verb.toUpperCase();

  var normalized = normalizeUrl(url);
  if (normalized === null) return null;
  return verb + " " + normalized;
}

function paramKey(url) {
  var normalized = normalizeUrl(url);
  if (normalized === null) return null;

  var question = normalized.indexOf("?");
  if (question < 0) return null;

  var basePart = normalized.slice(0, question);
  var query = normalized.slice(question + 1);
  if (!query) return null;

  var parts = query.split("&");
  var names = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === "") continue;
    var eq = parts[i].indexOf("=");
    names.push(eq >= 0 ? parts[i].slice(0, eq) : parts[i]);
  }
  if (names.length === 0) return null;

  // normalizeQuery already sorted by name; dropping values keeps names sorted.
  return "param:" + basePart + "?" + names.join("&");
}

function originOf(url) {
  var normalized = normalizeUrl(url);
  if (normalized === null) return null;

  var marker = normalized.indexOf("://");
  if (marker < 0) return null;

  var scheme = normalized.slice(0, marker);
  var rest = normalized.slice(marker + 3);
  var slash = rest.indexOf("/");
  var authority = slash >= 0 ? rest.slice(0, slash) : rest;

  var at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);

  return scheme + "://" + authority;
}

function hostOf(url) {
  var origin = originOf(url);
  if (origin === null) return null;
  return origin.slice(origin.indexOf("://") + 3);
}

function sameOrigin(a, b) {
  var left = originOf(a);
  var right = originOf(b);
  if (left === null || right === null) return false;
  return left === right;
}

module.exports = {
  normalizeUrl: normalizeUrl,
  key: key,
  paramKey: paramKey,
  resolveUrl: resolveUrl,
  sameOrigin: sameOrigin,
  originOf: originOf,
  hostOf: hostOf,
};
