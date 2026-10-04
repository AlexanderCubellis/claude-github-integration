import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit.js';
import { Integration, resourceContext } from '../src/integration.js';

function setup(t, responses, credentials = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-integration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const logger = new AuditLogger({ component: 'app', directory, stream: { write() {} } });
  const integration = new Integration({ logger,
    githubToken: 'example-github-credential', claudeKey: 'example-claude-credential',
    ...credentials,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'Unexpected API call');
      return response;
    },
  });
  const entries = () => readFileSync(join(directory, readdirSync(directory)[0]), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line));
  return { integration, calls, entries, logger };
}
const json = data => new Response(JSON.stringify(data), { status: 200 });
const claude = () => json({ content: [{ type: 'text', text: 'Consider clearer names. @outsider' }] });
const prContext = () => resourceContext('demo/app', 'pr', 42, 'contributor', 'pull_request.opened');

test('successful PR review logs every stage and actual posted comment link without content or credentials', async t => {
  const { integration, calls, entries } = setup(t, [
    json({ title: 'Dark mode', body: 'private-description' }),
    new Response('private-source-diff'), claude(),
    json({ html_url: 'https://github.com/demo/app/pull/42#issuecomment-123' }),
  ]);
  const context = prContext();
  const review = await integration.analyze(context);
  assert.match(review, /clearer names/);
  assert.deepEqual(entries().map(entry => entry.actionType), [
    'pr_analysis_started', 'resource_loaded', 'changes_loaded', 'pr_analysis_complete',
    'comment_posting_started', 'comment_posted',
  ]);
  assert.equal(entries().at(-1).links.comment, 'https://github.com/demo/app/pull/42#issuecomment-123');
  assert.equal(entries().at(-1).pr.title, 'Dark mode');
  assert.equal(context.pr.title, 'Dark mode');
  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.headers.Authorization, ['Bearer', 'example-github-credential'].join(' '));
  assert.match(JSON.parse(calls[2].options.body).messages[0].content, /private-source-diff/);
  assert.match(JSON.parse(calls[3].options.body).body, /@\u200boutsider/);
  assert.ok(!JSON.stringify(entries()).includes('private-description'));
  assert.ok(!JSON.stringify(entries()).includes('private-source-diff'));
  assert.ok(!JSON.stringify(entries()).includes('clearer names'));
  assert.ok(!JSON.stringify(entries()).includes('example-github-credential'));
  assert.equal(entries()[3].details.inputTruncated, false);
  assert.equal(typeof entries()[3].details.analysisTimeMs, 'number');
});

test('issue review without comment logs completion and sends no diff or comment request', async t => {
  const { integration, calls, entries } = setup(t, [json({ title: 'Help', body: 'Explain this bug' }), claude()]);
  await integration.analyze(resourceContext('demo/app', 'issue', 7), { postComment: false });
  assert.deepEqual(entries().map(entry => entry.actionType),
    ['issue_analysis_started', 'resource_loaded', 'issue_analysis_complete']);
  assert.equal(calls.length, 2);
  assert.match(entries().at(-1).humanReadable, /no comment was requested/);
});

test('long inputs are bounded and clearly reported as a partial review', async t => {
  const { integration, calls, entries } = setup(t, [json({ title: 'Large issue', body: 'x'.repeat(110_000) }), claude()]);
  await integration.analyze(resourceContext('demo/app', 'issue', 7), { postComment: false });
  assert.equal(entries().at(-1).details.inputTruncated, true);
  assert.match(entries().at(-1).humanReadable, /Only the first part/);
  assert.ok(JSON.parse(calls[1].options.body).messages[0].content.length < 101_000);
});

