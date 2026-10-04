# Audit logs and setup

The integration runs as a GitHub Action, a command-line tool, or a webhook App. All three use the same audit logger: friendly UTC console messages plus one JSON object per line in daily `.jsonl` files. No dashboard is included.

Use Node.js 22 or newer. The implementation uses Node's built-in APIs and has no package dependencies; there is no dependency-install step.

## Enable the GitHub Action

1. Merge the implementation and `.github/workflows/claude-review.yml` into the repository's **default branch**. The workflow checks out that branch, not the pull request's code.
2. Enable GitHub Actions and add the repository Actions secret `ANTHROPIC_API_KEY`.
3. Allow the workflow's declared permissions: `contents: read`, `pull-requests: write`, and `issues: write`. Organization policies must permit these permissions. The workflow supplies its GitHub token automatically.
4. Open, reopen, or update a same-repository PR, or open/reopen an issue. PR updates use the `synchronize` event; issue edits do not trigger this workflow.

The workflow sets up Node 22 and runs `node src/action.js` directly. It queues runs for the same resource rather than cancelling an active run.

During the first setup PR, the trusted default branch may not contain `src/action.js` yet. The workflow records `event_skipped` with `details.reason: "installation_pending"` in console output, the run summary, and the JSONL artifact instead of failing or running untrusted PR code. Merge the setup into the default branch to enable reviews.

Fork PRs run only the trusted default-branch implementation and emit `webhook_received` followed by `event_skipped`, with normal startup/completion logging and artifact upload. The shared event handler skips PRs whose head repository differs from the target repository **before any GitHub API request, Claude call, or comment write**. Fork runs do not need the Claude secret, which GitHub normally withholds from fork PRs. Repository settings may require approval before a fork workflow runs. Do not switch to `pull_request_target` to execute untrusted PR code with credentials. These automatic fork protections do not prevent an operator from explicitly analyzing a PR with the CLI.

Read friendly messages in the workflow's **Analyze and show the audit trail** step and in the run's **Summary** (`GITHUB_STEP_SUMMARY`). Download JSONL from the artifact named `claude-audit-<run_id>-<run_attempt>`.

The upload step uses `if: always()`, including after a failed review, and requests **30-day retention**. Upload still requires a running job and existing files: a skipped job, unavailable runner, or failure before log creation cannot supply an artifact. Missing files produce a warning. Repository/organization artifact policies may constrain retention.

## Run the CLI

Supply `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` through your environment or secret manager; do not paste credentials into shared shell history. The GitHub token needs access to the chosen repository and permission to read PRs/issues and post issue comments. PR comments use the issue-comments API.

```sh
cd /home/runner/work/claude-github-integration/claude-github-integration
npm run cli -- pr example-org/example-repo 42
npm run cli -- issue example-org/example-repo 7
npm run cli -- pr example-org/example-repo 42 --no-comment
```

By default the CLI posts the review as a comment, then prints the review. `--no-comment` still calls GitHub and Claude but does not post a comment. Audit messages go to **stderr**; review text goes to **stdout**. To capture only review text without npm's script banner:

```sh
node /home/runner/work/claude-github-integration/claude-github-integration/src/cli.js pr example-org/example-repo 42 --no-comment > review.txt
```

That output file contains review content, not audit records; protect it accordingly. Failed commands set a nonzero exit code. Help/no arguments print usage without starting an audit logger.

## Run the webhook App

Set these environment variables before starting:

| Variable | Purpose |
| --- | --- |
| `GITHUB_TOKEN` | A supplied, currently valid GitHub PAT or installation access token with access to the allowed repositories and permission to read resources/post issue comments. |
| `ANTHROPIC_API_KEY` | Claude API credential. |
| `WEBHOOK_SECRET` | Shared secret configured on the GitHub webhook. |
| `APP_REPOSITORIES` | Exact, comma-separated repository names, such as `example-org/example-repo,example-org/another-repo`. Do not add spaces around names. |
| `PORT` | Optional listening port; defaults to `3000`. |
| `AUDIT_LOG_DIR` | Optional audit directory override. |
| `CLAUDE_MODEL` | Optional model override for any component; defaults to `claude-sonnet-4-5-20250929`. |

