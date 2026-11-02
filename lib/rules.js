'use strict';

const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_PER_RULE = 200;
const SNIPPET_RADIUS = 40;
const SNIPPET_MAX = 200;

// Secret names are spelled with explicit character classes instead of the `i`
// flag so an env-style uppercase prefix can stay case-sensitive while the bare
// name stays case-insensitive: `DB_PASSWORD=hunter2` matches, `user_password`
// does not (an underscore-prefixed lowercase identifier is not a key/value).
const SECRET_NAME = [
  '[Pp][Aa][Ss][Ss][Ww][Dd]',
  '[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]',
  '[Ss][Ee][Cc][Rr][Ee][Tt]',
  '[Tt][Oo][Kk][Ee][Nn]',
  '[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]',
  '[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Kk][Ee][Yy]',
].join('|');

// name (word-bounded, optional UPPER_SNAKE prefix) optionally closed by a quote
// (for JSON/JS object keys) :|= quoted (>=3) | bare token (>=4)
const SECRET_ASSIGN_SOURCE = String.raw`(?<![A-Za-z0-9_])(?:[A-Z][A-Z0-9]*_)*(?:${SECRET_NAME})\b["']?\s*[:=]\s*(?:"[^"\r\n]{3,}"|'[^'\r\n]{3,}'|[A-Za-z0-9_.+\/-]{4,})`;

const JAVA_FRAME = String.raw`at\s+[^\s()]+\s*\([^\s()]*\.java:\d+\)`;
const PY_FRAME = String.raw`File\s+\\?"[^"\r\n]*\\?",\s*line\s+\d+`;
const NODE_FRAME = String.raw`at\s+(?:[^\s()]+\s*\()?[^\s()]*[./\\][^\s()]*:\d+:\d+\)?`;

// A traceback header followed immediately by frame lines is one finding; header
// and frames separated by other text stay separate findings.
const STACKTRACE_SOURCE =
  String.raw`Traceback \(most recent call last\):?(?:\r?\n[ \t]*(?:` +
  PY_FRAME +
  String.raw`[^\r\n]*|` +
  JAVA_FRAME +
  '|' +
  NODE_FRAME +
  '))*|Exception in thread|' +
  PY_FRAME +
  '|' +
  JAVA_FRAME +
  '|' +
  NODE_FRAME;

// Extensible: push { id, severity, description, regex, flags? } to add a rule.
const RULES = [
  {
    id: 'flag',
    severity: 'high',
    description: 'Flag token: flag{...}',
    regex: /flag\{[^}]{1,200}\}/g,
    flags: 'g',
  },
  {
    id: 'ctf',
    severity: 'high',
    description: 'CTF flag: CTF{...} (case-insensitive)',
    regex: /ctf\{[^}]{1,200}\}/gi,
    flags: 'gi',
  },
  {
    id: 'aws-key',
    severity: 'high',
    description: 'AWS access key ID: AKIA + 16 uppercase alphanumerics',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    flags: 'g',
  },
  {
    id: 'private-key',
    severity: 'high',
    description: 'PEM private key header (RSA/EC/OPENSSH/plain)',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    flags: 'g',
  },
  {
    id: 'secret-assign',
    severity: 'high',
    description: 'Secret-like key assigned to a quoted or unquoted value',
    regex: new RegExp(SECRET_ASSIGN_SOURCE, 'g'),
    flags: 'g',
  },
  {
    id: 'stacktrace',
    severity: 'medium',
    description: 'Python/Java/JS stack trace header or frame',
    regex: new RegExp(STACKTRACE_SOURCE, 'g'),
    flags: 'g',
  },
  {
    id: 'todo',
    severity: 'low',
    description: 'TODO/FIXME/HACK marker',
    regex: /\b(?:TODO|FIXME|HACK)\b/g,
    flags: 'g',
  },
];

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function makeSnippet(text, index, matchLength) {
  let start = Math.max(0, index - SNIPPET_RADIUS);
  let end = Math.min(text.length, index + matchLength + SNIPPET_RADIUS);

  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    start += 1;
  }
  if (end > start && end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
    end -= 1;
  }

  let snippet = text.slice(start, end).replace(/[\r\n]+/g, ' ');

  if (snippet.length > SNIPPET_MAX) {
    snippet = snippet.slice(0, SNIPPET_MAX);
    if (snippet.length > 0 && isHighSurrogate(snippet.charCodeAt(snippet.length - 1))) {
      snippet = snippet.slice(0, -1);
    }
  }

  return snippet;
}

function severityOf(ruleId) {
  const rule = RULES.find((candidate) => candidate.id === ruleId);
  return rule ? rule.severity : null;
}

function scan(text, opts) {
  if (typeof text !== 'string') {
    text = text == null ? '' : String(text);
  }
  if (text.length === 0) {
    return [];
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_SCAN_BYTES) {
    text = Buffer.from(text, 'utf8').subarray(0, MAX_SCAN_BYTES).toString('utf8');
  }

  const options = opts || {};
  let maxPerRule = options.maxPerRule;
  if (maxPerRule === undefined || maxPerRule === null) {
    maxPerRule = DEFAULT_MAX_PER_RULE;
  } else {
    maxPerRule = Math.floor(Number(maxPerRule));
    if (!Number.isFinite(maxPerRule) || maxPerRule < 0) {
      maxPerRule = 0;
    }
  }

  const sourceUrl = options.sourceUrl === undefined ? null : options.sourceUrl;
  const findings = [];
  const seen = new Set();

  for (const rule of RULES) {
    if (maxPerRule === 0) {
      break;
    }

    const flags = rule.flags || (rule.regex && rule.regex.flags) || '';
    const source = rule.regex instanceof RegExp ? rule.regex.source : String(rule.regex);
    const regex = new RegExp(source, flags.includes('g') ? flags : flags + 'g');
    let count = 0;
    let match;

    while (count < maxPerRule && (match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }

      const offset = match.index;
      const dedupeKey = rule.id + '@' + offset;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);

      findings.push({
        rule: rule.id,
        severity: rule.severity,
        match: match[0],
        snippet: makeSnippet(text, offset, match[0].length),
        offset,
        attrs: { sourceUrl },
      });
      count += 1;
    }
  }

  findings.sort((left, right) => {
    if (left.offset !== right.offset) {
      return left.offset - right.offset;
    }
    return left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0;
  });

  return findings;
}

module.exports = { RULES, scan, severityOf };
