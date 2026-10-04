import { pathToFileURL } from 'node:url';
import { AuditLogger } from './audit.js';
import { Integration, IntegrationError, recordError, resourceContext } from './integration.js';

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.length === 0) {
    process.stdout.write('Usage: npm run cli -- <pr|issue> <owner/repo> <number> [--no-comment]\nSet GITHUB_TOKEN and ANTHROPIC_API_KEY. Logs: ~/.claude-github-integration/logs/ (or AUDIT_LOG_DIR).\n');
    return;
  }
  const logger = new AuditLogger({ component: 'cli',
    context: { user: process.env.GITHUB_ACTOR || 'local-user', event: 'manual' } });
  logger.log('component_started', { humanReadable: 'The command-line tool is ready. Audit messages appear beside the review output.' });
  let context;
  try {
    const [kind, repository, number, ...flags] = args;
    if (args.length < 3 || flags.some(flag => flag !== '--no-comment')) {
      throw new IntegrationError('Use pr or issue, a repository as owner/name, and a positive number. The only option is --no-comment.');
    }
    context = resourceContext(repository, kind, Number(number), logger.context.user);
  } catch (error) {
    recordError(logger, error);
    process.exitCode = 1;
    return;
  }
  try {
    const review = await new Integration({ logger }).analyze(context,
      { postComment: !args.includes('--no-comment') });
    process.stdout.write(`${review}\n`);
    logger.log('component_stopped', { context, humanReadable: 'The command finished. The audit log has been saved.' });
  } catch {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('The command could not start or save its audit log. Check the log folder permissions and configuration.\n');
    process.exitCode = 1;
  });
}
