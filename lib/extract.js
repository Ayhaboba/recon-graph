"use strict";

// Regex-based, dependency-free link extraction. Nothing here executes
// discovered JavaScript; strings are copied, never evaluated.

const norm = require("./norm");

const MAX_LINKS = 5000;

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

function decodeEntities(input) {
  if (typeof input !== "string" || input.indexOf("&") === -1) return input;
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35) {
      // numeric reference
      let code;
      if (body[1] === "x" || body[1] === "X") code = parseInt(body.slice(2), 16);
      else code = parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch (_) {
        return whole;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
      ? NAMED_ENTITIES[key]
      : whole;
  });
}

function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function createSink() {
  const seen = new Set();
  const links = [];
  return {
    links,
    add(url, raw, tag, attr) {
      if (!url || typeof url !== "string") return;
      if (seen.has(url)) return;
      if (links.length >= MAX_LINKS) return;
      seen.add(url);
      links.push({
        url,
        raw: raw === undefined || raw === null ? "" : String(raw),
        tag,
        attr,
      });
    },
  };
}

// Resolve one raw attribute value. Raw stays as written; only the copy that
// goes into resolveUrl is entity-decoded.
function addCandidate(sink, rawValue, base, tag, attr, displayRaw) {
  if (rawValue === undefined || rawValue === null) return;
  const decoded = decodeEntities(String(rawValue)).trim();
  if (!decoded) return;
  const url = norm.resolveUrl(decoded, base);
  if (!url) return;
  sink.add(url, displayRaw === undefined ? String(rawValue) : displayRaw, tag, attr);
}

const ATTR_RE = /([^\s"'=<>`\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(source) {
  const attrs = Object.create(null);
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source)) !== null) {
    const name = m[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attrs, name)) continue;
    let value = "";
    if (m[2] !== undefined) value = m[2];
    else if (m[3] !== undefined) value = m[3];
    else if (m[4] !== undefined) value = m[4];
    attrs[name] = value;
  }
  return attrs;
}

function isSpaceCode(code) {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

// Linear scans instead of lazy regexes: an unclosed url( / @import must not
// turn into quadratic backtracking on a multi-megabyte stylesheet.
function eachCssUrl(css, lower, cb) {
  const n = css.length;
  let from = 0;
  while (from < n) {
    const at = lower.indexOf("url(", from);
    if (at === -1) break;
    let p = at + 4;
    while (p < n && isSpaceCode(css.charCodeAt(p))) p++;
    if (p >= n) break;

    const quote = css.charCodeAt(p);
    if (quote === 34 || quote === 39) {
      const close = css.indexOf(css[p], p + 1);
      if (close === -1) break; // unclosed quote: nothing further is usable
      let after = close + 1;
      while (after < n && isSpaceCode(css.charCodeAt(after))) after++;
      if (after >= n || css.charCodeAt(after) !== 41) {
        from = at + 4;
        continue;
      }
      cb(css.slice(p + 1, close), at);
      from = after + 1;
    } else {
      const close = css.indexOf(")", p);
      if (close === -1) break; // unclosed url(: stop instead of rescanning
      cb(css.slice(p, close), at);
      from = close + 1;
    }
  }
}

function eachCssImport(css, lower, cb) {
  const n = css.length;
  let from = 0;
  while (from < n) {
    const at = lower.indexOf("@import", from);
    if (at === -1) break;
    let p = at + 7;
    while (p < n && isSpaceCode(css.charCodeAt(p))) p++;

    if (lower.startsWith("url(", p)) {
      p += 4;
      while (p < n && isSpaceCode(css.charCodeAt(p))) p++;
    }

    if (p >= n) break;
    const quote = css.charCodeAt(p);
    if (quote !== 34 && quote !== 39) {
      from = at + 7;
      continue;
    }
    const close = css.indexOf(css[p], p + 1);
    if (close === -1) break;
    cb(css.slice(p + 1, close), at);
    from = close + 1;
  }
}

function cssRefs(css, base, sink, tag) {
  if (typeof css !== "string" || css.length === 0) return;
  const lower = css.toLowerCase();
  eachCssUrl(css, lower, (value) => {
    const trimmed = value.trim();
    if (trimmed) addCandidate(sink, trimmed, base, tag, "css", value);
  });
  eachCssImport(css, lower, (value) => {
    const trimmed = value.trim();
    if (trimmed) addCandidate(sink, trimmed, base, tag, "css", value);
  });
}

// HTML "parse a srcset attribute": a candidate is a URL run of non-whitespace
// (commas are valid inside URLs and data: URIs), optional descriptors follow
// until the next comma. Empty/comma-only segments are skipped. A URL with a
// trailing comma carries no descriptor list.
function srcsetRefs(value, base, sink, tag) {
  if (typeof value !== "string" || value.length === 0) return;
  const n = value.length;
  let i = 0;

  while (i < n) {
    while (i < n) {
      const c = value.charCodeAt(i);
      if (c === 44 || isSpaceCode(c)) i++;
      else break;
    }
    if (i >= n) break;

    const start = i;
    while (i < n && !isSpaceCode(value.charCodeAt(i))) i++;
    let token = value.slice(start, i);

    // A trailing comma ends the candidate here: descriptors are optional.
    if (token.endsWith(",")) {
      token = token.replace(/,+$/, "");
      if (token) addCandidate(sink, token, base, tag, "srcset", value);
      continue;
    }

    if (token) addCandidate(sink, token, base, tag, "srcset", value);
    // Skip the descriptor list ("1x", "100w", ...) up to the next comma.
    while (i < n && value.charCodeAt(i) !== 44) i++;
  }
}

const REFRESH_RE = /(?:^|[;\s])url\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/i;

function refreshTarget(content) {
  if (typeof content !== "string") return null;
  const m = REFRESH_RE.exec(content);
  if (!m) return null;
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  return m[3];
}

function extractTitle(html, lower) {
  let from = 0;
  while (from < lower.length) {
    const start = lower.indexOf("<title", from);
    if (start === -1) return null;
    const boundary = lower[start + 6];
    if (
      boundary === ">" ||
      boundary === " " ||
      boundary === "\t" ||
      boundary === "\n" ||
      boundary === "\r" ||
      boundary === "/"
    ) {
      const gt = html.indexOf(">", start + 6);
      if (gt === -1) return null;
      const close = lower.indexOf("</title", gt + 1);
      if (close === -1) return null;
      return collapseWhitespace(decodeEntities(html.slice(gt + 1, close)));
    }
    from = start + 6;
  }
  return null;
}

function findTagEnd(source, from) {
  // Returns index of the '>' that closes a tag starting at `from`, honouring
  // quoted attribute values. -1 when the document is truncated.
  let quote = 0;
  for (let i = from; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (quote !== 0) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    }
  }
  return -1;
}

