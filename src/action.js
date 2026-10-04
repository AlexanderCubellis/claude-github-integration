import { readFileSync } from 'node:fs';
import { AuditLogger } from './audit.js';
import { Integration, recordError } from './integration.js';

try {
  const logger = new AuditLogger({ component: 'github-action',
    summaryFile: process.env.GITHUB_STEP_SUMMARY,
    context: { repository: process.env.GITHUB_REPOSITORY,
      user: process.env.GITHUB_ACTOR, event: process.env.GITHUB_EVENT_NAME,
      links: process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
        ? { workflow: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }
        : {} } });
  logger.log('component_started', { humanReadable: 'The GitHub Action has started. Follow the audit messages here or in the run summary.' });
  let payload;
  try {
    payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    recordError(logger, new Error('Invalid event file.'));
    process.exitCode = 1;
  }
  if (payload) {
    try {
      await new Integration({ logger }).handleEvent(process.env.GITHUB_EVENT_NAME, payload);
      logger.log('component_stopped', { humanReadable: 'The GitHub Action finished. Audit files will be uploaded as an artifact.' });
    } catch {
      process.exitCode = 1;
    }
  }
} catch {
  process.stderr.write('The GitHub Action could not start or save its audit log. Check the audit folder and run summary permissions.\n');
  process.exitCode = 1;
}