```sh
cd /home/runner/work/claude-github-integration/claude-github-integration
npm run app
```

This is a webhook server, not an automatic GitHub App token issuer. It does **not** mint or refresh installation tokens. Obtain and rotate/replace the supplied token yourself, restarting the process when its environment changes.

The server binds to **`127.0.0.1`**, not a public interface. Configure an **HTTPS reverse proxy** to forward your public webhook endpoint to `http://127.0.0.1:3000/webhook` (adjust for `PORT`). Preserve the raw body and GitHub headers. In GitHub, configure a JSON webhook with the matching secret and subscribe to pull request and issue events.

The App accepts only `POST /webhook`, limits bodies to **1,048,576 bytes (1 MiB)**, and verifies `X-Hub-Signature-256` using HMAC-SHA256 and a timing-safe comparison before parsing the JSON. Only repositories in `APP_REPOSITORIES` are enabled. Supported review actions are PR `opened`, `synchronize`, `reopened`, and issue `opened`, `reopened`; unsupported actions and fork PRs are skipped.

GitHub webhook headers and body format:

| Header | Value / use |
| --- | --- |
| `Content-Type` | Configure GitHub to send `application/json`. The App parses JSON; it does not separately enforce this header. |
| `X-Hub-Signature-256` | String `sha256=<hex HMAC of the exact body>`, required for verification. |
| `X-GitHub-Event` | Event name such as `pull_request` or `issues`; selects the shared event handler. An unsupported/missing event does not trigger analysis. |
| `X-GitHub-Delivery` | Delivery ID used for in-memory duplicate suppression and receipt metadata when supplied. |

Node exposes these headers under lowercase names. App replies use `Content-Type: text/plain`. Outbound GitHub API calls use the `Authorization` header with bearer authentication, `Accept: application/vnd.github+json` (or `application/vnd.github.diff` for PR changes), and `X-GitHub-Api-Version: 2022-11-28`. Claude requests use `x-api-key` and `anthropic-version: 2023-06-01`. Both services receive `Content-Type: application/json`; credentials are not logged.

### Delivery limits and safe redelivery

- Only **one notification is processed at a time** in each server process. Another eligible delivery receives HTTP **503** with a `rate_limited` audit failure; there is no background queue. Redeliver it from GitHub after the active request finishes.
- Completed delivery IDs are kept **in memory**, for approximately **one hour**, capped at **1,000** IDs (oldest evicted at capacity). Expired IDs are pruned on subsequent eligible requests. This cache also records successfully skipped notifications after they pass through the shared handler.
- A repeated cached ID receives HTTP 200 with `event_skipped`, not another review. Missing IDs and failed requests are not cached. Allowlist rejections occur before caching.
- Restarting clears the cache. It is **not durable deduplication or an exactly-once guarantee**. An external operation, such as posting a comment, can succeed before a later failure, leaving a redelivery able to repeat it.
- Processing is **synchronous**: the App waits for GitHub requests, Claude analysis, and comment posting before replying. Each outbound API request has a 60-second timeout; the overall operation can exceed GitHub's webhook response timeout. A delivery marked failed in GitHub may still be running or may have posted a comment.

**Inspect the audit log and target PR/issue comments before redelivery**, especially after a timeout or storage failure. Wait for any active processing to finish, resolve the cause, and then redeliver only if needed. Invalid signatures return 401, malformed JSON 400, oversized bodies 413, and unhandled processing failures generally 500; a service error may supply its own HTTP status.

## Where records are stored

