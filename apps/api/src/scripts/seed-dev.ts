/**
 * CLI: seed the demo company, its organisation (docs/contracts/organization.md) and the demo users
 * (docs/contracts/identity.md › CLI and seed: rh.admin@demo.dz, rh.est@demo.dz, password DEMO_PASSWORD).
 *   npm run seed:dev -w @hrforce/api        (reads MIGRATOR_DATABASE_URL; idempotent; refuses NODE_ENV=production)
 * Runs as the migrator role (owner, BYPASSRLS) after `npm run migrate`.
 */
import { pino } from 'pino';
import { z } from 'zod';
import { migratorEnvSchema } from '../platform/config/env.schema.js';
import { parseEnv } from '../platform/config/load-env.js';
import { createDatabase } from '../platform/db/database.js';
import { DEMO_PASSWORD, DEMO_USERS, seedIdentity } from '../modules/identity/index.js';
import { DEMO_ORGANIZATION, seedOrganization, toIsoDate } from '../modules/organization/index.js';

const seedEnvSchema = migratorEnvSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

async function main(): Promise<void> {
  const env = parseEnv(seedEnvSchema, process.env);
  const logger = pino({ level: env.LOG_LEVEL, name: 'seed-dev' });
  if (env.NODE_ENV === 'production') throw new Error('seed:dev refuses to run with NODE_ENV=production');
  const db = createDatabase({ connectionString: env.MIGRATOR_DATABASE_URL, maxConnections: 1, applicationName: 'hrforce-seed' });
  try {
    await db.transaction().execute(async (tx) => {
      await seedOrganization(tx, DEMO_ORGANIZATION, toIsoDate(new Date()));
      await seedIdentity(tx, DEMO_ORGANIZATION.company.id);
    });
    logger.info(
      { companyId: DEMO_ORGANIZATION.company.id, units: DEMO_ORGANIZATION.units.length },
      'demo organisation seeded',
    );
    logger.info(
      { users: DEMO_USERS.map((u) => ({ id: u.id, email: u.email, locale: u.locale })), devPassword: DEMO_PASSWORD },
      `demo users seeded (active, company ${DEMO_ORGANIZATION.company.code}); development password: ${DEMO_PASSWORD}`,
    );
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed:dev: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
