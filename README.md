# claude-github-integration
Comprehensive Claude + GitHub integration with Actions, App, and standalone tool

## Setup

Requires Node.js 22+; no dependency installation is needed.

- **Action:** merge the implementation/workflow into the default branch, enable
  Actions, and add the `ANTHROPIC_API_KEY` repository secret. The workflow supplies
  its GitHub token and requests contents read plus PR/issue write permissions.
  Fork PRs run trusted default-branch logging only and are recorded as skipped,
  without GitHub API requests, Claude calls, or comment writes.
- **CLI:** set `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`, then run
  `npm run cli -- pr owner/repo 42` (add `--no-comment` to only print the review).
- **Webhook App:** also set `WEBHOOK_SECRET` and `APP_REPOSITORIES`, then run
  `npm run app` behind an HTTPS reverse proxy. Supply and maintain a valid GitHub
  token; the App does not automatically refresh it.

See [Audit logs and setup](docs/AUDIT_LOGS.md) for storage paths, examples,
workflow artifacts, security requirements, and safe webhook redelivery.