function skipPast(closeTagIndex, source) {
  const gt = source.indexOf(">", closeTagIndex);
  return gt === -1 ? source.length : gt + 1;
}

// A trailing "/" in the raw tag body is the self-closing marker only when it
// is separated from the attribute tokens by whitespace or a closing quote
// (<img src=x />, <img src="x"/>). In <base href=/sub/> the "/" is part of
// the unquoted value "/sub/" (HTML tokenizer: unquoted attribute value state
// consumes it), and that slash must survive for later relative resolution.
function splitSelfClosing(rest) {
  if (!rest.endsWith("/")) return { rest, selfClosing: false };
  if (rest.length === 1) return { rest: "", selfClosing: true };
  const before = rest.charCodeAt(rest.length - 2);
  if (isSpaceCode(before) || before === 34 || before === 39) {
    return { rest: rest.slice(0, -1), selfClosing: true };
  }
  return { rest, selfClosing: false };
}

function addSrcset(sink, value, base, tag) {
  srcsetRefs(value, base, sink, tag);
}

// norm.resolveUrl canonicalises away a base's trailing slash; for <base href>
// the slash (or a trailing index.html / dot segment) still decides how child
// references merge, so preserve the directory form for subsequent links.
function directoryBase(resolved, rawHref) {
  if (!resolved) return resolved;
  const raw = typeof rawHref === "string" ? rawHref.trim() : "";
  const pathOnly = raw.split(/[?#]/)[0];
  const last = pathOnly.slice(pathOnly.lastIndexOf("/") + 1).toLowerCase();
  const isDirectory =
    pathOnly.endsWith("/") ||
    last === "" ||
    last === "." ||
    last === ".." ||
    last === "index.html";
  if (!isDirectory) return resolved;

  const mark = resolved.search(/[?#]/);
  const head = mark === -1 ? resolved : resolved.slice(0, mark);
  const tail = mark === -1 ? "" : resolved.slice(mark);
  if (head.endsWith("/")) return resolved;
  return head + "/" + tail;
}

// Document-wide first `<base href>`: the HTML parser uses the first base
// element with an href for every link in the document, including links that
// appear before it. A second <base> never overrides the first.
function firstBaseHref(html, lower) {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) return null;

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }

    const marker = html.charCodeAt(lt + 1);
    if (marker === 33 || marker === 63) {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    const gt = findTagEnd(html, lt + 1);
    if (gt === -1) return null;
    const inner = html.slice(lt + 1, gt);
    i = gt + 1;
    if (!inner || inner.charCodeAt(0) === 47) continue;

    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(inner);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();

    // Markup-looking text inside script/style does not create base elements.
    if (name === "script" || name === "style") {
      const close = lower.indexOf("</" + name, i);
      i = close === -1 ? n : skipPast(close, lower);
      continue;
    }

    if (name !== "base") continue;
    const rest = splitSelfClosing(inner.slice(nameMatch[1].length)).rest;
    const attrs = parseAttrs(rest);
    if (attrs.href === undefined) continue;
    return attrs.href;
  }
  return null;
}

function extractHtml(html, opts) {
  const out = { title: null, base: null, links: [] };
  try {
    if (typeof html !== "string") return out;
    const optsBase = opts && typeof opts.baseUrl === "string" ? opts.baseUrl : null;
    const lower = html.toLowerCase();
    out.title = extractTitle(html, lower);

    // Pass 1: resolve the document base before scanning any links.
    let base = optsBase;
    const rawBaseTag = firstBaseHref(html, lower);
    if (rawBaseTag !== null) {
      const rawBase = decodeEntities(rawBaseTag).trim();
      if (!rawBase) {
        // <base href=""> is the document URL itself.
        base = optsBase;
      } else {
        const resolved = norm.resolveUrl(rawBase, optsBase);
        if (resolved) base = directoryBase(resolved, rawBase);
      }
    }

    const sink = createSink();
    const n = html.length;
    let i = 0;

    while (i < n) {
      const lt = html.indexOf("<", i);
      if (lt === -1) break;

      if (html.startsWith("<!--", lt)) {
        const end = html.indexOf("-->", lt + 4);
        i = end === -1 ? n : end + 3;
        continue;
      }

      const marker = html.charCodeAt(lt + 1);
      if (marker === 33 || marker === 63) {
        // <!doctype ...>, <![CDATA[...]]>, <?xml ...>
        const end = html.indexOf(">", lt + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }

      const gt = findTagEnd(html, lt + 1);
      if (gt === -1) break; // truncated tag: stop, keep what we parsed

      const inner = html.slice(lt + 1, gt);
      i = gt + 1;
      if (!inner) continue;
      if (inner.charCodeAt(0) === 47) continue; // closing tag
      if (inner.charCodeAt(0) === 33) continue; // <![CDATA[

      const nameMatch = /^([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(inner);
      if (!nameMatch) continue;
      const name = nameMatch[1].toLowerCase();
      const split = splitSelfClosing(inner.slice(nameMatch[1].length));
      const rest = split.rest;
      const selfClosing = split.selfClosing;
      const attrs = parseAttrs(rest);

      if (name === "style" && !selfClosing) {
        const close = lower.indexOf("</style", i);
        const contentEnd = close === -1 ? n : close;
        cssRefs(html.slice(i, contentEnd), base, sink, "style");
        i = close === -1 ? n : skipPast(close, lower);
        continue;
      }

      if (name === "script") {
        if (attrs.src !== undefined) addCandidate(sink, attrs.src, base, "script", "src");
        if (!selfClosing) {
          const close = lower.indexOf("</script", i);
          i = close === -1 ? n : skipPast(close, lower);
        }
        continue;
      }

      if (name === "base") continue; // already resolved in the first pass

      if (attrs.style !== undefined) cssRefs(attrs.style, base, sink, name);

      if (name === "a" || name === "area" || name === "link") {
        if (attrs.href !== undefined) addCandidate(sink, attrs.href, base, name, "href");
      } else if (name === "img") {
        if (attrs.src !== undefined) addCandidate(sink, attrs.src, base, name, "src");
        if (attrs.srcset !== undefined) addSrcset(sink, attrs.srcset, base, name);
      } else if (name === "iframe") {
        if (attrs.src !== undefined) addCandidate(sink, attrs.src, base, name, "src");
      } else if (name === "form") {
        if (attrs.action !== undefined) {
          if (attrs.action.trim() === "") {
            // Empty action submits to the document URL, not to <base>.
            if (optsBase) addCandidate(sink, optsBase, optsBase, name, "action", attrs.action);
          } else {
            addCandidate(sink, attrs.action, base, name, "action");
          }
        }
      } else if (name === "meta") {
        const equiv = attrs["http-equiv"];
        if (typeof equiv === "string" && equiv.trim().toLowerCase() === "refresh") {
          const target = refreshTarget(attrs.content);
          if (target) addCandidate(sink, target, base, name, "content");
        }
      } else if (name === "video") {
        if (attrs.poster !== undefined) addCandidate(sink, attrs.poster, base, name, "poster");
      } else if (name === "source") {
        if (attrs.src !== undefined) addCandidate(sink, attrs.src, base, name, "src");
        if (attrs.srcset !== undefined) addSrcset(sink, attrs.srcset, base, name);
      }
    }

    out.base = base || null;
    out.links = sink.links;
  } catch (_) {
    // Never throw on malformed input; return whatever was parsed.
  }
  return out;
}

function extractCss(css, opts) {
  const out = { links: [] };
  try {
    const base = opts && typeof opts.baseUrl === "string" ? opts.baseUrl : null;
    const sink = createSink();
    cssRefs(css, base, sink, "style");
    out.links = sink.links;
  } catch (_) {}
  return out;
}

function looksLikePath(value) {
  if (value.startsWith("/")) return true; // covers // and /
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return /^[\w.\-]+\.(js|json|php|aspx?|jsp|html?)(\?|$)/i.test(value);
}

// Escaped newlines/control characters mean the literal is not one path.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isJsSpace(ch) {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\v" ||
    ch === "\f" ||
    ch === "\u00a0" ||
    ch === "\ufeff"
  );
}

function isIdentStart(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_" || ch === "$";
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

// Keywords after which an expression (and therefore a regex literal) starts.
const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "do",
  "else",
  "yield",
  "await",
]);

// Decode one backslash escape from a JS string/template. Returns the decoded
// text and the index just past the escape.
function readEscape(src, i, n) {
  if (i + 1 >= n) return { value: "", next: i + 1 };
  const e = src[i + 1];
  switch (e) {
    case "n":
      return { value: "\n", next: i + 2 };
    case "r":
      return { value: "\r", next: i + 2 };
    case "t":
      return { value: "\t", next: i + 2 };
    case "b":
      return { value: "\b", next: i + 2 };
    case "f":
      return { value: "\f", next: i + 2 };
    case "v":
      return { value: "\v", next: i + 2 };
    case "0":
      return { value: "\0", next: i + 2 };
    case "\\":
    case "'":
    case '"':
    case "`":
      return { value: e, next: i + 2 };
    case "\n":
      return { value: "", next: i + 2 }; // line continuation
    case "\r":
      return { value: "", next: i + 2 + (src[i + 2] === "\n" ? 1 : 0) };
    case "x": {
      const hex = src.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { value: String.fromCharCode(parseInt(hex, 16)), next: i + 4 };
      }
      return { value: "x", next: i + 2 };
    }
    case "u": {
      if (src[i + 2] === "{") {
        const close = src.indexOf("}", i + 3);
        const hex = close === -1 ? "" : src.slice(i + 3, close);
        if (
          close !== -1 &&
          /^[0-9a-fA-F]+$/.test(hex) &&
          parseInt(hex, 16) <= 0x10ffff
        ) {
          try {
            return { value: String.fromCodePoint(parseInt(hex, 16)), next: close + 1 };
          } catch (_) {
            // fall through to the identity form
          }
        }
        return { value: "u", next: i + 2 };
      }
      const hex = src.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { value: String.fromCharCode(parseInt(hex, 16)), next: i + 6 };
      }
      return { value: "u", next: i + 2 };
    }
    default:
      return { value: e, next: i + 2 };
  }
}