| Component | Default JSONL directory | Console destination |
| --- | --- | --- |
| `cli` | `~/.claude-github-integration/logs/` | stderr |
| `github-action` | `logs/github-action/` under the working directory when run directly | stderr and the run step summary when `GITHUB_STEP_SUMMARY` is set |
| `app` | `logs/app/` under the working directory | stderr |

`AUDIT_LOG_DIR` overrides these defaults for all components. The supplied workflow explicitly sets it to `${{ runner.temp }}/claude-audit`; its JSONL files are uploaded as described above. When started from this checkout, the App's default is `/home/runner/work/claude-github-integration/claude-github-integration/logs/app/`.

For the Action, GitHub supplies `GITHUB_EVENT_PATH` (the JSON event file read by `src/action.js`) and `GITHUB_STEP_SUMMARY` (the summary file appended by the logger). `GITHUB_REPOSITORY`, `GITHUB_ACTOR`, and `GITHUB_EVENT_NAME` provide startup context. The workflow maps `${{ github.token }}` to `GITHUB_TOKEN`, `${{ secrets.ANTHROPIC_API_KEY }}` to `ANTHROPIC_API_KEY`, and `${{ runner.temp }}` into `AUDIT_LOG_DIR`; the artifact path is `${{ runner.temp }}/claude-audit/*.jsonl`. These paths are runner-specific, not fixed directories on the local machine.

Files are named by **UTC date**, for example `2026-10-04.jsonl`, and appended to rather than overwritten. Entries after UTC midnight go into the next date's file. The logger creates/chmods directories to `0700` and files to `0600`.

There is **no automatic deletion of local/App logs** and no local 30-day retention rule. Operators must archive or manually delete old date files according to their own policy; avoid deleting the current active file. Action artifacts expire under GitHub's retention policy. A failed run's already-saved records remain useful even if no completion event was written.

### Storage failures

JSONL is written before the friendly console message and summary entry. A file append/chmod failure prints:

```text
❌ Audit record could not be saved. Check the log folder permissions and free disk space.
```

It then throws `Audit storage is unavailable.`; it does not silently continue with console-only logging. Directory creation/permission failures can prevent startup. CLI/Action entry points report failures and set a nonzero exit code; App failures can prevent startup or fail a request. When App logging fails outside the processing slot or while recording a pre-processing error, it replies HTTP 503 without taking action; failures during processing generally return 500. Recording the error can itself fail when storage is unavailable. A summary append can also fail after JSONL and console output succeeded.

Do not assume a failed audit write means no API call or comment happened. Earlier operations may already have completed, and a line can have been appended before a permission change failed. Restore writable storage and inspect existing records/comments before retrying.

## Reading an entry

Friendly messages show UTC time, action name, component, user, event, optional repository/resource, status, a plain-language explanation, and available links. This fictional successful PR analysis illustrates the actual format:

```text
📝 [2026-10-04 22:40:00 UTC] Claude Analysis Complete
   Component: cli | User: local-user | Event: manual
   Repo: example-org/example-repo
   PR #42: "Improve validation"
   Status: ✅ Success
   Claude analyzed pull request #42. The review is ready to read; no comment was requested.
   repository: https://github.com/example-org/example-repo
   pr: https://github.com/example-org/example-repo/pull/42
```

The corresponding JSONL line is a single JSON object (formatted below for readability):

```json
{
  "timestamp": "2026-10-04T22:40:00.000Z",
  "actionId": "5dcbf156-fbfa-4e1b-864e-3bbc3fefb894",
  "actionType": "pr_analysis_complete",
  "component": "cli",
  "repository": "example-org/example-repo",
  "user": "local-user",
  "event": "manual",
  "pr": {
    "number": 42,
    "title": "Improve validation",
    "url": "https://github.com/example-org/example-repo/pull/42"
  },
  "status": "success",
  "humanReadable": "Claude analyzed pull request #42. The review is ready to read; no comment was requested.",
  "details": {
    "analysisTimeMs": 1250,
    "inputTruncated": false
  },
  "links": {
    "repository": "https://github.com/example-org/example-repo",
    "pr": "https://github.com/example-org/example-repo/pull/42"
  }
}
```

