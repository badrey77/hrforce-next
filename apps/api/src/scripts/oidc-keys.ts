/**
 * CLI: the OpenID Connect provider's signing keys (docs/contracts/sso.md › Keys, ADR 007 §5).
 *   npm run oidc:keys -w @hrforce/api -- status | stage | promote [--now] | prune [--now] | reset
 *   (container: docker compose run --rm migrate node dist/scripts/oidc-keys.js status)
 * Runs as the migrator (MIGRATOR_DATABASE_URL) with the API's OIDC_KEY. Restart the API after each changing command:
 * the provider loads its keys at boot. Emergency (suspected key leak): stage + promote --now + prune --now + restart.
 */
import { z } from 'zod';
import { DEV_OIDC_KEY, isMfaKey, migratorEnvSchema } from '../platform/config/env.schema.js';
import { parseEnv } from '../platform/config/load-env.js';
import { createDatabase } from '../platform/db/database.js';
import { deriveOidcKeys, OidcKeysCommandError, runOidcKeysCommand } from '../modules/sso/index.js';

const keysEnvSchema = migratorEnvSchema
  .extend({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    OIDC_KEY: z.string().refine(isMfaKey, { message: 'must be the base64 encoding of exactly 32 bytes' }).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.OIDC_KEY === undefined && env.NODE_ENV === 'production') ctx.addIssue({ code: 'custom', path: ['OIDC_KEY'], message: 'is required when NODE_ENV is production' });
  });

async function main(): Promise<void> {
  const env = parseEnv(keysEnvSchema, process.env);
  const db = createDatabase({ connectionString: env.MIGRATOR_DATABASE_URL, maxConnections: 1, applicationName: 'hrforce-oidc-keys' });
  try {
    const lines = await runOidcKeysCommand(db, deriveOidcKeys(Buffer.from(env.OIDC_KEY ?? DEV_OIDC_KEY, 'base64')).aead, process.argv.slice(2));
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof OidcKeysCommandError || error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