function readQuoted(src, start, quote) {
  const n = src.length;
  let j = start + 1;
  let value = "";
  while (j < n) {
    const d = src[j];
    if (d === "\\") {
      const esc = readEscape(src, j, n);
      value += esc.value;
      j = esc.next;
      continue;
    }
    if (d === quote) {
      return { value, end: j + 1, closed: true };
    }
    if (d === "\n" || d === "\r") {
      return { value, end: j, closed: false };
    }
    value += d;
    j++;
  }
  return { value, end: n, closed: false };
}

function readTemplate(src, start) {
  const n = src.length;
  let j = start + 1;
  let value = "";
  while (j < n) {
    const d = src[j];
    if (d === "\\") {
      const esc = readEscape(src, j, n);
      value += esc.value;
      j = esc.next;
      continue;
    }
    if (d === "`") {
      return { value, end: j + 1, closed: true };
    }
    value += d;
    j++;
  }
  return { value, end: n, closed: false };
}

// Skip a regex literal starting at src[start] === "/". Character classes may
// contain an unescaped "/", so track them; escapes consume the next character.
function skipRegexLiteral(src, start) {
  const n = src.length;
  let j = start + 1;
  let inClass = false;
  while (j < n) {
    const d = src[j];
    if (d === "\\") {
      j += 2;
      continue;
    }
    if (d === "[") {
      inClass = true;
      j++;
      continue;
    }
    if (d === "]") {
      inClass = false;
      j++;
      continue;
    }
    if (d === "/" && !inClass) {
      j++;
      break;
    }
    if (d === "\n" || d === "\r" || d === "\u2028" || d === "\u2029") break;
    j++;
  }
  while (j < n && ((src[j] >= "a" && src[j] <= "z") || (src[j] >= "A" && src[j] <= "Z"))) {
    j++;
  }
  return j;
}

