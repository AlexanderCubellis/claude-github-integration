import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, FEATURES } from '../lib/config.js';
import { analyze, truncate } from '../lib/claude.js';
import { getPullRequestContext, getIssueContext, publishAnalysis, readWithRetry, parseRepository, parseNumber } from '../lib/github.js';
import { analyzeTarget } from '../lib/integration.js';
import { createProgram } from '../cli/index.js';
import { runAction } from '../github-action/index.js';

const target = { owner: 'owner', repo: 'repo', number: 7, kind: 'pr' };
function mocks() {
  const calls = [];
  const github = { rest: {
    pulls: {
      get: async () => ({ data: { title: 'Fix', body: 'Details', base: { sha: 'base' }, head: { sha: 'head' } } }),
      listFiles: async () => ({ data: [{ filename: 'src.js', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new' }] }),
      createReview: async args => { calls.push(args); },
    },
    issues: {
      get: async () => ({ data: { title: 'Bug', body: 'Steps', labels: [{ name: 'bug' }] } }),
      createComment: async args => { calls.push(args); },
    },
  } };
  const claude = { messages: { create: async args => {
    calls.push(args);
    return { content: [{ type: 'text', text: 'Suggested fix' }] };
  } } };
  return { github, claude, calls };
}

test('configuration accepts all features and rejects invalid ranges and types', () => {
  assert.deepEqual(normalizeConfig({ features: FEATURES.join(',') }).features, FEATURES);
  for (const input of [null, [], { maxTokens: 0 }, { maxInputChars: Infinity },
    { features: ['unknown'] }, { features: [] }, { prompt: {} }, { model: '' }, { publish: 'approve' }]) {
    assert.throws(() => normalizeConfig(input));
  }
  assert.throws(() => parseRepository('owner/repo/extra'));
  assert.throws(() => parseNumber('-1'));
  assert.throws(() => parseNumber('1.5'));
});

test('Claude SDK receives bounded content, model, features, and trusted prompt', async () => {
  const { claude, calls } = mocks();
  assert.equal(await analyze(claude, { kind: 'code', content: 'x'.repeat(2000), config: {
    model: 'custom-model', features: FEATURES, maxTokens: 42, maxInputChars: 1000, prompt: 'Use concise prose.',
  } }), 'Suggested fix');
  const request = calls[0];
  assert.equal(request.model, 'custom-model');
  assert.equal(request.max_tokens, 42);
  assert.match(request.system, /untrusted data/);
  assert.match(request.system, /Use concise prose/);
  assert.match(request.system, /conventional commit/);
  assert.match(request.messages[0].content, /Input truncated/);
  assert.equal(truncate('x'.repeat(2000), 1000).length, 1000);
  await assert.rejects(analyze({ messages: { create: async () => ({ content: [] }) } }, { kind: 'code', content: 'x' }), /no text/);
});

test('PR context includes patches, missing patch notices, and bounded pagination', async () => {
  const { github } = mocks();
  let pages = 0;
  github.rest.pulls.listFiles = async () => {
    pages++;
    return { data: Array.from({ length: 100 }, () => ({ filename: 'binary.png', status: 'added' })) };
  };
  const content = await getPullRequestContext(github, target, 1000);
  assert.match(content, /Base: base/);
  assert.match(content, /No textual patch/);
  assert.match(content, /Input truncated/);
  assert.equal(content.length, 1000);
  assert.equal(pages, 1);
});

test('PR context paginates past the first 100 files', async () => {
  const { github } = mocks();
  const pages = [];
  github.rest.pulls.listFiles = async ({ page }) => {
    pages.push(page);
    return { data: page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}`, status: 'added', patch: '+x' }))
      : [{ filename: 'last.js', status: 'added', patch: '+last' }] };
  };
  assert.match(await getPullRequestContext(github, target), /last.js/);
  assert.deepEqual(pages, [1, 2]);
});

test('issue analysis includes labels and rejects a PR fetched as an issue', async () => {
  const { github } = mocks();
  assert.match(await getIssueContext(github, target), /Labels: bug/);
  github.rest.issues.get = async () => ({ data: { pull_request: {} } });
  await assert.rejects(getIssueContext(github, target), /pull request/);
});

test('integration supports read-only, review, and issue-comment modes', async () => {
  const { github, claude, calls } = mocks();
  const result = await analyzeTarget({ github, claude, target, config: { publish: 'none' } });
  assert.equal(result.published, false);
  assert.equal(calls.length, 1);
  await publishAnalysis(github, target, '```suggestion\nfixed\n```', 'review');
  assert.equal(calls[1].event, 'COMMENT');
  assert.match(calls[1].body, /suggestion/);
  await publishAnalysis(github, { ...target, kind: 'issue' }, 'Summary', 'review');
  assert.equal(calls[2].issue_number, 7);
  await publishAnalysis(github, target, 'x'.repeat(100000), 'comment');
  assert.ok(calls[3].body.length < 65536);
});

test('rate limit retries are bounded and never retry authorization errors', async () => {
  let count = 0;
  const sleeps = [];
  const error = Object.assign(new Error('limited'), { status: 429, response: { headers: { 'retry-after': '1' } } });
  assert.equal(await readWithRetry(async () => {
    if (++count < 3) throw error;
    return 'ok';
  }, { sleep: async ms => sleeps.push(ms) }), 'ok');
  assert.deepEqual(sleeps, [1000, 1000]);
  count = 0;
  await assert.rejects(readWithRetry(async () => { count++; throw error; }, { sleep: async () => {} }));
  assert.equal(count, 3);
  count = 0;
  await assert.rejects(readWithRetry(async () => { count++; throw { status: 403 }; }));
  assert.equal(count, 1);
});

test('publication errors are not retried', async () => {
  const { github } = mocks();
  let count = 0;
  github.rest.issues.createComment = async () => { count++; throw new Error('ambiguous response'); };
  await assert.rejects(publishAnalysis(github, target, 'text'));
  assert.equal(count, 1);
});

test('CLI exercises PR, issue, local code, and explicit publication using mock SDKs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'code.js');
  const config = join(dir, 'config.json');
  await writeFile(file, 'export const x = 1;');
  await writeFile(config, JSON.stringify({ publish: 'review', features: ['tests'] }));
  const { claude, github, calls } = mocks();
  const output = [];
  const program = () => createProgram({ claudeFactory: () => claude, githubFactory: () => github, output: value => output.push(value) });
  await program().parseAsync(['pr', 'owner/repo', '7', '--config', config], { from: 'user' });
  assert.equal(calls.length, 1, 'saved publication must not silently enable writes');
  await program().parseAsync(['issue', 'owner/repo', '7', '--publish', 'comment'], { from: 'user' });
  assert.equal(calls.at(-1).issue_number, 7);
  await program().parseAsync(['code', file, '--features', 'commit,tests,docs'], { from: 'user' });
  assert.match(calls.at(-1).system, /documentation/);
  assert.equal(output.length, 3);
  await assert.rejects(program().parseAsync(['pr', 'bad-repo', '7'], { from: 'user' }));
});

test('Action handles PRs, issues, manual runs, outputs, and skips fork/unsupported events', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-action-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'event.json');
  const { github, claude } = mocks();
  const calls = [];
  const output = join(dir, 'outputs');
  const env = { GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_NAME: 'pull_request', GITHUB_OUTPUT: output };
  const run = () => runAction({
    env, githubFactory: () => github, claudeFactory: () => claude,
    runAnalysis: async args => { calls.push(args); return { text: 'ok', published: true }; },
  });
  await writeFile(path, JSON.stringify({ action: 'opened', pull_request: { number: 7, head: { repo: { fork: false } } } }));
  await run();
  assert.equal(calls[0].target.kind, 'pr');
  assert.equal(await readFile(output, 'utf8'), 'published=true\n');
  await writeFile(path, JSON.stringify({ action: 'synchronize', pull_request: { number: 7, head: { repo: { fork: true } } } }));
  assert.deepEqual(await run(), { skipped: true });
  env.GITHUB_EVENT_NAME = 'issues';
  await writeFile(path, JSON.stringify({ action: 'opened', issue: { number: 8 } }));
  await run();
  assert.deepEqual(calls[1].config.features, ['summary', 'categorize']);
  env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  await writeFile(path, JSON.stringify({ inputs: { kind: 'issue', number: '9' } }));
  await run();
  assert.equal(calls[2].target.number, 9);
  await writeFile(path, JSON.stringify({ inputs: { kind: 'invalid', number: '9' } }));
  await assert.rejects(run(), /kind/);
  env.GITHUB_EVENT_NAME = 'push';
  assert.deepEqual(await run(), { skipped: true });
  assert.equal(calls.length, 3);
});
