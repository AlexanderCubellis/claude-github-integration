import { createApp } from './server.js';

try {
  const { app, host, port } = await createApp({
    onJobError: ({ delivery }) => console.error(`Webhook job failed (${delivery})`),
  });
  const server = app.listen(port, host, () => console.log('GitHub App listening'));
  server.on('error', () => { console.error('Unable to start GitHub App'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
} catch {
  console.error('Unable to initialize GitHub App; check environment and private settings storage');
  process.exitCode = 1;
}
