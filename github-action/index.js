import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClaude } from '../lib/claude.js';
import { createGitHub, parseRepository, parseNumber } from '../lib/github.js';
import { normalizeConfig } from '../lib/config.js';
import { analyzeTarget } from '../lib/integration.js';

export async function runAction({
  env = process.env, claudeFactory = createClaude, githubFactory = createGitHub,
  runAnalysis = analyzeTarget,
} = {}) {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  let kind;
  let number;
  if (env.GITHUB_EVENT_NAME === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(event.action)) {
    if (event.pull_request.head.repo?.fork) return { skipped: true };
    kind = 'pr';
    number = event.pull_request.number;
  } else if (env.GITHUB_EVENT_NAME === 'issues' && ['opened', 'reopened'].includes(event.action)) {
    kind = 'issue';
    number = event.issue.number;
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    kind = event.inputs?.kind;
    number = event.inputs?.number;
    if (!['pr', 'issue'].includes(kind)) throw new Error('Manual runs require kind pr or issue.');
  } else {
    return { skipped: true };
  }
  const config = normalizeConfig({
    model: env.CLAUDE_MODEL || undefined,
    features: env.CLAUDE_FEATURES || (kind === 'issue' ? 'summary,categorize' : 'review,summary,tests'),
    maxTokens: env.CLAUDE_MAX_TOKENS || undefined,
    maxInputChars: env.CLAUDE_MAX_INPUT_CHARS || undefined,
    prompt: env.CLAUDE_PROMPT || '',
    publish: env.CLAUDE_PUBLISH || 'comment',
  });
  const result = await runAnalysis({
    github: githubFactory(env.GITHUB_TOKEN),
    claude: claudeFactory({ apiKey: env.ANTHROPIC_API_KEY }),
    target: { ...parseRepository(env.GITHUB_REPOSITORY), number: parseNumber(number), kind },
    config,
  });
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `published=${result.published}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAction().catch(() => {
    console.error('Claude analysis failed. Check secrets, model access, GitHub permissions, and API quotas.');
    process.exitCode = 1;
  });
}
