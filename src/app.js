import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { AuditLogger } from './audit.js';
import { Integration, IntegrationError, recordError } from './integration.js';

export function createApp({ logger, integration = new Integration({ logger }),
  secret = process.env.WEBHOOK_SECRET,
  repositories = (process.env.APP_REPOSITORIES || '').split(',').filter(Boolean) }) {
  if (!secret || !repositories.length) {
    throw new IntegrationError('Set WEBHOOK_SECRET and APP_REPOSITORIES before starting the App.',
      'authentication_failed');
  }
  logger.secrets.push(secret);
  // Completed delivery IDs are retained in memory to avoid immediate duplicate reviews.
  const deliveries = new Map();
  let busy = false;
  return createServer(async (request, response) => {
    const reply = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain' });
      response.end(message);
    };
    let context = { event: 'webhook', user: 'unverified' };
    if (request.method !== 'POST' || request.url !== '/webhook') {
      try {
        logger.log('event_skipped', { status: 'skipped', context,
          humanReadable: 'The App received a request outside its webhook address. No action was taken.' });
      } catch {
        reply(503, 'Audit storage is unavailable. No action was taken.');
        return;
      }
      reply(404, 'Send GitHub webhooks to POST /webhook.');
      return;
    }
    let deliveryId;
    let ownsSlot = false;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > 1_048_576) {
          throw new IntegrationError('The GitHub notification is too large to process safely.',
            'error_occurred', { httpStatus: 413 });
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const signature = request.headers['x-hub-signature-256'];
      if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)
          || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        throw new IntegrationError('The App could not verify this notification came from GitHub. Check the webhook secret.',
          'authentication_failed', { httpStatus: 401 });
      }
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
      } catch {
        throw new IntegrationError('GitHub sent a notification the App could not read.',
          'error_occurred', { httpStatus: 400 });
      }
      context = { repository: payload.repository?.full_name,
        user: payload.sender?.login || 'unknown',
        event: `${request.headers['x-github-event'] || 'unknown'}.${payload.action || 'received'}` };
      if (!repositories.includes(context.repository)) {
        logger.log('event_skipped', { status: 'skipped', context,
          humanReadable: 'This repository is not enabled for the App. No review or comment was made.' });
        reply(200, 'Repository not enabled.');
        return;
      }
      deliveryId = request.headers['x-github-delivery'];
      const now = Date.now();
      for (const [id, time] of deliveries) if (now - time > 3_600_000) deliveries.delete(id);
      if (deliveryId && deliveries.has(deliveryId)) {
        logger.log('event_skipped', { status: 'skipped', context,
          humanReadable: 'GitHub sent this notification again. It has already been handled; no duplicate review was made.' });
        reply(200, 'Already handled.');
        return;
      }
      if (busy) {
        throw new IntegrationError('The App is handling another notification. Redeliver this notification in GitHub after it finishes.',
          'rate_limited', { httpStatus: 503 });
      }
      busy = true;
      ownsSlot = true;
      await integration.handleEvent(request.headers['x-github-event'], payload, { deliveryId });
      if (deliveryId) {
        if (deliveries.size >= 1000) deliveries.delete(deliveries.keys().next().value);
        deliveries.set(deliveryId, Date.now());
      }
      reply(200, 'Notification processed. See the audit log.');
    } catch (error) {
      // Analysis failures have already been recorded by the shared integration.
      if (!ownsSlot) {
        try {
          recordError(logger, error, context);
        } catch {
          reply(503, 'Audit storage is unavailable. No action was taken.');
          return;
        }
      }
      reply(error instanceof IntegrationError ? error.details.httpStatus || 500 : 500,
        'Notification failed. See the audit log and redeliver when the problem is resolved.');
    } finally {
      if (ownsSlot) busy = false;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let logger;
  try {
    logger = new AuditLogger({ component: 'app', context: { event: 'startup', user: 'operator' } });
    const server = createApp({ logger });
    server.on('error', error => { recordError(logger, error); process.exitCode = 1; });
    server.listen(Number(process.env.PORT || 3000), '127.0.0.1', () => {
      logger.log('component_started', { humanReadable: 'The App is listening for GitHub notifications at /webhook. Use an HTTPS reverse proxy to connect GitHub.' });
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      server.close(() => {
        logger.log('component_stopped', { humanReadable: 'The App stopped listening. Its audit records remain in the log folder.' });
      });
    });
  } catch (error) {
    if (logger) recordError(logger, error);
    else process.stderr.write('The App could not open its audit folder. Check permissions and free disk space.\n');
    process.exitCode = 1;
  }
}
