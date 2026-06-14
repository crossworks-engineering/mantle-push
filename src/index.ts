// Server entrypoint. Validates config, opens the app, listens, and shuts down
// cleanly (drains the DB pool + provider sessions).

import { serve } from '@hono/node-server';
import { assertLiveCredentials, config } from './config.ts';
import { buildDefaultApp } from './app.ts';
import { closePool } from './db.ts';

assertLiveCredentials();

const { app, deps } = buildDefaultApp();

// Bound the rate-limiter maps periodically.
const sweep = setInterval(() => {
  deps.notifyLimiter.sweep();
  deps.enrollLimiter.sweep();
}, 60_000);
sweep.unref();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`mantle-push listening on :${info.port} — provider: ${deps.dispatcher.describe()}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} — shutting down`);
  clearInterval(sweep);
  server.close();
  await deps.dispatcher.close();
  await closePool();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
