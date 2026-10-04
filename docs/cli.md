# Standalone CLI

Install Node.js 22.12+, then run `npm ci` in this project. Invoke `node cli/index.js`,
or run `npm link` once to install the `claude-github` command locally.

Set `ANTHROPIC_API_KEY` for every analysis. Set `GITHUB_TOKEN` when analyzing
GitHub resources. For fine-grained PATs, select the target repository and grant
Pull requests: read for PR analysis, Issues: read for issues, and the corresponding
write permission only when posting. Metadata access is automatically included.
Org SSO or installation policies may require additional authorization.

```sh
claude-github pr OWNER/REPO 123
claude-github pr OWNER/REPO 123 --features review,summary --publish comment
claude-github pr OWNER/REPO 123 --publish review
claude-github issue OWNER/REPO 45 --features summary,categorize
claude-github code src/example.js --features tests,docs
claude-github code changes.diff --features commit --prompt 'Use a concise subject.'
```

Local `code` analysis needs only Anthropic credentials, never a GitHub token.
Provide a saved diff to generate a commit message for changes; the CLI does not
run `git`, create commits, or execute analyzed files. Local files must be UTF-8
and no larger than 2 MB; content is truncated to the configured context budget.

## Configuration

Common options: `--model`, `--features`, `--prompt`, `--max-tokens`,
`--max-input-chars`, and `--config <file>`. Configuration files are JSON objects
with the same camelCase fields as below:

```json
{
  "model": "claude-sonnet-4-6",
  "features": ["review", "tests"],
  "maxTokens": 2048,
  "maxInputChars": 60000,
  "prompt": "Focus on concurrency and correctness."
}
```

CLI flags override saved values. Publication defaults to `none` even if a file
contains `publish`; only `--publish comment` or `--publish review` enables writes.
Issue commands default to summary/categorization; other commands default to review.

## CI/CD

Supply keys using your CI secret store. Results go to stdout, so redirect them
to an artifact if desired. Treat saved results as potentially sensitive source
information.

```sh
node cli/index.js pr OWNER/REPO 123 --features review,tests > analysis.txt
```

Exit status is zero on success and nonzero on invalid input, missing credentials,
or API failure. Errors deliberately omit SDK payloads to avoid exposing secrets
and repository content. Verify permissions, model availability, billing, and
rate limits when a request fails. Use `--help` for command-specific options.
