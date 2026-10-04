# Claude + GitHub integration

Three ways to use the **Anthropic Claude API** with GitHub: an Action, an installable
GitHub App, and a local/CI CLI. An Anthropic API key and API billing are required;
a Claude chat or GitHub Copilot subscription does not supply API access.

## Quick start

**Action:** add `ANTHROPIC_API_KEY` as a repository Actions secret, copy
[`github-action/workflow.yml`](github-action/workflow.yml) into your repository's
`.github/workflows/claude.yml`, and pin the action reference to a reviewed commit.
It comments on new/updated same-repository PRs and new issues without executing PR code.
Fork PRs are deliberately skipped. [Action setup](docs/github-action.md)

**CLI (Node.js 22.12+):**

```sh
npm ci
export ANTHROPIC_API_KEY='your-anthropic-api-key'
export GITHUB_TOKEN='your-github-personal-access-token'
node cli/index.js pr OWNER/REPO 123
node cli/index.js issue OWNER/REPO 45 --features summary,categorize
node cli/index.js code src/example.js --features tests,docs
node cli/index.js pr OWNER/REPO 123 --publish review
```

Use environment variables or your secret manager, never checked-in keys.
The CLI prints results without posting unless `--publish` is specified.
You can also run `npm link` and use `claude-github`. [CLI guide](docs/cli.md)

**GitHub App:** register an App, subscribe to PR/issue webhooks, configure OAuth
and installation credentials, and run `npm start` behind HTTPS.
Repository administrators can persist settings through the authenticated API.
[App setup and OAuth guide](docs/github-app.md)

## Features and configuration

| Feature | Behavior |
| --- | --- |
| `review` | Code review with concrete suggestions |
| `summary` | PR/issue summary and open questions |
| `categorize` | Suggested category and priority (does not apply labels) |
| `commit` | Conventional commit message generation |
| `tests` | Focused test suggestions and examples |
| `docs` | Usage/API documentation generation |

Combine features with `--features review,summary,tests`, Action inputs, or App
repository settings. All three approaches share the same Claude and GitHub helpers.
Optional custom prompts are trusted administrator instructions; repository content
is treated as untrusted data. Suggestions are Markdown in comments or COMMENT
reviews, not automatic code edits, approvals, or guaranteed inline suggestions.

Defaults: model `claude-sonnet-4-6`, 2048 output tokens, 60000 input characters,
and bounded input truncation. Set a model your Anthropic account can access.
Output tokens are limited to 8192 and input to 200000 characters.
PR context includes the title, description, base/head SHAs, and paginated file
patches. Binary/large patches and truncated context are explicitly identified.
Issue context contains the title, description, and labels, not the full discussion.

## Layout and development

```text
github-action/  Composite action, event runner, example workflow
github-app/     Express server, signed webhooks, OAuth, persistent configuration
cli/            Command-line interface
lib/            Claude SDK, GitHub SDK, validation, analysis orchestration
docs/           Per-approach setup and usage
test/           Node built-in tests with mock API clients
```

```sh
npm ci
npm test
```

Tests do not need live credentials. There is no compile step.

## Safety and operational limits

- Source code, issue content, and PR patches are sent to Anthropic. Obtain
  permission before sending private/sensitive code; avoid files containing secrets.
- Never use `pull_request_target` to execute untrusted PR code with secrets.
  The provided workflow uses `pull_request` and fetches patches via the GitHub API.
- Claude has bounded SDK retries and request timeouts. GitHub rate-limited reads
  have bounded retries; writes are not retried to avoid duplicate comments after
  ambiguous failures. Failed jobs can be rerun after checking existing comments.
- Automatic analysis consumes paid API quota. Restrict who can open issues,
  use workflow/environment controls, and tune token limits for public repositories.
- AI output may be inaccurate or contain malicious suggestions. Review it before
  applying changes; no generated code is executed by this integration.
- The App is a single-process deployment, not a distributed durable job queue.
  See its guide for persistence, webhook redelivery, and production limitations.
