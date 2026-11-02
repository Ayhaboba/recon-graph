'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { RULES, scan, severityOf } = require('../lib/rules.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const JS_FIXTURES = path.join(FIXTURES, 'js');
const HTML_FIXTURES = path.join(FIXTURES, 'html');

const EXPECTED_SEVERITIES = {
  flag: 'high',
  ctf: 'high',
  'aws-key': 'high',
  'private-key': 'high',
  'secret-assign': 'high',
  stacktrace: 'medium',
  todo: 'low',
};

function jsFixture(name) {
  return fs.readFile(path.join(JS_FIXTURES, name), 'utf8');
}

// flag.html is owned by another worker: retry briefly, then fail loudly.
async function flagHtmlFixture() {
  const file = path.join(HTML_FIXTURES, 'flag.html');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT' || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error('unreachable');
}

function ruleIds(findings, ruleId) {
  return findings.filter((finding) => finding.rule === ruleId);
}

test('rule table exposes 7 rules with expected severities', () => {
  assert.equal(RULES.length, 7);
  assert.deepEqual(
    RULES.map((rule) => rule.id).sort(),
    Object.keys(EXPECTED_SEVERITIES).sort(),
  );

  for (const rule of RULES) {
    assert.equal(rule.severity, EXPECTED_SEVERITIES[rule.id], rule.id);
    assert.equal(typeof rule.description, 'string', rule.id);
    assert.ok(rule.description.length > 0, rule.id);
    assert.ok(rule.regex instanceof RegExp, rule.id);
    assert.equal(severityOf(rule.id), EXPECTED_SEVERITIES[rule.id], rule.id);
  }

  assert.equal(severityOf('does-not-exist'), null);
});

test('secrets.js yields exactly the expected findings', async () => {
  const text = await jsFixture('secrets.js');
  const findings = scan(text, { sourceUrl: 'https://test.local/secrets.js' });

  assert.equal(findings.length, 7);
  assert.deepEqual(
    findings.map((finding) => finding.rule).sort(),
    ['aws-key', 'ctf', 'flag', 'secret-assign', 'secret-assign', 'secret-assign', 'todo'],
  );

  for (let index = 1; index < findings.length; index += 1) {
    assert.ok(
      findings[index].offset >= findings[index - 1].offset,
      `offsets not ascending at ${index}`,
    );
  }

  assert.equal(ruleIds(findings, 'secret-assign').length, 3);
  assert.ok(findings.every((finding) => finding.attrs.sourceUrl === 'https://test.local/secrets.js'));
  assert.ok(findings.some((finding) => finding.match === 'flag{js_fixture}'));
  assert.ok(findings.some((finding) => finding.match === 'password: "hunter2"'));
  assert.ok(findings.some((finding) => finding.match === 'token: "s3cr3t-token-value"'));
  assert.ok(findings.some((finding) => finding.match === 'DB_PASSWORD=hunter2'));
});

test('bundle.js yields private-key, todo and three stack trace findings', async () => {
  const text = await jsFixture('bundle.js');
  const findings = scan(text);

  assert.equal(findings.length, 5);
  assert.deepEqual(
    findings.map((finding) => finding.rule).sort(),
    ['private-key', 'stacktrace', 'stacktrace', 'stacktrace', 'todo'],
  );

  for (let index = 1; index < findings.length; index += 1) {
    assert.ok(
      findings[index].offset >= findings[index - 1].offset,
      `offsets not ascending at ${index}`,
    );
  }

  const stacktraces = ruleIds(findings, 'stacktrace');
  assert.equal(stacktraces.length, 3);
  assert.ok(stacktraces.every((finding) => finding.severity === 'medium'));
  assert.ok(stacktraces.some((finding) => /^Traceback \(most recent call last\)/.test(finding.match)));
  assert.ok(stacktraces.some((finding) => /Router\.java:42/.test(finding.match)));
  assert.ok(stacktraces.some((finding) => /server\.py/.test(finding.match)));

  assert.equal(ruleIds(findings, 'private-key')[0].severity, 'high');
  assert.equal(ruleIds(findings, 'todo')[0].severity, 'low');
});

test('flag.html yields all seven rule kinds exactly once', async () => {
  const text = await flagHtmlFixture();
  const findings = scan(text);
  const counts = new Map();

  for (const finding of findings) {
    counts.set(finding.rule, (counts.get(finding.rule) || 0) + 1);
  }

  assert.deepEqual(
    [...counts.keys()].sort(),
    ['aws-key', 'ctf', 'flag', 'private-key', 'secret-assign', 'stacktrace', 'todo'],
  );
  for (const [rule, count] of counts) {
    assert.equal(count, 1, `${rule} should occur exactly once`);
  }
  assert.equal(findings.length, 7);
});