// Keywords whose ")" closes a statement header (if/while/for/with). A regex
// literal may start right after that ")", unlike after an ordinary call ")".
const STATEMENT_HEADER_KEYWORDS = new Set(["if", "while", "for", "with"]);

// Heuristic JS tokenizer: enough state to tell a regex literal from a division
// operator, and to keep string literals after either. Not a parser.
function stringLiterals(source) {
  const out = [];
  if (typeof source !== "string") return out;
  const n = source.length;
  let i = 0;
  // true when the next token would start an expression; distinguishes a regex
  // literal from the division operator.
  let expectOperand = true;
  // Last significant token: { type, value }. `.` matters for property names
  // (`x.return` is a property, not the return keyword) and `if`/`while`/...
  // matter when their condition ")" is reached.
  let lastToken = null;
  // One entry per open "("; condition is true when the "(" follows a statement
  // header keyword, forHead when it opens a for(...) header.
  const parens = [];

  while (i < n) {
    const c = source[i];

    if (isJsSpace(c)) {
      i++;
      continue;
    }

    if (c === "/") {
      if (source[i + 1] === "/") {
        const nl = source.indexOf("\n", i + 2);
        i = nl === -1 ? n : nl + 1;
        continue;
      }
      if (source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (expectOperand) {
        i = skipRegexLiteral(source, i);
        expectOperand = false;
        lastToken = { type: "regex", value: "/" };
      } else {
        i++;
        expectOperand = true;
        lastToken = { type: "operator", value: "/" };
      }
      continue;
    }

    if (c === '"' || c === "'") {
      const parsed = readQuoted(source, i, c);
      if (parsed.closed) out.push({ kind: "string", value: parsed.value });
      i = parsed.end;
      expectOperand = false;
      lastToken = { type: "string", value: c };
      continue;
    }

    if (c === "`") {
      const parsed = readTemplate(source, i);
      if (parsed.closed) out.push({ kind: "template", value: parsed.value });
      i = parsed.end;
      expectOperand = false;
      lastToken = { type: "template", value: "`" };
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j])) j++;
      const word = source.slice(i, j);
      const afterDot = lastToken !== null && lastToken.value === ".";
      const inForHead = parens.some((entry) => entry.forHead);
      // `of` is contextual: an operator only inside a for(...) header, an
      // ordinary identifier elsewhere (`of / 2` is division).
      const prefixKeyword = afterDot
        ? false
        : word === "of"
          ? inForHead
          : REGEX_PREFIX_KEYWORDS.has(word);
      expectOperand = prefixKeyword;
      i = j;
      lastToken = { type: "word", value: word };
      continue;
    }

    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isIdentPart(source[j]) || source[j] === ".")) j++;
      i = j;
      expectOperand = false;
      lastToken = { type: "number", value: "0" };
      continue;
    }

    if (c === ")") {
      const frame = parens.pop();
      // After `if (...)`, `while (...)`, `for (...)`, `with (...)` a "/"
      // begins a regex literal, not a division: statement position.
      expectOperand = !!(frame && frame.condition);
      lastToken = { type: "punct", value: ")" };
      i++;
      continue;
    }

    if (c === "]") {
      expectOperand = false;
      lastToken = { type: "punct", value: "]" };
      i++;
      continue;
    }

    if (c === "}") {
      expectOperand = false;
      lastToken = { type: "punct", value: "}" };
      i++;
      continue;
    }

    if (c === "(") {
      const prevWord =
        lastToken !== null && lastToken.type === "word" ? lastToken.value : null;
      const parentForHead = parens.length > 0 && parens[parens.length - 1].forHead;
      parens.push({
        condition: prevWord !== null && STATEMENT_HEADER_KEYWORDS.has(prevWord),
        forHead: prevWord === "for" || parentForHead,
      });
      expectOperand = true;
      lastToken = { type: "punct", value: "(" };
      i++;
      continue;
    }

    if ((c === "+" || c === "-") && source[i + 1] === c) {
      // ++ / --: prefix leaves an operand to come (++x), postfix ends one
      // (a++ / 2 is division). In both readings the state does not flip.
      i += 2;
      lastToken = { type: "operator", value: c + c };
      continue;
    }

    // Every other operator/punctuation starts an expression operand. This
    // covers = + - * % & | ^ ! ~ < > ? : ; , [ { and unknown bytes.
    expectOperand = true;
    lastToken = { type: "operator", value: c };
    i++;
  }

  return out;
}

