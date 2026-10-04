import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('first installation logs a bootstrap skip without executing PR code', t => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workflow = readFileSync(new URL('../.github/workflows/claude-review.yml', import.meta.url), 'utf8');
  const run = workflow.split('        run: |\n')[1].split('        env:\n')[0]
    .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const logDir = join(directory, 'logs');
  const summaryFile = join(directory, 'summary');
  const result = spawnSync('bash', ['-e', '-c', run], {
    cwd: directory, encoding: 'utf8',
    env: { ...process.env, AUDIT_LOG_DIR: logDir, GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_REPOSITORY: 'demo/app', GITHUB_ACTOR: 'contributor', GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_RUN_ID: '123' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not installed on the default branch yet/);
  assert.match(readFileSync(summaryFile, 'utf8'), /No Action Needed/);
  const entry = JSON.parse(readFileSync(join(logDir, readdirSync(logDir)[0]), 'utf8'));
  assert.equal(entry.status, 'skipped');
  assert.equal(entry.actionType, 'event_skipped');
  assert.equal(entry.details.reason, 'installation_pending');
  assert.equal(entry.component, 'github-action');
  assert.equal(entry.links.workflow, 'https://github.com/demo/app/actions/runs/123');
  assert.equal(entry.user, 'contributor');
  assert.equal(entry.event, 'pull_request');
});
