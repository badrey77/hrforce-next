import type { Transaction } from 'kysely';
import type { AuditEvents } from '../../../platform/audit/audit-events.js';
import type { DB } from '../../../platform/db/schema.js';
import { DEFAULT_RETENTION_MONTHS } from '../domain/rules.js';
import { dueApplications, purgeApplications, retentionMonthsOf } from '../infra/candidates.repository.js';

export interface RecruitmentRetentionResult {
  /** the Algiers date the run counted from */
  before: string;
  applications: number;
  candidates: number;
  files: number;
}

/**
 * The retention purge of one company (worker cron `recruitment.retention`, docs/contracts/recruitment.md › Retention,
 * erasure and worker), inside the worker's company transaction (hrforce_worker, RLS on the company): every application
 * decided (rejected, withdrawn, closed automatically — or hired) more than the policy's months before `today` loses
 * its notes, salary row and stage comments and its candidate; a candidate left with no application loses its files and
 * its row. Then ONE `recruitment.purged {applications, candidates, files, before}` event when something was purged.
 * The audit trigger writes no per-row event for the worker and the audit log never held a personal value (migration
 * 0019): the purge really erases. Idempotent.
 */
export async function runRecruitmentRetention(tx: Transaction<DB>, companyId: string, today: string, audit: AuditEvents): Promise<RecruitmentRetentionResult> {
  const months = await retentionMonthsOf(tx, companyId, DEFAULT_RETENTION_MONTHS);
  const due = await dueApplications(tx, companyId, today, months);
  const result = await purgeApplications(tx, companyId, due);
  if (result.applications > 0) await audit.record({ type: 'recruitment.purged', subject: null, data: { ...result, before: today } });
  return { before: today, ...result };
}
