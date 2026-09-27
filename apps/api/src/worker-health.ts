/**
 * Container health check of the worker (compose `healthcheck: node dist/worker-health.js`): healthy when the
 * heartbeat file (WORKER_HEARTBEAT_FILE, default /tmp/hrforce-worker.alive) was touched in the last 2 minutes — the
 * worker touches it every 30 s after a successful database round trip.
 */
import { statSync } from 'node:fs';

const file = process.env['WORKER_HEARTBEAT_FILE'] || '/tmp/hrforce-worker.alive';
try {
  process.exit(Date.now() - statSync(file).mtimeMs < 120_000 ? 0 : 1);
} catch {
  process.exit(1);
}
