import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger, actionTypes } from '../src/audit.js';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-audit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let output = '';
  const logger = new AuditLogger({ component: 'cli', directory,
    stream: { write: text => { output += text; } }, ...options });
  return { directory, logger, output: () => output };
}

test('console and JSON record carry matching friendly context, status and resource links', t => {
  const { directory, logger, output } = fixture(t);
  const entry = logger.log('pr_analysis_started', {
    status: 'in_progress', humanReadable: 'Claude is reviewing pull request #42.',
    context: { repository: 'demo/app', user: 'contributor', event: 'pull_request.opened',
      pr: { number: 42, title: 'Dark mode', url: 'https://github.com/demo/app/pull/42' } },
    links: { pr: 'https://github.com/demo/app/pull/42' }, details: { analysisTimeMs: 123 },
  });
  const file = join(directory, `${entry.timestamp.slice(0, 10)}.jsonl`);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), entry);
  assert.match(entry.timestamp, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.match(entry.actionId, /^[\da-f-]{36}$/);
  assert.equal(entry.component, 'cli');
  assert.match(output(), /PR Analysis Started/);
  assert.match(output(), /PR #42: "Dark mode"/);
  assert.match(output(), /⏳ In Progress/);
  assert.match(output(), /User: contributor/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
});

test('all components append valid JSON lines with distinct action IDs', t => {
  const { directory } = fixture(t);
  for (const component of ['cli', 'app', 'github-action']) {
    const logger = new AuditLogger({ component, directory, stream: { write() {} } });
    for (const action of Object.keys(actionTypes)) {
      logger.log(action, { humanReadable: 'A clearly described action.' });
    }
  }
  const entries = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8').trim()
    .split('\n').map(line => JSON.parse(line));
  assert.equal(entries.length, 3 * Object.keys(actionTypes).length);
  assert.equal(new Set(entries.map(entry => entry.actionId)).size, entries.length);
  assert.ok(entries.every(entry => entry.user && entry.event));
});

test('redacts configured secrets and sensitive fields recursively and neutralizes newlines', t => {
  const secret = 'sample-credential-for-test';
  const { directory, logger, output } = fixture(t, { secrets: [secret] });
  const entry = logger.log('error_occurred', {
    status: 'failure',
    humanReadable: `Connection failed: ${secret}\n::error::injected`,
    details: { authorization: 'private', nested: { apiKey: 'private' },
      values: [secret, 'ghp_exampleCredential', ['Bearer', 'test-credential'].join(' ')] },
    context: { user: '\u001b[31mvisitor', issue: { title: `Title ${secret}`, number: 1 } },
  });
  const saved = readFileSync(join(directory, readdirSync(directory)[0]), 'utf8');
  assert.ok(!saved.includes(secret));
  assert.ok(!saved.includes('private'));
  assert.ok(!saved.includes('test-credential'));
  assert.ok(!output().includes('\n::error::'));
  assert.ok(!output().includes('\u001b'));
  assert.equal(entry.details.nested.apiKey, '[REDACTED]');
});

test('run summary escapes untrusted HTML', t => {
  const { directory } = fixture(t);
  const summaryFile = join(directory, 'summary');
  const { logger } = fixture(t, { summaryFile });
  logger.log('resource_loaded', { humanReadable: '<script>do not render</script> & test' });
  const summary = readFileSync(summaryFile, 'utf8');
  assert.ok(!summary.includes('<script>'));
  assert.match(summary, /&lt;script&gt;/);
  assert.match(summary, /&amp;/);
});

test('invalid entries are rejected; unavailable storage fails clearly rather than dropping records', t => {
  const { directory, logger, output } = fixture(t);
  assert.throws(() => logger.log('made_up', { humanReadable: 'Wrong type' }));
  assert.throws(() => logger.log('error_occurred', { status: 'unknown', humanReadable: 'Wrong status' }));
  assert.throws(() => logger.log('error_occurred'));
  rmSync(directory, { recursive: true });
  writeFileSync(directory, 'not a directory');
  assert.throws(() => logger.log('error_occurred', { humanReadable: 'An error occurred.' }),
    /Audit storage is unavailable/);
  assert.match(output(), /Audit record could not be saved/);
});
