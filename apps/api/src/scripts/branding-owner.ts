/**
 * CLI: choose the company that owns the installation branding — the default shown on the sign-in page and inherited
 * by every company that set nothing (docs/contracts/branding.md › Owning company).
 *   npm run branding:owner -w @hrforce/api -- --company <code>
 * Creates the installation row for that company or moves the existing row to it (its content is kept), and prints the
 * previous and the new owner. Runs as the migrator (MIGRATOR_DATABASE_URL): the app role can neither create the row
 * nor move it. Unknown code → non-zero exit.
 */
import { parseArgs } from 'node:util';
import { pino } from 'pino';
import { migratorEnvSchema } from '../platform/config/env.schema.js';
import { parseEnv } from '../platform/config/load-env.js';
import { createDatabase } from '../platform/db/database.js';
import { moveBrandingOwner } from '../modules/branding/index.js';

const USAGE = 'usage: npm run branding:owner -w @hrforce/api -- --company <code>';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { company: { type: 'string' } }, strict: true });
  if (!values.company) throw new Error(`missing --company\n${USAGE}`);
  const env = parseEnv(migratorEnvSchema, process.env);
  const logger = pino({ level: env.LOG_LEVEL, name: 'branding-owner' });
  const db = createDatabase({ connectionString: env.MIGRATOR_DATABASE_URL, maxConnections: 1, applicationName: 'hrforce-branding-owner' });
  try {
    const code = values.company;
    const result = await db.transaction().execute((tx) => moveBrandingOwner(tx, code));
    logger.info(
      result,
      result.changed
        ? `installation branding: owner ${result.previous ?? '(none)'} → ${result.current} (content kept)`
        : `installation branding: ${result.current} already owns it (nothing changed)`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`branding:owner: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