function extractJs(js, opts) {
  const out = { links: [] };
  try {
    if (typeof js !== "string") return out;
    const base = opts && typeof opts.baseUrl === "string" ? opts.baseUrl : null;
    const sink = createSink();
    const literals = stringLiterals(js);

    for (const literal of literals) {
      const value = literal.value;
      if (CONTROL_RE.test(value)) continue;
      if (value.includes("${")) {
        if (literal.kind !== "template") continue;
        const head = value.slice(0, value.indexOf("${"));
        const slash = head.lastIndexOf("/");
        if (slash < 0) continue;
        const prefix = head.slice(0, slash + 1);
        if (prefix.length < 2) continue;
        if (!looksLikePath(prefix)) continue;
        addCandidate(sink, prefix, base, "script", "js-string", prefix);
        continue;
      }

      const candidate = value.trim();
      if (candidate.length < 2) continue;
      if (!looksLikePath(candidate)) continue;
      addCandidate(sink, candidate, base, "script", "js-string", candidate);
    }

    out.links = sink.links;
  } catch (_) {}
  return out;
}

function eachLoc(xml, lower, cb) {
  const n = xml.length;
  let from = 0;
  while (from < n) {
    const open = lower.indexOf("<loc", from);
    if (open === -1) break;
    const boundary = xml.charCodeAt(open + 4);
    if (
      !(
        boundary === 62 || // >
        boundary === 47 || // /
        isSpaceCode(boundary) ||
        Number.isNaN(boundary)
      )
    ) {
      from = open + 4;
      continue;
    }
    const gt = xml.indexOf(">", open + 4);
    if (gt === -1) break;
    const close = lower.indexOf("</loc", gt + 1);
    if (close === -1) break;
    cb(xml.slice(gt + 1, close));
    const closeGt = xml.indexOf(">", close);
    if (closeGt === -1) break;
    from = closeGt + 1;
  }
}

