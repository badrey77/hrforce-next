import type { Transaction } from 'kysely';
import type { AuditEvents } from '../../../platform/audit/audit-events.js';
import type { DB } from '../../../platform/db/schema.js';
import { isPurgeDue } from '../domain/employee-files.js';
import { purgeCandidates, purgeFiles } from '../infra/employee-files.repository.js';

export interface RetentionRunResult {
  candidates: number;
  purged: number;
}

/**
 * The retention purge of one company (worker cron `employee_files.retention`, docs/contracts/documents.md › Audit,
 * retention, worker), inside the worker's company transaction (hrforce_worker, RLS on the company): the bytes of every
 * live file whose category keeps files N years after the end and whose person left more than N years ago are removed,
 * the metadata is kept with `purged_at` (audited row change), and one `employee_file.purged {count}` event is written
 * when something was purged. Idempotent: a purged file is never a candidate again.
 */
export async function runEmployeeFileRetention(tx: Transaction<DB>, companyId: string, today: string, audit: AuditEvents): Promise<RetentionRunResult> {
  const candidates = await purgeCandidates(tx, companyId);
  const due = candidates.filter((c) => isPurgeDue({ retentionYears: c.retentionYears, endDates: c.endDates, today }));
  const purged = await purgeFiles(tx, companyId, due.map((c) => c.id));
  if (purged > 0) await audit.record({ type: 'employee_file.purged', subject: null, data: { count: purged } });
  return { candidates: candidates.length, purged };
}
