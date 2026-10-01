import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';

export interface OidcCleanupResult {
  models: number;
  failures: number;
}

/**
 * Daily `oidc.cleanup` (docs/contracts/sso.md › Worker), as hrforce_worker: provider rows expired for more than a
 * day, client-authentication failures older than a day. Idempotent, not per company. `now` pins the clock (tests).
 */
export async function runOidcCleanup(db: Kysely<DB>, now: Date = new Date()): Promise<OidcCleanupResult> {
  const models = await sql`delete from oidc.model_store where expires_at < ${now}::timestamptz - interval '1 day'`.execute(db);
  const failures = await sql`delete from oidc.client_auth_failure where at < ${now}::timestamptz - interval '1 day'`.execute(db);
  return { models: Number(models.numAffectedRows ?? 0n), failures: Number(failures.numAffectedRows ?? 0n) };
}