| Field | Meaning |
| --- | --- |
| `timestamp` | ISO 8601 UTC timestamp, including milliseconds. |
| `actionId` | New UUID for this entry; not a webhook delivery ID or a shared review ID. |
| `actionType` | Machine-readable action listed below. |
| `component` | `cli`, `github-action`, or `app`. |
| `repository` | `owner/repo`, or `null` when not known. |
| `user` | CLI: `GITHUB_ACTOR` or `local-user`; Action startup: `GITHUB_ACTOR`; verified event processing: payload sender login. App startup uses `operator`, pre-verification requests use `unverified`; otherwise the fallback is `unknown`. |
| `event` | CLI: `manual`; Action startup: event name; event handling: e.g. `pull_request.opened` or `issues.reopened`. App startup uses `startup`, pre-verification requests `webhook`; fallback is `manual`. |
| `pr` / `issue` | Optional resource object with `number`, `title`, `url`. Before loading a CLI resource, its title is `(title not loaded yet)`. |
| `status` | `in_progress` (⏳), `success` (✅), `failure` (❌), or `skipped` (➖). Default is `success`. |
| `humanReadable` | Required plain-language description, not a raw exception stack. |
| `details` | Structured metadata; defaults to `{}`. Analysis completion has `analysisTimeMs` and `inputTruncated`; service failures may have `service`, `httpStatus`, and `retryAfter`. App webhook receipt can include `deliveryId`; the Action does not supply one. |
| `links` | Automatically includes `repository` when known and `pr`/`issue` when present in context; `comment` is added after posting. Action entries also include `workflow`, pointing to `https://github.com/<owner/repo>/actions/runs/<run_id>`, when `GITHUB_RUN_ID` and `GITHUB_REPOSITORY` are set. Context-provided links and explicit entry links can extend/override defaults. `{}` when no links are available. |

Analysis timing includes resource fetching and Claude analysis, but not subsequent comment posting. Large review input is limited to the first 100,000 characters and flagged with `inputTruncated`. Claude returns free text: logs do **not** promise structured suggestion counts or a fixed number of recommendations.

### Action types

| `actionType` | Console name | What it tells you |
| --- | --- | --- |
| `component_started` | Integration Started | An entry point started; App startup means it is listening. This is not proof of valid API credentials. |
| `component_stopped` | Integration Stopped | Normal command/Action completion or App signal shutdown. Not guaranteed after failure. |
| `webhook_received` | GitHub Notification Received | Shared handler started checking an event (`in_progress`). Action uses this label for its workflow event; it is not an HTTP server. |
| `webhook_processed` | GitHub Notification Processed | Review and comment posting finished for a supported event. Skipped/failed events do not emit it. |
| `event_skipped` | No Action Needed | Unsupported event, fork PR, disallowed App repository, duplicate delivery, or wrong App endpoint (`skipped`). |
| `pr_analysis_started` | PR Analysis Started | PR analysis began (`in_progress`). |
| `pr_analysis_complete` | Claude Analysis Complete | Claude returned PR review text; posting may still fail afterward. |
| `issue_analysis_started` | Issue Analysis Started | Issue analysis began (`in_progress`). |
| `issue_analysis_complete` | Claude Issue Analysis Complete | Claude returned issue review text; posting may still fail afterward. |
| `resource_loaded` | GitHub Description Loaded | The resource title and description were fetched successfully; their content is not included in the audit message. |
| `changes_loaded` | Code Changes Loaded | The PR diff was fetched successfully; the diff itself is not logged. PR only. |
| `comment_posting_started` | Posting Review Comment | Sending the review comment to GitHub began (`in_progress`); not proof that GitHub accepted it. Absent with `--no-comment`. |
| `comment_posted` | Comment Posted | GitHub accepted a comment; open `links.comment` to read it. |
| `rate_limited` | Service Is Busy | API throttling or App's occupied processing slot (`failure`). |
| `authentication_failed` | Authentication Problem | Missing/denied API credentials, invalid webhook signature, or missing App secret/allowlist (`failure`). |
| `error_occurred` | Error Occurred | Other errors, including invalid input, unreachable services, malformed events, or empty Claude text (`failure`). |

