import express from 'express';
import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { createSettingsStore } from './store.js';

const HOUR = 60 * 60 * 1000;
const identifier = /^[A-Za-z0-9_.-]{1,100}$/;
const configKeys = new Set(['model', 'maxTokens', 'maxInputChars', 'prompt', 'features', 'publish']);
const randomToken = () => randomBytes(32).toString('hex');
const secureEqual = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function verifySignature(body, signature, secret) {
  if (!Buffer.isBuffer(body) || !/^sha256=[a-f0-9]{64}$/.test(signature ?? '')) return false;
  return secureEqual(signature, `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
}

function cookies(req) {
  const result = Object.create(null);
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function httpError(status) {
  const error = new Error('Request failed');
  error.httpStatus = status;
  return error;
}

export async function exchangeOAuth(code, env) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET,
      code, redirect_uri: `${env.APP_URL}/auth/callback`,
    }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) throw httpError(502);
  const body = await response.json();
  if (typeof body.access_token !== 'string' || body.access_token.length > 4096) throw httpError(502);
  return body.access_token;
}

export async function createApp(options = {}) {
  const env = { ...process.env, ...options.env };
  for (const name of ['GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET',
    'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ANTHROPIC_API_KEY']) {
    if (!env[name]?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  }
  if (!/^[1-9]\d*$/.test(env.GITHUB_APP_ID)) throw new Error('Invalid GITHUB_APP_ID');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const url = new URL(env.APP_URL ?? `http://127.0.0.1:${port}`);
  const production = env.NODE_ENV === 'production';
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    || (production && url.protocol !== 'https:')) throw new Error('Invalid APP_URL');
  env.APP_URL = url.origin;
  const normalize = options.normalizeConfig ?? (await import('../lib/config.js')).normalizeConfig;
  const analyze = options.analyzeTarget ?? (await import('../lib/integration.js')).analyzeTarget;
  const claude = options.claude ?? (await import('../lib/claude.js')).createClaude({ apiKey: env.ANTHROPIC_API_KEY });
  const store = options.store ?? await createSettingsStore(env.DATA_DIR ?? 'data');
  const appGitHub = options.appOctokit ?? new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_PRIVATE_KEY.replaceAll('\\n', '\n'),
      clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    request: { timeout: 15_000 },
  });
  const installationClient = options.installationOctokit ?? (async (installationId) => {
    const auth = await appGitHub.auth({ type: 'installation', installationId });
    return new Octokit({ auth: auth.token, request: { timeout: 15_000 } });
  });
  const userClient = options.oauthOctokit ?? ((token) => new Octokit({ auth: token, request: { timeout: 15_000 } }));
  const exchange = options.exchangeOAuth ?? ((code) => exchangeOAuth(code, env));
  const now = options.now ?? Date.now;
  const sessions = new Map();
  const states = new Map();
  const deliveries = new Map();
  const payloads = new Map();
  const rates = new Map();
  const jobs = new Set();
  const ttl = 24 * HOUR;
  let active = 0;
  function prune(map) {
    for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
  }
  function limited(key, maximum) {
    prune(rates);
    let rate = rates.get(key);
    if (!rate) {
      if (rates.size >= 10_000) return true;
      rates.set(key, rate = { count: 0, expires: now() + 60_000 });
    }
    return ++rate.count > maximum;
  }
  function setCookie(res, name, value, maxAge) {
    res.cookie(name, value, { httpOnly: true, secure: url.protocol === 'https:', sameSite: 'lax',
      path: '/', maxAge });
  }
  async function installed(owner, repo) {
    const { data } = await appGitHub.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
    if (!Number.isSafeInteger(data.id) || data.id <= 0 || data.suspended_at) throw httpError(403);
    return data.id;
  }
  async function repository(req) {
    const { owner, repo } = req.params;
    if (!identifier.test(owner) || !identifier.test(repo)) throw httpError(400);
    const { data } = await userClient(req.session.token).request('GET /repos/{owner}/{repo}', { owner, repo });
    if (!data.permissions?.admin && !data.permissions?.maintain) throw httpError(403);
    const installationId = await installed(owner, repo);
    const github = await installationClient(installationId);
    const result = await github.request('GET /repos/{owner}/{repo}', { owner, repo });
    if (data.id !== result.data.id || !Number.isSafeInteger(data.id)) throw httpError(403);
    return data;
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    if (limited(`ip:${req.socket.remoteAddress}`, 120)) return res.status(429).json({ error: 'Rate limit exceeded' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/auth/login', (req, res) => {
    prune(states);
    if (states.size >= 1000) throw httpError(503);
    const state = randomToken();
    states.set(state, { expires: now() + 10 * 60_000 });
    setCookie(res, 'github_oauth_state', state, 10 * 60_000);
    const target = new URL('https://github.com/login/oauth/authorize');
    target.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, state,
      redirect_uri: `${env.APP_URL}/auth/callback` }).toString();
    res.redirect(target.href);
  });
  app.get('/auth/callback', async (req, res) => {
    prune(states);
    const { state, code } = req.query;
    if (typeof state !== 'string' || !states.has(state)
      || !secureEqual(state, cookies(req).github_oauth_state)
      || typeof code !== 'string' || code.length < 1 || code.length > 512) throw httpError(400);
    states.delete(state);
    setCookie(res, 'github_oauth_state', '', 0);
    prune(sessions);
    if (sessions.size >= 1000) throw httpError(503);
    const token = await exchange(code);
    const { data } = await userClient(token).request('GET /user');
    if (!Number.isSafeInteger(data.id)) throw httpError(502);
    const id = randomToken();
    const csrf = randomToken();
    sessions.set(id, { token, csrf, user: { id: data.id, login: data.login }, expires: now() + HOUR });
    setCookie(res, 'github_session', id, HOUR);
    res.json({ user: { id: data.id, login: data.login }, csrfToken: csrf });
  });
  function authenticate(req, _res, next) {
    prune(sessions);
    const id = cookies(req).github_session;
    const session = sessions.get(id);
    if (!session) throw httpError(401);
    if (limited(`user:${session.user.id}`, 30)) throw httpError(429);
    req.session = session;
    req.sessionId = id;
    next();
  }
  function csrf(req, _res, next) {
    if (req.headers.origin !== env.APP_URL
      || !secureEqual(req.headers['x-csrf-token'], req.session.csrf)) throw httpError(403);
    next();
  }
  app.get('/auth/session', authenticate, (req, res) =>
    res.json({ user: req.session.user, csrfToken: req.session.csrf }));
  app.post('/auth/logout', authenticate, csrf, (req, res) => {
    sessions.delete(req.sessionId);
    setCookie(res, 'github_session', '', 0);
    res.status(204).end();
  });
  app.get('/api/repos/:owner/:repo/config', authenticate, async (req, res) => {
    const repo = await repository(req);
    res.json({ config: normalize(store.get(repo.id)) });
  });
  app.put('/api/repos/:owner/:repo/config', authenticate, csrf, express.json({ limit: '16kb', strict: true }),
    async (req, res) => {
      const repo = await repository(req);
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(key => !configKeys.has(key))) {
        throw httpError(400);
      }
      let config;
      try { config = normalize(req.body); } catch { throw httpError(400); }
      await store.set(repo.id, config);
      res.json({ config });
    });
  app.post('/webhooks', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (!verifySignature(req.body, req.headers['x-hub-signature-256'], env.GITHUB_WEBHOOK_SECRET)) {
      throw httpError(401);
    }
    const delivery = req.headers['x-github-delivery'];
    if (typeof delivery !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(delivery)) throw httpError(400);
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { throw httpError(400); }
    if (!payload || typeof payload !== 'object') throw httpError(400);
    const event = req.headers['x-github-event'];
    const kind = event === 'pull_request' ? 'pr' : event === 'issues' ? 'issue' : undefined;
    const supported = kind === 'pr' ? ['opened', 'synchronize', 'reopened'] : ['opened', 'reopened'];
    if (!kind || !supported.includes(payload.action)) return res.status(202).json({ status: 'ignored' });
    const owner = payload.repository?.owner?.login;
    const repo = payload.repository?.name;
    const number = (kind === 'pr' ? payload.pull_request : payload.issue)?.number;
    const installationId = payload.installation?.id;
    if (!identifier.test(owner ?? '') || !identifier.test(repo ?? '')
      || !Number.isSafeInteger(number) || number < 1
      || !Number.isSafeInteger(installationId) || installationId < 1) throw httpError(400);
    prune(deliveries);
    prune(payloads);
    const digest = createHash('sha256').update(req.body).update(String(event)).digest('hex');
    const previous = deliveries.get(delivery);
    if (previous) {
      if (previous.digest !== digest) throw httpError(409);
      return res.status(202).json({ status: 'duplicate' });
    }
    if (payloads.has(digest)) return res.status(202).json({ status: 'duplicate' });
    if (active >= 8 || deliveries.size >= 10_000 || payloads.size >= 10_000) throw httpError(503);
    deliveries.set(delivery, { digest, expires: now() + ttl });
    payloads.set(digest, { expires: now() + ttl });
    active++;
    const job = Promise.resolve().then(async () => {
      if (await installed(owner, repo) !== installationId) throw httpError(403);
      const github = await installationClient(installationId);
      const { data } = await github.request('GET /repos/{owner}/{repo}', { owner, repo });
      const config = normalize({
        features: kind === 'pr' ? ['review', 'summary', 'tests'] : ['summary', 'categorize'],
        ...store.get(data.id),
      });
      await analyze({ github, claude, target: { owner, repo, number, kind }, config });
    }).catch(() => {
      deliveries.delete(delivery);
      payloads.delete(digest);
      // Deliberately exclude SDK errors, which may contain credentials or repository content.
      try { options.onJobError?.({ delivery, status: 'failed' }); } catch { /* Logging must not reject the job. */ }
    }).finally(() => { active--; jobs.delete(job); });
    jobs.add(job);
    res.status(202).json({ status: 'accepted' });
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, _req, res, _next) => {
    const upstream = error.status;
    const status = error.httpStatus ?? (error.type === 'entity.too.large' ? 413
      : error.type === 'entity.parse.failed' ? 400 : [401, 403, 404].includes(upstream) ? 403 : 500);
    res.status(status).json({ error: status >= 500 ? 'Service unavailable' : 'Request rejected' });
  });
  return { app, waitForIdle: () => Promise.all([...jobs]), port, host: env.HOST ?? '127.0.0.1' };
}
