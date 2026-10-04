#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClaude, analyze } from '../lib/claude.js';
import { createGitHub, parseRepository, parseNumber } from '../lib/github.js';
import { normalizeConfig } from '../lib/config.js';
import { analyzeTarget } from '../lib/integration.js';

export function createProgram({ claudeFactory = createClaude, githubFactory = createGitHub, output = console.log } = {}) {
  const program = new Command();
  program.name('claude-github').description('Analyze GitHub PRs/issues and local code with Claude').version('1.0.0');
  const options = command => command
    .option('--model <model>', 'Claude model ID')
    .option('--features <list>', 'review,summary,categorize,commit,tests,docs')
    .option('--prompt <text>', 'additional trusted instructions')
    .option('--max-tokens <number>', 'maximum output tokens')
    .option('--max-input-chars <number>', 'maximum context characters')
    .option('--config <file>', 'JSON configuration file');

  async function configFor(opts, defaults) {
    let stored = {};
    if (opts.config) {
      if ((await stat(opts.config)).size > 20000) throw new Error('Configuration file is too large.');
      stored = JSON.parse(await readFile(opts.config, 'utf8'));
      normalizeConfig(stored);
    }
    const supplied = Object.fromEntries(Object.entries(opts).filter(([key, value]) =>
      ['model', 'features', 'prompt', 'maxTokens', 'maxInputChars', 'publish'].includes(key) && value !== undefined));
    // A saved config never enables writes implicitly in the local CLI.
    return normalizeConfig({ ...defaults, ...stored, ...supplied, publish: opts.publish ?? 'none' });
  }
  for (const kind of ['pr', 'issue']) {
    options(program.command(`${kind} <repository> <number>`))
      .option('--publish <mode>', 'explicitly publish comment or review (default: none)')
      .action(async (repository, number, opts) => {
        const config = await configFor(opts, { features: kind === 'issue' ? ['summary', 'categorize'] : ['review'] });
        const result = await analyzeTarget({
          claude: claudeFactory(), github: githubFactory(),
          target: { ...parseRepository(repository), number: parseNumber(number), kind }, config,
        });
        output(result.text);
      });
  }
  options(program.command('code <file>'))
    .description('Analyze a local UTF-8 file; supports commit, tests, and docs generation')
    .action(async (file, opts) => {
      const config = await configFor(opts, { features: ['review'] });
      if ((await stat(file)).size > 2_000_000) throw new Error('Code file exceeds the 2 MB limit.');
      const content = await readFile(file, 'utf8');
      output(await analyze(claudeFactory(), { kind: 'code', content, config }));
    });
  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createProgram().parseAsync().catch(() => {
    console.error('Analysis failed. Check configuration, credentials, permissions, and API quotas.');
    process.exitCode = 1;
  });
}