## Examples by component

The following fictional examples describe emitted events, not extra features. Resource links point to PR #42 or issue #7 in `example-org/example-repo`; titles and usernames are illustrative. Unless noted, analysis posts a comment.

### GitHub Action

| Scenario | Audit trail / example |
| --- | --- |
| Successful PR analysis | `component_started` → `webhook_received` → `pr_analysis_started` → `resource_loaded` → `changes_loaded` → `pr_analysis_complete` → `comment_posting_started` → `comment_posted` → `webhook_processed` → `component_stopped`. Resource events use `event: "pull_request.opened"` and payload sender as `user`. |
| Issue processed | `webhook_received` (`event: "issues.opened"`) → `issue_analysis_started` → `resource_loaded` → `issue_analysis_complete` → `comment_posting_started` → `comment_posted` → `webhook_processed`, between startup/shutdown entries. Completion says: `The GitHub notification has been handled. Claude completed the review and posted a comment.` |
| Error | After `pr_analysis_started`, an unreachable Claude service produces `error_occurred`, `status: "failure"`, description `Claude could not be reached. Check your connection and try again.` No successful processed/stopped entry follows. The run fails; artifact upload is still attempted. |
| Rate limiting | A Claude HTTP 429 produces `rate_limited`, failure, `details: {"service":"Claude","httpStatus":429,"retryAfter":"60"}` if that header is present. Description: `Claude is temporarily limiting requests. Wait before trying again.` No automatic retry is implemented. |
| Authentication issue | Missing Action secret produces `authentication_failed`, failure, `details: {"service":"Claude"}`, description `Claude is not connected. Set ANTHROPIC_API_KEY and try again.` GitHub 401/403 permission failures similarly identify `service: "GitHub"` and `httpStatus`. |
| Notification received/processed | Receipt says `GitHub sent a pull request notification from example-bot. The integration is checking what needs to happen.` A valid payload supplies its resource number/title and repository/resource links before receipt is logged; the Action supplies no delivery ID. `webhook_processed` appears only after analysis and comment posting succeed. |
| Fork PR skipped safely | `component_started` → `webhook_received` → `event_skipped` → `component_stopped`. The skipped entry says `This pull request comes from another repository. Automatic review is disabled to protect credentials and usage costs.` It has repository/PR links, but no analysis, Claude call, GitHub API request, or comment write. Summary and JSONL artifact are still produced when the run is permitted to execute. |

### CLI

| Scenario | Audit trail / example |
| --- | --- |
| Successful PR analysis | `component_started` → `pr_analysis_started` → `resource_loaded` → `changes_loaded` → `pr_analysis_complete` → `comment_posting_started` → `comment_posted` → `component_stopped`, with `event: "manual"` and usually `user: "local-user"`. Review text is printed separately on stdout. |
| Issue processed manually | `npm run cli -- issue example-org/example-repo 7` emits `issue_analysis_started`, `resource_loaded`, `issue_analysis_complete`, `comment_posting_started`, `comment_posted` between startup/shutdown. Completion says `Claude analyzed issue #7. The review is ready to post.` |
| Error | An invalid resource number produces `error_occurred`, failure, description `Choose a repository as owner/name and a positive PR or issue number.` A GitHub HTTP 500 during analysis produces `details: {"service":"GitHub","httpStatus":500}` and description `GitHub could not complete the request (response 500). Try again later.` |
| Rate limiting | GitHub HTTP 403 with `x-ratelimit-remaining: 0` produces `rate_limited`, failure, `details: {"service":"GitHub","httpStatus":403}` (plus `retryAfter` if supplied). Wait before manually rerunning. |
| Authentication issue | Missing `GITHUB_TOKEN` produces `authentication_failed`, failure, `details: {"service":"GitHub"}`, description `GitHub is not connected. Set GITHUB_TOKEN and try again.` |
| Webhook received/processed | **Not applicable.** Direct CLI commands do not receive webhooks or emit `webhook_received`/`webhook_processed`. The manual PR/issue commands above are the equivalent operator-driven analysis. |
| Read without posting | With `--no-comment`, analysis completion says `The review is ready to read; no comment was requested.` There is no `comment_posting_started` or `comment_posted`; review stdout and audit stderr still work. |

