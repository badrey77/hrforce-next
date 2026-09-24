/**
 * CLI: apply pending migrations as the migrator role.
 *   npm run migrate -w @hrforce/api        (reads MIGRATOR_DATABASE_URL, optional MIGRATIONS_DIR)
 */
import { pino } from 'pino';
import { migratorEnvSchema } from '../config/env.schema.js';
import { parseEnv } from '../config/load-env.js';
import { runMigrations } from './migrator.js';

async function main(): Promise<void> {
  const env = parseEnv(migratorEnvSchema, process.env);
  const logger = pino({ level: env.LOG_LEVEL, name: 'migrate' });
  const result = await runMigrations({
    connectionString: env.MIGRATOR_DATABASE_URL,
    ...(env.MIGRATIONS_DIR ? { migrationsDir: env.MIGRATIONS_DIR } : {}),
    logger,
  });
  logger.info(
    { applied: result.applied.length, alreadyApplied: result.alreadyApplied },
    result.applied.length ? 'migrations complete' : 'database is up to date',
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`migrate: ${message}\n`);
  process.exitCode = 1;
});