for (const [name, response, action] of [
  ['expired authentication', new Response('sensitive error', { status: 401 }), 'authentication_failed'],
  ['missing permission', new Response('sensitive error', { status: 403 }), 'authentication_failed'],
  ['rate limit', new Response('sensitive error', { status: 429, headers: { 'retry-after': '60' } }), 'rate_limited'],
  ['GitHub rate limit', new Response('sensitive error', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), 'rate_limited'],
  ['GitHub secondary rate limit', new Response('sensitive error', { status: 403, headers: { 'retry-after': '60' } }), 'rate_limited'],
  ['server error', new Response('sensitive error', { status: 500 }), 'error_occurred'],
  ['network error', new Error('sensitive error with credentials'), 'error_occurred'],
]) {
  test(`${name} produces a linked plain-language failure without leaking response bodies`, async t => {
    const { integration, entries } = setup(t, [response]);
    await assert.rejects(integration.analyze(prContext()));
    assert.equal(entries().at(-1).actionType, action);
    assert.equal(entries().at(-1).status, 'failure');
    assert.equal(entries().at(-1).links.pr, 'https://github.com/demo/app/pull/42');
    assert.ok(!JSON.stringify(entries()).includes('sensitive error'));
    assert.ok(!entries().some(entry => entry.actionType === 'pr_analysis_complete'));
  });
}

test('missing credentials are explained without making API requests', async t => {
  const { integration, entries, calls } = setup(t, [], { githubToken: '' });
  await assert.rejects(integration.analyze(prContext()));
  assert.equal(calls.length, 0);
  assert.equal(entries().at(-1).actionType, 'authentication_failed');
  assert.match(entries().at(-1).humanReadable, /GITHUB_TOKEN/);
});

test('Claude authentication and missing text failures are reported', async t => {
  for (const response of [new Response('', { status: 401 }), json({ content: [] })]) {
    const { integration, entries } = setup(t, [json({ title: 'Issue' }), response]);
    await assert.rejects(integration.analyze(resourceContext('demo/app', 'issue', 7)));
    assert.equal(entries().at(-1).status, 'failure');
    assert.ok(!entries().some(entry => entry.actionType === 'issue_analysis_complete'));
  }
});

test('failed comment does not claim it was posted or that the event finished', async t => {
  const { integration, entries } = setup(t, [
    json({ title: 'Help' }), claude(), new Response('', { status: 403 }),
  ]);
  await assert.rejects(integration.handleEvent('issues', {
    action: 'opened', repository: { full_name: 'demo/app' },
    sender: { login: 'contributor' }, issue: { number: 7, title: 'Help' },
  }, { deliveryId: 'delivery-123' }));
  assert.equal(entries()[0].actionType, 'webhook_received');
  assert.equal(entries()[0].details.deliveryId, 'delivery-123');
  assert.ok(entries().some(entry => entry.actionType === 'issue_analysis_complete'));
  assert.ok(!entries().some(entry => ['comment_posted', 'webhook_processed'].includes(entry.actionType)));
  assert.equal(entries().filter(entry => entry.status === 'failure').length, 1);
});

test('supported notification records receipt and processing with triggering user', async t => {
  const { integration, entries } = setup(t, [
    json({ title: 'Help' }), claude(), json({ html_url: 'https://github.com/demo/app/issues/7#issuecomment-1' }),
  ]);
  await integration.handleEvent('issues', {
    action: 'opened', repository: { full_name: 'demo/app' },
    sender: { login: 'contributor' }, issue: { number: 7, title: 'Help' },
  });
  assert.equal(entries()[0].links.issue, 'https://github.com/demo/app/issues/7');
  assert.equal(entries().at(-1).actionType, 'webhook_processed');
  assert.equal(entries().at(-1).user, 'contributor');
  assert.equal(entries().at(-1).event, 'issues.opened');
});

test('unsupported events and forks are explicitly skipped without API calls', async t => {
  const { integration, entries, calls } = setup(t, []);
  await integration.handleEvent('push', { repository: { full_name: 'demo/app' } });
  await integration.handleEvent('pull_request', {
    action: 'opened', repository: { full_name: 'demo/app' },
    pull_request: { number: 42, title: 'Fork PR', head: { repo: { full_name: 'outside/app' } } },
  });
  assert.equal(calls.length, 0);
  assert.equal(entries().filter(entry => entry.status === 'skipped').length, 2);
});

test('invalid resource inputs cannot target arbitrary API paths', () => {
  for (const [repo, kind, number] of [
    ['https://evil.invalid/x', 'pr', 1], ['owner/repo/../../other', 'issue', 1],
    ['owner/..', 'pr', 1], ['../repo', 'issue', 1],
    ['owner/repo', 'commit', 1], ['owner/repo', 'pr', -1], ['owner/repo', 'pr', NaN],
  ]) assert.throws(() => resourceContext(repo, kind, number));
});
