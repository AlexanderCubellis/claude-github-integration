import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-entrypoints-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logDir = join(directory, 'logs');
  const env = { ...process.env, AUDIT_LOG_DIR: logDir, GITHUB_TOKEN: '', ANTHROPIC_API_KEY: '' };
  const entries = () => readdirSync(logDir).flatMap(file =>
    readFileSync(join(logDir, file), 'utf8').trim().split('\n').map(JSON.parse));
  const run = (file, args = [], extraEnv = {}) => spawnSync(process.execPath,
    [new URL(`../src/${file}.js`, import.meta.url).pathname, ...args],
    { env: { ...env, ...extraEnv }, encoding: 'utf8' });
  return { directory, run, entries };
}

test('CLI help explains invocation and local log location', t => {
  const { run } = setup(t);
  const result = run('cli', ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--no-comment/);
  assert.match(result.stdout, /~\/.claude-github-integration\/logs/);
});

test('CLI prints readable failures beside coding output and exits unsuccessfully', t => {
  const { run, entries } = setup(t);
  const result = run('cli', ['pr', 'demo/app', '42']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /PR Analysis Started/);
  assert.match(result.stderr, /Authentication Problem/);
  assert.equal(entries().at(-1).component, 'cli');
  assert.equal(entries().at(-1).links.pr, 'https://github.com/demo/app/pull/42');
});

test('invalid CLI command is audited without API access', t => {
  const { run, entries } = setup(t);
  assert.equal(run('cli', ['pr', 'bad-repository', '0']).status, 1);
  assert.equal(entries().at(-1).actionType, 'error_occurred');
});

test('unknown CLI options have clear usage guidance in the audit trail', t => {
  const { run, entries } = setup(t);
  assert.equal(run('cli', ['pr', 'demo/app', '42', '--unknown']).status, 1);
  assert.match(entries().at(-1).humanReadable, /The only option is --no-comment/);
});

test('Action writes console, JSON and run summary for unsupported events', t => {
  const { directory, run, entries } = setup(t);
  const eventFile = join(directory, 'event.json');
  const summary = join(directory, 'summary');
  writeFileSync(eventFile, JSON.stringify({ repository: { full_name: 'demo/app' }, sender: { login: 'visitor' } }));
  const result = run('action', [], { GITHUB_EVENT_PATH: eventFile, GITHUB_STEP_SUMMARY: summary,
    GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'demo/app', GITHUB_ACTOR: 'visitor',
    GITHUB_RUN_ID: '123' });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /No Action Needed/);
  assert.match(readFileSync(summary, 'utf8'), /GitHub Notification Received/);
  assert.equal(entries().at(-1).component, 'github-action');
  assert.equal(entries().at(-1).actionType, 'component_stopped');
  assert.equal(entries().at(-1).links.workflow, 'https://github.com/demo/app/actions/runs/123');
});

test('Action logs a fork PR as skipped without using credentials', t => {
  const { directory, run, entries } = setup(t);
  const eventFile = join(directory, 'fork.json');
  writeFileSync(eventFile, JSON.stringify({
    action: 'opened', repository: { full_name: 'demo/app' }, sender: { login: 'visitor' },
    pull_request: { number: 42, title: 'Fork changes', head: { repo: { full_name: 'outside/app' } } },
  }));
  const result = run('action', [], { GITHUB_EVENT_PATH: eventFile,
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'demo/app' });
  assert.equal(result.status, 0);
  assert.equal(entries().find(entry => entry.actionType === 'event_skipped').status, 'skipped');
  assert.ok(!entries().some(entry => entry.actionType === 'pr_analysis_started'));
});

test('Action input errors produce persistent failure records', t => {
  const { run, entries, directory } = setup(t);
  assert.equal(run('action', [], { GITHUB_EVENT_PATH: join(directory, 'missing') }).status, 1);
  assert.equal(entries().at(-1).status, 'failure');
});

test('App configuration errors are audited on startup', t => {
  const { run, entries } = setup(t);
  const result = run('app', [], { WEBHOOK_SECRET: '', APP_REPOSITORIES: '' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Authentication Problem/);
  assert.equal(entries().at(-1).component, 'app');
});
