import type { Transaction } from 'kysely';
import type { AuditEvents } from '../../../platform/audit/audit-events.js';
import type { DB } from '../../../platform/db/schema.js';
import { retentionCutoff } from '../domain/time.js';
import { purgeAttendance, retentionMonthsOf } from '../infra/attendance.repository.js';

export interface AttendanceRetentionResult {
  /** punches and corrections of work days before this date were deleted */
  before: string;
  punches: number;
  corrections: number;
}

/**
 * The retention purge of one company (worker cron `attendance.retention`, docs/contracts/attendance.md › Retention),
 * inside the worker's company transaction (hrforce_worker, RLS on the company): deletes the correction items, punches
 * and corrections (Phase B) whose work day is before the first day of today's month minus the policy's retention
 * months, then writes ONE `attendance.purged {punches, corrections, before}` event when something was deleted. The
 * punch and correction audit triggers write no per-row event for the worker and the audit log never held a copy of
 * those rows (migrations 0016, 0017): the purge erases them fully. Idempotent.
 */
export async function runAttendanceRetention(tx: Transaction<DB>, companyId: string, today: string, audit: AuditEvents): Promise<AttendanceRetentionResult> {
  const before = retentionCutoff(today, await retentionMonthsOf(tx, companyId));
  const { punches, corrections } = await purgeAttendance(tx, companyId, before);
  if (punches > 0 || corrections > 0) await audit.record({ type: 'attendance.purged', subject: null, data: { punches, corrections, before } });
  return { before, punches, corrections };
}
