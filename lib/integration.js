import { analyze } from './claude.js';
import { normalizeConfig } from './config.js';
import { getPullRequestContext, getIssueContext, publishAnalysis, parseNumber, parseRepository } from './github.js';

export async function analyzeTarget({ github, claude, target, config = {} }) {
  config = normalizeConfig(config);
  parseRepository(`${target.owner}/${target.repo}`);
  parseNumber(target.number);
  if (!['pr', 'issue'].includes(target.kind)) throw new Error('Target must be a PR or issue.');
  const content = await (target.kind === 'pr' ? getPullRequestContext : getIssueContext)(github, target, config.maxInputChars);
  const text = await analyze(claude, { kind: target.kind, content, config });
  await publishAnalysis(github, target, text, config.publish);
  return { text, published: config.publish !== 'none' };
}