function extractSitemap(xml, opts) {
  const out = { links: [] };
  try {
    if (typeof xml !== "string") return out;
    const base = opts && typeof opts.baseUrl === "string" ? opts.baseUrl : null;
    const sink = createSink();
    const lower = xml.toLowerCase();
    eachLoc(xml, lower, (content) => {
      const raw = decodeEntities(content).trim();
      if (!raw) return;
      const url = norm.resolveUrl(raw, base);
      if (url) sink.add(url, raw, "sitemap", "sitemap");
    });
    out.links = sink.links;
  } catch (_) {}
  return out;
}

const SITEMAP_LINE_RE = /^[ \t]*sitemap[ \t]*:[ \t]*(\S+)[ \t]*$/gim;

function extractRobots(txt, opts) {
  const out = { links: [] };
  try {
    if (typeof txt !== "string") return out;
    const base = opts && typeof opts.baseUrl === "string" ? opts.baseUrl : null;
    const sink = createSink();
    SITEMAP_LINE_RE.lastIndex = 0;
    let m;
    while ((m = SITEMAP_LINE_RE.exec(txt)) !== null) {
      const raw = m[1].trim();
      if (!raw) continue;
      const url = norm.resolveUrl(raw, base);
      if (url) sink.add(url, raw, "robots", "robots");
    }
    out.links = sink.links;
  } catch (_) {}
  return out;
}

module.exports = {
  extractHtml,
  extractCss,
  extractJs,
  extractSitemap,
  extractRobots,
};
