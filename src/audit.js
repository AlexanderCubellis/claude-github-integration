import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export const actionTypes = {
  component_started: 'Integration Started',
  component_stopped: 'Integration Stopped',
  webhook_received: 'GitHub Notification Received',
  webhook_processed: 'GitHub Notification Processed',
  event_skipped: 'No Action Needed',
  pr_analysis_started: 'PR Analysis Started',
  pr_analysis_complete: 'Claude Analysis Complete',
  issue_analysis_started: 'Issue Analysis Started',
  issue_analysis_complete: 'Claude Issue Analysis Complete',
  resource_loaded: 'GitHub Description Loaded',
  changes_loaded: 'Code Changes Loaded',
  comment_posting_started: 'Posting Review Comment',
  comment_posted: 'Comment Posted',
  rate_limited: 'Service Is Busy',
  authentication_failed: 'Authentication Problem',
  error_occurred: 'Error Occurred',
};

const statuses = {
  in_progress: '⏳ In Progress',
  success: '✅ Success',
  failure: '❌ Failure',
  skipped: '➖ Skipped',
};

export function logDirectory(component) {
  return process.env.AUDIT_LOG_DIR || (component === 'cli'
    ? join(homedir(), '.claude-github-integration', 'logs')
    : join(process.cwd(), 'logs', component));
}

export class AuditLogger {
  constructor({ component, directory = logDirectory(component), context = {},
    stream = process.stderr, summaryFile, secrets = [] }) {
    if (!['cli', 'github-action', 'app'].includes(component)) {
      throw new Error('Unknown audit component.');
    }
    this.component = component;
    this.directory = directory;
    this.context = context;
    this.stream = stream;
    this.summaryFile = summaryFile;
    this.secrets = [...secrets, process.env.GITHUB_TOKEN, process.env.ANTHROPIC_API_KEY,
      process.env.WEBHOOK_SECRET].filter(Boolean);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  clean(value) {
    if (typeof value === 'string') {
      for (const secret of this.secrets) value = value.split(secret).join('[REDACTED]');
      return value
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-ant-[A-Za-z0-9_-]+)\b/g, '[REDACTED]')
        .replace(/Bearer\s+\S+/gi, '******')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
    }
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        this.clean(key),
        /token|secret|password|authorization|api.?key|private.?key/i.test(key)
          ? '[REDACTED]' : this.clean(item),
      ]));
    }
    return value;
  }

  log(actionType, { status = 'success', humanReadable, details = {}, links = {},
    context = {} } = {}) {
    if (!actionTypes[actionType] || !statuses[status] || !humanReadable) {
      throw new Error('Audit entries need a known action, status, and plain-language description.');
    }
    const merged = { ...this.context, ...context };
    const entry = this.clean({
      timestamp: new Date().toISOString(),
      actionId: randomUUID(),
      actionType,
      component: this.component,
      repository: merged.repository || null,
      user: merged.user || 'unknown',
      event: merged.event || 'manual',
      ...(merged.pr ? { pr: merged.pr } : {}),
      ...(merged.issue ? { issue: merged.issue } : {}),
      status,
      humanReadable,
      details,
      links: {
        ...(merged.repository ? { repository: `https://github.com/${merged.repository}` } : {}),
        ...(merged.pr ? { pr: merged.pr.url } : {}),
        ...(merged.issue ? { issue: merged.issue.url } : {}),
        ...merged.links,
        ...links,
      },
    });
    const file = join(this.directory, `${entry.timestamp.slice(0, 10)}.jsonl`);
    try {
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      this.stream.write('❌ Audit record could not be saved. Check the log folder permissions and free disk space.\n');
      throw new Error('Audit storage is unavailable.');
    }
    const resource = entry.pr || entry.issue;
    const lines = [
      `📝 [${entry.timestamp.slice(0, 19).replace('T', ' ')} UTC] ${actionTypes[actionType]}`,
      `   Component: ${entry.component} | User: ${entry.user} | Event: ${entry.event}`,
      ...(entry.repository ? [`   Repo: ${entry.repository}`] : []),
      ...(resource ? [`   ${entry.pr ? 'PR' : 'Issue'} #${resource.number}: "${resource.title}"`] : []),
      `   Status: ${statuses[status]}`,
      `   ${entry.humanReadable}`,
      ...Object.entries(entry.links).map(([name, url]) => `   ${name}: ${url}`),
    ];
    this.stream.write(`${lines.join('\n')}\n\n`);
    if (this.summaryFile) {
      // A code block prevents GitHub titles or usernames from injecting Markdown.
      appendFileSync(this.summaryFile, `\n<pre>${lines.join('\n')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>\n`);
    }
    return entry;
  }
}
