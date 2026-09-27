/**
 * Background worker entry point (ADR 005: one image, two entry points; docs/contracts/notifications.md › Worker):
 *   node dist/worker.js                  (production image: compose service `worker`)
 *   npm run worker -w @hrforce/api       (development: builds, then runs)
 * Graphile Worker on Postgres (LISTEN/NOTIFY + row locks), as the role hrforce_worker (WORKER_DATABASE_URL): jobs
 * enqueued by the API inside its transactions (notification e-mails) and the cron (src/worker/cron.ts). The job
 * queue schema is installed by `npm run migrate`, never here. Graceful shutdown on SIGTERM/SIGINT: no new jobs,
 * running ones finish (then the process exits; unfinished ones are retried by the next worker).
 */
import { writeFile } from 'node:fs/promises';
import { run } from 'graphile-worker';
import { sql } from 'kysely';
import { pino } from 'pino';
import { createMailSender } from './modules/identity/index.js';
import { workerEnvSchema } from './platform/config/env.schema.js';
import { parseEnv } from './platform/config/load-env.js';
import { createDatabase } from './platform/db/database.js';
import { REDACT_CENSOR, REDACT_PATHS } from './platform/logging/redaction.js';
import { parsedCronItems } from './worker/cron.js';
import { graphileLogger } from './worker/graphile-logger.js';
import { buildTaskList } from './worker/tasks.js';

const HEARTBEAT_MS = 30_000;

async function main(): Promise<void> {
  const env = parseEnv(workerEnvSchema, process.env);
  const logger = pino({ level: env.LOG_LEVEL, name: 'worker', redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR } });
  const db = createDatabase({ connectionString: env.WORKER_DATABASE_URL, maxConnections: env.WORKER_CONCURRENCY + 1, applicationName: 'hrforce-worker' });
  const mail = createMailSender(env, { info: (payload, message) => logger.info(payload, message) });

  const taskList = buildTaskList({ db, logger, mail, webBaseUrl: env.WEB_BASE_URL });
  const runner = await run({
    connectionString: env.WORKER_DATABASE_URL,
    maxPoolSize: env.WORKER_CONCURRENCY + 2,
    concurrency: env.WORKER_CONCURRENCY,
    noHandleSignals: true,
    pollInterval: 2000,
    logger: graphileLogger(logger),
    taskList,
    parsedCronItems: parsedCronItems(),
  });
  logger.info({ concurrency: env.WORKER_CONCURRENCY, tasks: Object.keys(taskList) }, 'worker started');

  // Liveness for the container health check (dist/worker-health.js): touch the file after a successful DB round trip.
  const beat = async () => {
    try {
      await sql`select 1`.execute(db);
      await writeFile(env.WORKER_HEARTBEAT_FILE, new Date().toISOString());
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'worker heartbeat failed');
    }
  };
  await beat();
  const heartbeat = setInterval(() => void beat(), HEARTBEAT_MS);

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker stopping (running jobs finish first)');
    clearInterval(heartbeat);
    runner
      .stop(signal)
      .catch((error: unknown) => logger.error({ err: error instanceof Error ? error.message : String(error) }, 'worker stop failed'))
      .finally(() => {
        db.destroy()
          .catch(() => undefined)
          .finally(() => {
            logger.info('worker stopped');
            process.exit(0);
          });
      });
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  await runner.promise;
}

main().catch((error: unknown) => {
  process.stderr.write(`worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
