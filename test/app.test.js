import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit.js';
import { createApp } from '../src/app.js';
import { Integration, IntegrationError } from '../src/integration.js';

const secret = 'test-webhook-signing-value';
const payload = { action: 'opened', repository: { full_name: 'demo/app' },
  sender: { login: 'contributor' }, issue: { number: 7, title: 'Help' } };

async function setup(t, integration) {
  const directory = mkdtempSync(join(tmpdir(), 'claude-app-'));
  const logger = new AuditLogger({ component: 'app', directory, stream: { write() {} } });
  const server = createApp({ logger,
    integration: typeof integration === 'function' ? integration(logger) : integration,
    secret, repositories: ['demo/app'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/webhook`;
  const send = (body = JSON.stringify(payload), headers = {}, path = url) => fetch(path, {
    method: 'POST', body, headers: {
      'x-github-event': 'issues', 'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      ...headers,
    },
  });
  const entries = () => readdirSync(directory).filter(file => file.endsWith('.jsonl'))
    .flatMap(file => readFileSync(join(directory, file), 'utf8').trim().split('\n').map(JSON.parse));
  return { server, url, send, entries, logger, directory };
}

test('unsigned or altered webhooks fail authentication before invoking the integration', async t => {
  let calls = 0;
  const { send, entries } = await setup(t, { handleEvent: async () => { calls++; } });
  assert.equal((await send(undefined, { 'x-hub-signature-256': 'bad' })).status, 401);
  assert.equal((await send(undefined, { 'x-hub-signature-256': 'é'.repeat(71) })).status, 401);
  assert.equal(calls, 0);
  assert.equal(entries()[0].actionType, 'authentication_failed');
  assert.equal(entries()[0].user, 'unverified');
  assert.ok(!JSON.stringify(entries()).includes(secret));
});

test('signed webhook reaches integration with event and delivery ID; duplicate is skipped', async t => {
  const calls = [];
  const { send, entries } = await setup(t, {
    handleEvent: async (...args) => { calls.push(args); },
  });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'issues');
  assert.deepEqual(calls[0][1], payload);
  assert.equal(calls[0][2].deliveryId, 'delivery-1');
  assert.equal(entries().at(-1).status, 'skipped');
  assert.match(entries().at(-1).humanReadable, /already been handled/);
});

test('malformed notifications are explained and unconfigured repositories are skipped', async t => {
  const { send, entries } = await setup(t, {
    handleEvent: () => { assert.fail('Must not invoke integration'); },
  });
  assert.equal((await send('invalid json')).status, 400);
  assert.equal((await send('null')).status, 400);
  assert.equal((await send(JSON.stringify({ ...payload, repository: { full_name: 'outside/app' } }))).status, 200);
  assert.equal(entries().at(-1).actionType, 'event_skipped');
  assert.equal(entries().at(-1).repository, 'outside/app');
});

test('busy App logs rate limiting; failed deliveries can be redelivered', async t => {
  let release;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { send, entries } = await setup(t, {
    handleEvent: async () => {
      calls++;
      if (calls === 1) {
        began();
        await hold;
        throw new IntegrationError('Review failed.');
      }
    },
  });
  const first = send();
  await started;
  assert.equal((await send(undefined, { 'x-github-delivery': 'delivery-2' })).status, 503);
  assert.equal(entries().at(-1).actionType, 'rate_limited');
  release();
  assert.equal((await first).status, 500);
  assert.equal((await send()).status, 200);
  assert.equal(calls, 2);
});

test('real webhook processing writes receipt, issue result, comment and completion audit records', async t => {
  const responses = [
    new Response(JSON.stringify({ title: 'Help' })),
    new Response(JSON.stringify({ content: [{ type: 'text', text: 'Explain the bug.' }] })),
    new Response(JSON.stringify({ html_url: 'https://github.com/demo/app/issues/7#issuecomment-1' })),
  ];
  const { send, entries } = await setup(t, logger => new Integration({
    logger, githubToken: 'example-token', claudeKey: 'example-key',
    fetchImpl: async () => responses.shift(),
  }));
  assert.equal((await send()).status, 200);
  assert.equal(entries()[0].actionType, 'webhook_received');
  assert.equal(entries().at(-1).actionType, 'webhook_processed');
  assert.ok(entries().some(entry => entry.actionType === 'comment_posted'));
});

test('analysis failures are logged once and the failed notification can be retried', async t => {
  const { send, entries } = await setup(t, logger => new Integration({
    logger, githubToken: '', claudeKey: '', fetchImpl: () => assert.fail('Must not call API'),
  }));
  assert.equal((await send()).status, 500);
  assert.equal(entries().filter(entry => entry.status === 'failure').length, 1);
  assert.equal((await send()).status, 500);
  assert.equal(entries().filter(entry => entry.status === 'failure').length, 2);
});

test('oversized notifications fail with a readable 413 error', async t => {
  const { send, entries } = await setup(t, { handleEvent: () => assert.fail() });
  assert.equal((await send('x'.repeat(1_048_577))).status, 413);
  assert.equal(entries().at(-1).details.httpStatus, 413);
  assert.match(entries().at(-1).humanReadable, /too large/);
});

test('unavailable audit storage refuses unauthenticated requests without crashing', async t => {
  const { send, directory } = await setup(t, { handleEvent: () => assert.fail() });
  rmSync(directory, { recursive: true });
  assert.equal((await send(undefined, { 'x-hub-signature-256': 'bad' })).status, 503);
});

test('App refuses startup without a signing secret or allowed repositories', () => {
  const logger = { secrets: [] };
  assert.throws(() => createApp({ logger, secret: '', repositories: ['demo/app'] }), /WEBHOOK_SECRET/);
  assert.throws(() => createApp({ logger, secret, repositories: [] }), /APP_REPOSITORIES/);
});
