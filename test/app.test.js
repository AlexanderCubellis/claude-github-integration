import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { createApp, verifySignature } from '../github-app/server.js';
import { createSettingsStore } from '../github-app/store.js';

const env = {
  GITHUB_APP_ID: '123', GITHUB_PRIVATE_KEY: 'test-private-key',
  GITHUB_WEBHOOK_SECRET: 'test-webhook-secret', GITHUB_CLIENT_ID: 'test-client',
  GITHUB_CLIENT_SECRET: 'test-client-secret', ANTHROPIC_API_KEY: 'test-api-key',
  APP_URL: 'http://127.0.0.1:3000', NODE_ENV: 'test',
};
const normalizeConfig = (input = {}) => {
  if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1)) {
    throw new Error('Invalid maxTokens');
  }
  return { model: 'claude-sonnet-4-6', maxTokens: 2048, maxInputChars: 60000,
    prompt: '', features: ['review'], publish: 'comment', ...input };
};
function event(kind = 'pr', action = 'opened') {
  return { action, installation: { id: 7 }, repository: { id: 9, name: 'project',
    owner: { login: 'owner' } }, [kind === 'pr' ? 'pull_request' : 'issue']: { number: 42 } };
}
function signed(payload, id = randomBytes(12).toString('hex'), name = 'pull_request') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { method: 'POST', body, headers: { 'Content-Type': 'application/json',
    'X-GitHub-Event': name, 'X-GitHub-Delivery': id,
    'X-Hub-Signature-256': `sha256=${createHmac('sha256', env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}` } };
}
async function setup(t, overrides = {}) {
  const analyses = [];
  const saved = new Map();
  const fixture = await createApp({
    env, claude: {}, normalizeConfig,
    store: { get: id => saved.get(id) ?? {}, set: async (id, config) => saved.set(id, config) },
    appOctokit: { request: async () => ({ data: { id: 7 } }) },
    installationOctokit: async () => ({ request: async () => ({ data: { id: 9 } }) }),
    oauthOctokit: () => ({ request: async route => ({ data: route === 'GET /user'
      ? { id: 1, login: 'manager' } : { id: 9, permissions: { admin: true } } }) }),
    exchangeOAuth: async () => 'mock-access-token',
    analyzeTarget: async args => { analyses.push(args); return { text: 'review', published: true }; },
    ...overrides,
  });
  const server = fixture.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await fixture.waitForIdle(); await new Promise(resolve => server.close(resolve)); });
  return { ...fixture, analyses, saved, request: (path, options) => fetch(base + path, options) };
}
async function login(fixture) {
  const start = await fixture.request('/auth/login', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await fixture.request(`/auth/callback?code=code&state=${state}`, {
    headers: { Cookie: `github_oauth_state=${state}` },
  });
  assert.equal(callback.status, 200);
  return { state, cookie: callback.headers.get('set-cookie').match(/github_session=[^;]+/)[0],
    csrf: (await callback.json()).csrfToken };
}

test('raw HMAC verification rejects missing, malformed and changed bodies', () => {
  const body = Buffer.from('{"test":1}');
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`;
  assert.equal(verifySignature(body, signature, 'secret'), true);
  assert.equal(verifySignature(Buffer.from('{}'), signature, 'secret'), false);
  assert.equal(verifySignature(body, 'sha256=wrong', 'secret'), false);
  assert.equal(verifySignature(body, undefined, 'secret'), false);
});

test('health, secure response headers, and unsigned webhook rejection', async t => {
  const fixture = await setup(t);
  const health = await fixture.request('/health');
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.match(health.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(health.headers.get('x-powered-by'), null);
  const response = await fixture.request('/webhooks', { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
  assert.equal(fixture.analyses.length, 0);
});

test('all requested events invoke injected analysis and duplicate deliveries are suppressed', async t => {
  const fixture = await setup(t);
  for (const [kind, actions] of [['pr', ['opened', 'synchronize', 'reopened']], ['issue', ['opened', 'reopened']]]) {
    for (const action of actions) {
      const request = signed(event(kind, action), undefined, kind === 'pr' ? 'pull_request' : 'issues');
      assert.equal((await fixture.request('/webhooks', request)).status, 202);
      await fixture.waitForIdle();
      const duplicate = await fixture.request('/webhooks', request);
      assert.equal((await duplicate.json()).status, 'duplicate');
    }
  }
  assert.equal(fixture.analyses.length, 5);
  assert.deepEqual(fixture.analyses[0].target, { owner: 'owner', repo: 'project', number: 42, kind: 'pr' });
  assert.deepEqual(fixture.analyses[0].config.features, ['review', 'summary', 'tests']);
  assert.equal(fixture.analyses.at(-1).target.kind, 'issue');
  assert.deepEqual(fixture.analyses.at(-1).config.features, ['summary', 'categorize']);
});

test('invalid and unsupported webhook payloads do not run analysis', async t => {
  const fixture = await setup(t);
  assert.equal((await fixture.request('/webhooks', signed('{'))).status, 400);
  assert.equal((await fixture.request('/webhooks', signed({ ...event(), installation: { id: -1 } }))).status, 400);
  const ignored = await fixture.request('/webhooks', signed(event('pr', 'closed')));
  assert.equal((await ignored.json()).status, 'ignored');
  const original = signed(event(), 'same-delivery');
  await fixture.request('/webhooks', original);
  await fixture.waitForIdle();
  const replay = await fixture.request('/webhooks', signed(event(), 'changed-delivery-id'));
  assert.equal((await replay.json()).status, 'duplicate');
  assert.equal((await fixture.request('/webhooks', signed(event('pr', 'reopened'), 'same-delivery'))).status, 409);
  assert.equal(fixture.analyses.length, 1);
});

test('installation mismatch blocks analysis; failed jobs permit manual redelivery', async t => {
  let installation = 8;
  const failures = [];
  const fixture = await setup(t, {
    appOctokit: { request: async () => ({ data: { id: installation } }) },
    onJobError: error => failures.push(error),
  });
  const request = signed(event(), 'retry-delivery');
  await fixture.request('/webhooks', request);
  await fixture.waitForIdle();
  assert.equal(fixture.analyses.length, 0);
  assert.deepEqual(failures, [{ delivery: 'retry-delivery', status: 'failed' }]);
  installation = 7;
  await fixture.request('/webhooks', request);
  await fixture.waitForIdle();
  assert.equal(fixture.analyses.length, 1);
});

test('OAuth state requires matching browser cookie, is single use, and session expires', async t => {
  let time = 100;
  let exchanges = 0;
  const fixture = await setup(t, { now: () => time, exchangeOAuth: async () => { exchanges++; return 'token'; } });
  const start = await fixture.request('/auth/login', { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.equal((await fixture.request(`/auth/callback?state=${state}&code=code`)).status, 400);
  assert.equal(exchanges, 0);
  const session = await login(fixture);
  assert.match(session.cookie, /^github_session=[a-f0-9]{64}$/);
  assert.equal((await fixture.request(`/auth/callback?state=${session.state}&code=code`, {
    headers: { Cookie: `github_oauth_state=${session.state}` },
  })).status, 400);
  assert.equal((await fixture.request('/auth/session', { headers: { Cookie: session.cookie } })).status, 200);
  time += 60 * 60 * 1000 + 1;
  assert.equal((await fixture.request('/auth/session', { headers: { Cookie: session.cookie } })).status, 401);
});

test('config API requires session, manager permissions, installation and write CSRF', async t => {
  const fixture = await setup(t);
  const path = '/api/repos/owner/project/config';
  assert.equal((await fixture.request(path)).status, 401);
  const session = await login(fixture);
  const headers = { Cookie: session.cookie, 'Content-Type': 'application/json' };
  assert.equal((await fixture.request(path, { method: 'PUT', headers, body: '{}' })).status, 403);
  const valid = { ...headers, Origin: env.APP_URL, 'X-CSRF-Token': session.csrf };
  assert.equal((await fixture.request(path, { method: 'PUT', headers: { ...valid, Origin: 'https://evil.example' },
    body: '{}' })).status, 403);
  assert.equal((await fixture.request(path, { method: 'PUT', headers: valid, body: '{"unexpected":true}' })).status, 400);
  assert.equal((await fixture.request(path, { method: 'PUT', headers: valid, body: '{"maxTokens":-1}' })).status, 400);
  assert.equal((await fixture.request(path, { method: 'PUT', headers: valid,
    body: '{"publish":"review","features":["review","summary"]}' })).status, 200);
  const config = await fixture.request(path, { headers });
  assert.equal((await config.json()).config.publish, 'review');
  await fixture.request('/webhooks', signed(event()));
  await fixture.waitForIdle();
  assert.equal(fixture.analyses[0].config.publish, 'review');
  assert.deepEqual(fixture.analyses[0].config.features, ['review', 'summary']);
  await fixture.request('/webhooks', signed(event('issue'), undefined, 'issues'));
  await fixture.waitForIdle();
  assert.deepEqual(fixture.analyses[1].config.features, ['review', 'summary']);
  assert.equal((await fixture.request('/auth/logout', { method: 'POST', headers: valid })).status, 204);
  assert.equal((await fixture.request(path, { headers })).status, 401);
});

test('read API rejects non-managers and user/installation repository mismatch', async t => {
  for (const data of [{ id: 9, permissions: { push: true } }, { id: 999, permissions: { admin: true } }]) {
    const fixture = await setup(t, { oauthOctokit: () => ({ request: async route =>
      ({ data: route === 'GET /user' ? { id: 1, login: 'user' } : data }) }) });
    const session = await login(fixture);
    assert.equal((await fixture.request('/api/repos/owner/project/config', {
      headers: { Cookie: session.cookie },
    })).status, 403);
  }
});

test('bounded payloads and IP rate limits reject excess requests', async t => {
  const fixture = await setup(t);
  assert.equal((await fixture.request('/webhooks', signed('x'.repeat(1_048_577)))).status, 413);
  let last;
  for (let i = 0; i < 121; i++) last = await fixture.request('/health');
  assert.equal(last.status, 429);
});

test('settings persist atomically in a private file and concurrent writes are retained', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-app-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createSettingsStore(directory);
  await Promise.all([store.set(9, { publish: 'review' }), store.set(10, { publish: 'none' })]);
  const reloaded = await createSettingsStore(directory);
  assert.deepEqual(reloaded.get(9), { publish: 'review' });
  assert.deepEqual(reloaded.get(10), { publish: 'none' });
  const filename = join(directory, 'repositories.json');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal(Object.keys(JSON.parse(await readFile(filename, 'utf8'))).length, 2);
  const value = reloaded.get(9);
  value.publish = 'none';
  assert.equal(reloaded.get(9).publish, 'review');
});

test('startup requires credentials and production HTTPS', async () => {
  await assert.rejects(createApp({ env: { ...env, GITHUB_WEBHOOK_SECRET: '' } }), /Missing required/);
  await assert.rejects(createApp({ env: { ...env, NODE_ENV: 'production' } }), /Invalid APP_URL/);
});
