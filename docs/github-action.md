# GitHub Action setup

1. Obtain an API key from Anthropic's console and enable API billing.
2. In the target repository, create the Actions secret `ANTHROPIC_API_KEY`.
3. Copy `github-action/workflow.yml` from this project into
   `.github/workflows/claude.yml` in your target repository.
4. Replace the `@main` action reference with a reviewed full commit SHA of this
   project. The action installs dependencies from its own locked package, not
   from the repository being analyzed. No target checkout is needed.
5. Ensure repository/organization policy permits `contents: read`,
   `pull-requests: write`, and `issues: write` for `GITHUB_TOKEN`.

The workflow runs on PR opened/synchronize/reopened and issue opened/reopened.
Fork PRs are skipped because secrets and write permissions are unavailable.
Do not switch to `pull_request_target` or check out and execute PR code to bypass
this restriction. Use the App or manually analyze a fork PR from a trusted context.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `anthropic-api-key` | required | Pass the repository secret |
| `github-token` | required | Normally `secrets.GITHUB_TOKEN` |
| `model` | `claude-sonnet-4-6` | Anthropic model ID |
| `features` | event-specific | Comma-separated feature names |
| `prompt` | empty | Additional trusted instructions |
| `max-tokens` | `2048` | 1–8192 output tokens |
| `max-input-chars` | `60000` | 1000–200000 input characters |
| `publish` | `comment` | `comment`, `review`, or `none` |

PR defaults are `review,summary,tests`; issue defaults are `summary,categorize`.
The `published` output is `true`/`false` for processed events and unset for skipped
events. Review mode creates a non-approving COMMENT review on PRs; issues always
receive ordinary comments. Generated suggestions appear in the review body.

Use the workflow's **Run workflow** form to analyze an existing PR/issue, choose
features/model/prompt/publication mode, or run without posting. Add Action inputs
to the `with` block to adjust token and context limits for automatic runs.
Keep untrusted event text out of shell commands; inputs are passed through
environment variables by the action.

## Troubleshooting

Check API billing, model access, secret spelling, repository token permissions,
and API quotas. The runner intentionally does not print raw SDK errors or source
content. Analysis failures fail the job. Concurrency cancels older runs for the
same target, but a comment already posted is not deleted. API costs incurred by
canceled runs may still be charged; check existing comments before rerunning.