test('unquoted secret assignments are detected', () => {
  const positives = [
    ['password=hunter2', 'password=hunter2'],
    ['DB_PASSWORD=hunter2', 'DB_PASSWORD=hunter2'],
    ['password: hunter2', 'password: hunter2'],
    ['password="hunter2"', 'password="hunter2"'],
  ];

  for (const [input, expectedMatch] of positives) {
    const findings = scan(input);
    assert.equal(findings.length, 1, input);
    assert.equal(findings[0].rule, 'secret-assign');
    assert.equal(findings[0].severity, 'high');
    assert.equal(findings[0].match, expectedMatch);
  }

  assert.deepEqual(scan('user_password="x"'), []);
  assert.deepEqual(scan('passwordField="x"'), []);
});

test('quoted json keys are detected', () => {
  const probes = ['{"token": "abcdef"}', '{"password": "hunter2"}', '{"api_key": "abcd"}'];

  for (const input of probes) {
    const findings = ruleIds(scan(input), 'secret-assign');
    assert.equal(findings.length, 1, input);
    assert.equal(findings[0].severity, 'high', input);
  }
});

test('js object literal keys are detected', () => {
  const probes = ['token: "abcdef"', 'password: "hunter2"'];

  for (const input of probes) {
    const findings = ruleIds(scan(input), 'secret-assign');
    assert.equal(findings.length, 1, input);
    assert.equal(findings[0].severity, 'high', input);
  }
});

test('config-like keys are not false positives', () => {
  const probes = [
    'max_tokens: 4096',
    'secretCount=3',
    'api_key_id=abc',
    'tokenizer',
    'user_password="x"',
    'passwordField="x"',
  ];

  for (const input of probes) {
    assert.equal(ruleIds(scan(input), 'secret-assign').length, 0, input);
  }
});

test('stack frame variants are detected', () => {
  const cases = [
    ['at com.acme.http.Router.dispatch(Router.java:42)', /^at com\.acme\.http\.Router\.dispatch\(Router\.java:42\)$/],
    ['File "/app/server.py", line 17, in handle', /^File "\/app\/server\.py", line 17$/],
    ['File \\"/app/server.py\\", line 17, in handle', /^File \\"\/app\/server\.py\\", line 17$/],
    ['at /app/index.js:12:3', /^at \/app\/index\.js:12:3$/],
    ['at Object.<anonymous> (/app/x.js:1:1)', /^at Object\.<anonymous> \(\/app\/x\.js:1:1\)$/],
    ['Traceback (most recent call last)', /^Traceback \(most recent call last\)$/],
    ['Exception in thread "main"', /^Exception in thread$/],
  ];

  for (const [input, expectedMatch] of cases) {
    const findings = ruleIds(scan(input), 'stacktrace');
    assert.equal(findings.length, 1, input);
    assert.equal(findings[0].severity, 'medium');
    assert.match(findings[0].match, expectedMatch);
  }
});

test('no false positives on benign text', () => {
  const text = [
    'user_password',
    'user_password="x"',
    'passwordField="x"',
    'tokenizer',
    'flag without braces',
    'TODO_NOT_A_WORD',
    'TODOS',
    'password',
    'secretary',
    'password="x"',
  ].join(' ');

  assert.deepEqual(scan(text), []);
});

test('snippets are single-line and bounded', async () => {
  const text =
    'x'.repeat(120) + ' password:\n    "hunter2" ' + 'y'.repeat(300);
  const findings = scan(text);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'secret-assign');
  assert.ok(!/[\r\n]/.test(findings[0].snippet));
  assert.ok(findings[0].snippet.length <= 200);

  for (const name of ['secrets.js', 'bundle.js']) {
    for (const finding of scan(await jsFixture(name))) {
      assert.ok(!/[\r\n]/.test(finding.snippet), `${name}: newline in snippet`);
      assert.ok(finding.snippet.length <= 200, `${name}: snippet too long`);
    }
  }
});

test('maxPerRule caps results', () => {
  const text = 'TODO one\nTODO two\nTODO three\nFIXME four';

  assert.equal(
    scan(text, { maxPerRule: 2 }).filter((finding) => finding.rule === 'todo').length,
    2,
  );
  assert.equal(
    scan(text, { maxPerRule: 1 }).filter((finding) => finding.rule === 'todo').length,
    1,
  );
  assert.deepEqual(scan(text, { maxPerRule: 0 }), []);
});

test('scan tolerates empty and huge input', () => {
  assert.deepEqual(scan(''), []);
  assert.deepEqual(scan(null), []);
  assert.deepEqual(scan(undefined), []);

  const huge = 'a'.repeat(5 * 1024 * 1024);
  const findings = scan(huge);
  assert.ok(Array.isArray(findings));
  assert.equal(findings.length, 0);
});
