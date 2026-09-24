import { sql } from 'kysely';
import { NIL_UUID, type Database } from '../db/database.js';
import { runWithContext } from './request-context.js';

export interface TransactionScope {
  requestId: string;
  userId: string | null;
  companyId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuidOrNull(name: string, value: string | null): void {
  if (value !== null && !UUID.test(value)) throw new Error(`${name} must be a UUID`);
}

/**
 * Opens ONE transaction, sets the transaction-local tenant/audit settings, and runs `fn` with a
 * RequestContext whose `tx` is that transaction. Commits when `fn` resolves, rolls back when it throws.
 * Used by the request-context interceptor; also usable by workers/scripts that act on behalf of a tenant.
 */
export async function runInRequestTransaction<T>(
  db: Database,
  scope: TransactionScope,
  fn: () => Promise<T>,
): Promise<T> {
  assertUuidOrNull('companyId', scope.companyId);
  assertUuidOrNull('userId', scope.userId);
  return db.transaction().execute(async (tx) => {
    await sql`select
        set_config('app.company_id', ${scope.companyId ?? NIL_UUID}, true),
        set_config('app.user_id', ${scope.userId ?? ''}, true),
        set_config('app.request_id', ${scope.requestId}, true)`.execute(tx);
    return runWithContext({ ...scope, tx }, fn);
  });
}
