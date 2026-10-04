# GitHub App server

Requires Node.js 22.12 or newer, the project's installed dependencies, and the shared `lib/` integration. Run:

```sh
npm start
```

This runs `node github-app/index.js`; `github-app/server.js` exports the injectable `createApp` factory.

The default listener is `127.0.0.1:3000`; `GET /health` returns `{"status":"ok"}`. There is no dashboard: configure repositories through the authenticated JSON API below.

## Register and install

1. Create a **GitHub App** in GitHub developer settings, not a standalone OAuth App.
2. Set its homepage and **user authorization callback URL** to your deployment origin and `https://your-host/auth/callback`, respectively. Enable user authorization. You do not need to request broad OAuth scopes.
3. Enable webhooks, with URL `https://your-host/webhooks` and a long, randomly generated webhook secret.
4. Repository permissions: **Metadata: read**, **Contents: read**, **Pull requests: read/write**, and **Issues: read/write**. Contents supplies PR context; write permissions allow comments and COMMENT reviews. No code is committed automatically.
5. Subscribe to **Pull request** and **Issues** events.
6. Generate an App private key. Install the App on selected repositories, then authorize your user through `/auth/login`. Installation and user authorization are separate steps.

For local development, expose the server with an HTTPS tunnel and use that same public origin for `APP_URL`, callback and webhook URLs. If testing only OAuth on localhost, register `http://127.0.0.1:3000/auth/callback` and use that origin consistently.

## Environment

Required:

| Variable | Value |
| --- | --- |
| `GITHUB_APP_ID` | Numeric App ID (not client ID) |
| `GITHUB_PRIVATE_KEY` | PEM private key; literal `\n` escapes are also accepted |
| `GITHUB_WEBHOOK_SECRET` | Secret matching the App webhook settings |
| `GITHUB_CLIENT_ID` | App's OAuth client ID |
| `GITHUB_CLIENT_SECRET` | App's OAuth client secret |
| `ANTHROPIC_API_KEY` | Anthropic API key |

Optional: `HOST` (default `127.0.0.1`), `PORT` (default `3000`), `APP_URL` (default `http://127.0.0.1:3000`, adjusted for PORT), `DATA_DIR` (default `data`), and `NODE_ENV`.

In production set `NODE_ENV=production` and an explicit HTTPS `APP_URL`; startup rejects an HTTP production origin. Terminate TLS at a trusted reverse proxy and keep the backend bound to loopback or a private network. Do not expose HTTP externally. The server deliberately does not trust forwarded IP headers: behind a proxy, its per-IP limits apply collectively to that proxy. Configure additional proxy-level limits if necessary. Do not log Authorization headers, cookies, OAuth callback query strings, webhook bodies, prompts, or SDK errors at the proxy.

Keep credentials in a secret manager/environment, never in source control. Store data on a persistent, private local filesystem. `DATA_DIR/repositories.json` contains settings, not access tokens; the directory is mode 0700 and the atomic-write file mode 0600. **Ensure `data/` (or your custom data directory) is ignored in Git before starting**; this module does not modify the project's ignore rules. Alternatively set `DATA_DIR` to a private location outside the checkout. Back up settings securely; prompts may contain sensitive text.

## OAuth and settings API

Visit `GET /auth/login` in a browser. The callback verifies a single-use, ten-minute state tied to a browser cookie before exchanging the code. Success sets an HttpOnly, SameSite=Lax session cookie (Secure on HTTPS), and returns `{user, csrfToken}`. Sessions expire after one hour; access tokens and sessions are memory-only. Reauthorize after expiration/restart; no persistent refresh-token mechanism is implemented.

`GET /auth/session` returns the logged-in user and CSRF token. With that cookie:

- `GET /api/repos/OWNER/REPO/config` returns `{config}`.
- `PUT /api/repos/OWNER/REPO/config` accepts the configuration object **directly**, not a `{config: ...}` wrapper. It replaces the configuration, applying defaults to omitted fields.
- `POST /auth/logout` destroys the session.

Every write requires an `Origin` header equal to `APP_URL` and `X-CSRF-Token` equal to the session token. Browser same-origin requests include Origin automatically for writes. Example, from a same-origin browser console after login:

```js
const { csrfToken } = await fetch('/auth/session').then(r => r.json());
await fetch('/api/repos/OWNER/REPO/config', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    maxTokens: 2048,
    maxInputChars: 60000,
    prompt: '',
    features: ['review', 'summary'],
    publish: 'review'
  })
});
```

Both reading and changing settings require the authenticated user's repository **admin or maintain** permission, a current App installation on that repository, and matching user/installation repository IDs. Merely possessing a cookie or an installation ID is insufficient. Permissions are checked with GitHub on each request.

Defaults come from `lib/config.js`: model `claude-sonnet-4-6`, 2048 output tokens, 60000 input characters, empty custom prompt, and publish mode `comment`. For unconfigured webhook targets, PR features default to `review`, `summary`, and `tests`; issue features default to `summary` and `categorize`. Persisted repository features override these event-specific defaults. The settings API returns the shared normalizer's default feature `review` until a configuration is saved; PUT applies that same default if features are omitted. Supported features are `review`, `summary`, `categorize`, `commit`, `tests`, and `docs`; allowed models and numeric constraints are validated by the shared normalizer. Publish modes are `comment`, `review`, and `none`. PR `review` publishing uses a COMMENT review with the entire Markdown analysis in its body. Suggestions may appear in fenced `suggestion` blocks in that body; these are descriptive, not guessed inline review positions or automatically applicable changes. Issues use comments. `none` analyzes without posting.

## Webhook processing and operational limits

The server handles PR `opened`, `synchronize`, and `reopened`, and issue `opened` and `reopened`. Other events/actions are acknowledged and ignored. SHA-256 webhook signatures are verified against the **raw bytes** with timing-safe comparison before JSON parsing. Processing independently verifies the current repository installation before using an installation-scoped token. Analysis/context/publishing use the shared integration and the repository's persisted settings.

Accepted events receive HTTP **202 before analysis completes**. Work runs in-process, with at most eight concurrent jobs. Delivery IDs plus payload/event hashes suppress duplicates for 24 hours; reuse with a changed payload/event is rejected. Identical payload/event hashes are also suppressed if a replay changes the unsigned delivery-ID header. These records are bounded and **not durable**. A restart loses jobs, OAuth sessions, and deduplication records. Failed jobs are removed from deduplication so operators can manually redeliver via GitHub's delivery UI. GitHub already received 202 and will not automatically retry a later analysis failure. Monitor the sanitized failure message and delivery ID. Failure after publishing may cause duplicate posts on redelivery; this is not exactly-once delivery. For durable processing, introduce an external queue/transactional deduplication before acknowledging; none is provided here.

Webhook bodies are capped at 1 MiB; settings requests at 16 KiB. Rate limits are 120 requests/minute/source IP and 30 authenticated requests/minute/user. Capacity exhaustion returns 503 (or 429 for rate limits). Expired OAuth state, sessions and delivery records are pruned on use. Settings support at most 1000 repositories and a 2 MB JSON file. Only one server process should write a given DATA_DIR; there is no cross-process locking. HTTP errors intentionally omit SDK details and credentials.

Validation uses injected mock SDK clients and loopback HTTP only:

```sh
node --test test/app.test.js
```
