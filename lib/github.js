import { Octokit } from '@octokit/rest';
import { truncate } from './claude.js';

export function createGitHub(token = process.env.GITHUB_TOKEN) {
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  return new Octokit({ auth: token, request: { timeout: 30000 } });
}

export function parseRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Repository must be owner/repo.');
  }
  const [owner, repo] = value.split('/');
  return { owner, repo };
}

export function parseNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Number must be a positive integer.');
  return number;
}

export async function readWithRetry(operation, { sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const headers = error.response?.headers ?? {};
      const limited = error.status === 429 || (error.status === 403 &&
        (headers['x-ratelimit-remaining'] === '0' || headers['retry-after']));
      if (!limited || attempt >= 2) throw error;
      const delay = Number(headers['retry-after'] ?? 2 ** attempt);
      // Do not hold a workflow or webhook open until a distant quota reset.
      if (!Number.isFinite(delay) || delay < 0 || delay > 30) throw error;
      await sleep(Math.max(delay, 1) * 1000);
    }
  }
}

export async function getPullRequestContext(github, target, maxInputChars = 60000) {
  const { owner, repo, number: pull_number } = target;
  const { data: pr } = await readWithRetry(() => github.rest.pulls.get({ owner, repo, pull_number }));
  let context = truncate(`PR #${pull_number}: ${pr.title}\n${pr.body ?? ''}\nBase: ${pr.base.sha}\nHead: ${pr.head.sha}\n`, Math.floor(maxInputChars / 2));
  let page = 1;
  let complete = false;
  while (context.length < maxInputChars && page <= 30) {
    const { data: files } = await readWithRetry(() => github.rest.pulls.listFiles({ owner, repo, pull_number, per_page: 100, page }));
    for (const file of files) {
      context += `\nFile: ${file.filename} (${file.status})\n${file.patch ?? '[No textual patch available: binary or large file.]'}\n`;
      if (context.length >= maxInputChars) break;
    }
    if (files.length < 100) { complete = true; break; }
    page++;
  }
  if (!complete) context += '\n[File listing may be incomplete.]';
  return truncate(context, maxInputChars);
}

export async function getIssueContext(github, { owner, repo, number: issue_number }, maxInputChars = 60000) {
  const { data: issue } = await readWithRetry(() => github.rest.issues.get({ owner, repo, issue_number }));
  if (issue.pull_request) throw new Error('This number is a pull request; use PR analysis.');
  return truncate(`Issue #${issue_number}: ${issue.title}\nLabels: ${(issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name).join(', ')}\n\n${issue.body ?? ''}`, maxInputChars);
}

export async function publishAnalysis(github, { owner, repo, number, kind }, text, mode = 'comment') {
  if (mode === 'none') return;
  if (!['comment', 'review'].includes(mode)) throw new Error('Unsupported publication mode.');
  // Publishing is not retried: an ambiguous response must not create duplicate comments.
  const body = `## Claude analysis\n\n${truncate(text, 59000)}\n\n_AI-generated; verify suggestions before applying._`;
  if (mode === 'review' && kind === 'pr') {
    return github.rest.pulls.createReview({ owner, repo, pull_number: number, event: 'COMMENT', body });
  }
  return github.rest.issues.createComment({ owner, repo, issue_number: number, body });
}