### Webhook App

| Scenario | Audit trail / example |
| --- | --- |
| Successful PR analysis | After one server `component_started`, a signed allowlisted `pull_request.opened` delivery emits `webhook_received` → `pr_analysis_started` → `resource_loaded` → `changes_loaded` → `pr_analysis_complete` → `comment_posting_started` → `comment_posted` → `webhook_processed`, then HTTP 200. The server stays running; no per-delivery `component_stopped`. |
| Issue processed | A signed allowlisted `issues.reopened` delivery emits `webhook_received`, `issue_analysis_started`, `resource_loaded`, `issue_analysis_complete`, `comment_posting_started`, `comment_posted`, `webhook_processed`, then HTTP 200. Resource entries include `issue` and `links.issue`. |
| Error | An oversized request produces `error_occurred`, failure, `details: {"httpStatus":413}`, description `The GitHub notification is too large to process safely.` It is rejected before `webhook_received`. Unreachable API services during analysis instead produce the same service error descriptions as other components. |
| Rate limiting | An occupied processing slot produces `rate_limited`, failure, `details: {"httpStatus":503}`, description `The App is handling another notification. Redeliver this notification in GitHub after it finishes.` This rejected delivery does not reach `webhook_received`. API HTTP 429 errors also emit `rate_limited` with service metadata. |
| Authentication issue | Invalid signature produces `authentication_failed`, failure, `user: "unverified"`, `event: "webhook"`, `repository: null`, `details: {"httpStatus":401}`, description `The App could not verify this notification came from GitHub. Check the webhook secret.` Expired supplied tokens fail later with GitHub authentication metadata. |
| Webhook received/processed | Verified, allowlisted receipt may contain `details: {"deliveryId":"example-delivery-42"}` and says `GitHub sent a pull request notification from example-bot. The integration is checking what needs to happen.` Valid resource payloads also supply the resource object and repository/resource links at receipt. Successful processed entries include those links but not the delivery ID. Inspect nearby entries as well as comments before redelivery. |
| Duplicate/ignored event | A cached ID emits only `event_skipped` for that retry and returns 200. Unsupported actions/fork PRs reach `webhook_received` then `event_skipped`, not `webhook_processed`; no review or comment is made. |

Across all components, HTTP 401/403 are authentication failures unless the 403 meets the rate-limit checks (`x-ratelimit-remaining: 0` or a `retry-after` header). Failures do not automatically retry API requests.

## Privacy and sharing

Audit records exclude source code, diffs, prompts, issue descriptions, API response bodies, and Claude review/comment content. Those inputs are still sent to Claude for analysis, and a normal review is posted to GitHub (or printed by the CLI); exclusion from audit logs is not exclusion from the integration's processing.

Logs **do contain metadata**: repository names, GitHub usernames, full resource titles, resource/comment URLs, timestamps, delivery IDs when supplied, and service status/timing information. These can identify private work or people.

