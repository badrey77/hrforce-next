import { sql, type Transaction } from 'kysely';
import { currentTx } from '../platform/context/request-context.js';
import { runInRequestTransaction } from '../platform/context/request-transaction.js';
import type { Database } from '../platform/db/database.js';
import type { DB } from '../platform/db/schema.js';

/**
 * Runs `fn` in its own transaction as the SYSTEM actor of one company: app.company_id = the company (RLS), app.user_id
 * empty (audit actor null = system), app.request_id = `job:<task>:<job id>` (audit rows name the job).
 */
export function inCompany<T>(db: Database, companyId: string, requestId: string, fn: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
  return runInRequestTransaction(db, { requestId, companyId, userId: null }, () => fn(currentTx()));
}

/** Every company id (public.job_company_ids(): SECURITY DEFINER, EXECUTE for hrforce_worker only). */
export async function companyIds(db: Database): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`select id from public.job_company_ids() as id`.execute(db);
  return rows.map((r) => r.id);
}

export interface CompanyResult<T> {
  companyId: string;
  result?: T;
  error?: string;
}

/**
 * The cron jobs' company-by-company loop: one transaction per company, so one company's failure neither rolls back nor
 * blocks the others. Throws after the loop when any company failed (Graphile retries the job — the jobs are
 * idempotent, so the companies that succeeded are a no-op the second time).
 */
export async function forEachCompany<T>(db: Database, requestId: string, fn: (tx: Transaction<DB>, companyId: string) => Promise<T>): Promise<CompanyResult<T>[]> {
  const results: CompanyResult<T>[] = [];
  for (const companyId of await companyIds(db)) {
    try {
      results.push({ companyId, result: await inCompany(db, companyId, requestId, (tx) => fn(tx, companyId)) });
    } catch (error) {
      results.push({ companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = results.filter((r) => r.error !== undefined);
  if (failed.length > 0) {
    throw new CompanyLoopError(failed.map((f) => `${f.companyId}: ${f.error ?? ''}`), results);
  }
  return results;
}

export class CompanyLoopError extends Error {
  constructor(
    readonly failures: string[],
    readonly results: readonly CompanyResult<unknown>[],
  ) {
    super(`failed for ${failures.length} company(ies): ${failures.join('; ')}`);
    this.name = 'CompanyLoopError';
  }
}