The logger redacts exact configured credential values, recognized GitHub/Anthropic token patterns, bearer credentials, and object values whose keys look like tokens, secrets, passwords, authorization, API keys, or private keys. It also removes control characters. Redaction is not comprehensive: arbitrary sensitive text in titles/usernames/URLs, unfamiliar credential formats, or other metadata can remain.

**Manually inspect and sanitize exported JSONL, console output, summaries, and downloaded artifacts before sharing.** Treat them as potentially sensitive, restrict access, and apply an appropriate cleanup policy. Do not put private data or real credentials into documentation examples.

## Export and share

- **Action:** open **Actions → the run → Artifacts**, download `claude-audit-<run_id>-<run_attempt>`, and extract the desired UTC-date `.jsonl` files.
- **CLI/App:** locate files in `AUDIT_LOG_DIR` or the default directories above, select only the dates needed, and copy them to a restricted sharing location. For example, list App files with `find /home/runner/work/claude-github-integration/claude-github-integration/logs/app -maxdepth 1 -type f -name '*.jsonl'`. For CLI logs, use `find "$HOME/.claude-github-integration/logs" -maxdepth 1 -type f -name '*.jsonl'`.

JSONL is newline-delimited JSON (NDJSON): **one complete JSON object per line**, not a JSON array. Share the selected files directly with tools that support NDJSON, or optionally convert one selected file to an array using Node 22 stdin/stdout (no helper script required):

```sh
node --input-type=module -e 'import { readFileSync } from "node:fs"; const entries = readFileSync(0, "utf8").split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); process.stdout.write(JSON.stringify(entries, null, 2) + "\n");' < "$HOME/.claude-github-integration/logs/2026-10-04.jsonl"
```

This prints the array; redirect stdout only to an access-controlled destination if needed. It loads the selected file into memory. Conversion does not redact anything: inspect and sanitize a copy before sharing, preserve originals for investigation, and avoid collecting unrelated dates or review stdout.

## Troubleshooting

| Symptom | Check / next step |
| --- | --- |
| No logs or audit-storage errors | Check the effective `AUDIT_LOG_DIR`, working directory/home, directory permissions, free disk space, and stderr. CLI help creates no logs. Restore storage before retrying; an earlier API operation may already have succeeded. |
| Missing credential or HTTP 401/403 | Check `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, token expiry, repository access, and comment-write permissions. The App does not refresh tokens. A 403 with rate-limit headers is throttling instead. |
| `rate_limited`, HTTP 429, or App busy 503 | Wait, honor `retryAfter` when supplied, and inspect the active request before manually rerunning/redelivering. There is no automatic API retry or App queue. |
| Analysis succeeded but no comment | `*_analysis_complete` is not posting confirmation. Check later errors, `comment_posting_started`/`comment_posted`, GitHub write permissions, and CLI `--no-comment`. Inspect existing comments before retrying. |
| Fork or repository skipped | Automatic fork reviews intentionally emit `event_skipped`; they do not call Claude or GitHub APIs. Check exact comma-separated `APP_REPOSITORIES` names for App allowlist skips and whether the event action is supported. |
| `installation_pending` | The setup has not reached the default branch. Merge the implementation before expecting automatic reviews; the bootstrap skip still provides a summary and artifact. |
| Invalid webhook signature | Match GitHub's secret to `WEBHOOK_SECRET` and preserve the exact raw body and `X-Hub-Signature-256` through the HTTPS proxy. Do not reserialize JSON or disable signature verification. |
| GitHub delivery timeout or unexpected duplicate | Processing is synchronous and may outlast GitHub's timeout. Inspect audit logs and comments before redelivery; wait if busy. Deduplication lasts about one hour/1,000 IDs in memory and resets on restart, so it cannot guarantee exactly-once posting. |
| Artifact absent | Check whether the job actually ran (Actions disabled, approval pending, or another platform restriction), whether logging reached file creation, the upload warning, and artifact expiry. `always()` attempts upload after failure but cannot upload nonexistent files or run in a job that never started. |
