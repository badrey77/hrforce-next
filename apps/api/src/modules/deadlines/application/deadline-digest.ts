import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import type { Notifier } from '../../../platform/notifications/notifier.js';
import { computeDeadlines, deadlineKey, enteredSince, type DeadlineCandidate } from '../domain/compute.js';
import { DEADLINE_PERMISSIONS as P } from '../domain/types.js';
import { DeadlinesRepository } from '../infra/deadlines.repository.js';

export interface DigestCounts {
  newCount: number;
  overdueCount: number;
  criticalCount: number;
}

export interface DigestRunResult {
  recipients: number;
  notified: number;
  skipped?: 'disabled';
}

/**
 * The notification subject of one user's digest of one day: a stable UUID (hash of company, user and date, version
 * nibble 5), so a re-run of the job on the same day is a no-op (notification_once_uk).
 */
export function digestSubjectId(companyId: string, userId: string, date: string): string {
  const h = createHash('sha256').update(`deadline_digest:${companyId}:${userId}:${date}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** One user's counts over the open (not handled) items of their units. */
export function countsFor(items: readonly DeadlineCandidate[], since: string, today: string): DigestCounts {
  let newCount = 0;
  let overdueCount = 0;
  let criticalCount = 0;
  for (const c of items) {
    if (enteredSince(c, since, today)) newCount += 1;
    if (c.status === 'overdue') overdueCount += 1;
    if (c.severity === 'critical') criticalCount += 1;
  }
  return { newCount, overdueCount, criticalCount };
}

/**
 * The daily digest of one company (docs/contracts/contracts-deadlines.md › Worker): each holder of `deadline.read`
 * whose units have items that entered their notice window or became overdue in `(since, today]` gets one
 * `deadline.digest` notification (at most one per day). Medical files count only for holders of
 * `employee.medical.read` over the employee's unit; handled items never count. Runs in the job's transaction.
 */
export async function runDeadlineDigest(tx: Transaction<DB>, companyId: string, today: string, since: string, notifier: Notifier): Promise<DigestRunResult> {
  const repo = new DeadlinesRepository();
  const policy = await repo.policy(companyId, tx);
  if (!policy.digestEnabled) return { recipients: 0, notified: 0, skipped: 'disabled' };
  const [holders, medical, employments] = await Promise.all([
    repo.holders(companyId, P.read, today, tx),
    repo.holders(companyId, 'employee.medical.read', today, tx),
    repo.employments(companyId, { today, scope: null }, tx),
  ]);
  if (holders.size === 0) return { recipients: 0, notified: 0 };
  const files = await repo.files(companyId, employments.map((e) => e.employmentId), tx);
  const candidates = computeDeadlines(employments, files, policy, today);
  const acks = await repo.acks(companyId, candidates.map((c) => c.subjectId), tx);
  const handled = new Set(acks.map((a) => deadlineKey(a.kind, a.subjectId, a.dueDate)));
  const unitOf = new Map(employments.map((e) => [e.employmentId, e.unitId]));
  const medicalFiles = new Set(files.filter((f) => f.medical).map((f) => f.id));
  const open = candidates.filter((c) => !handled.has(deadlineKey(c.kind, c.subjectId, c.dueDate)));

  let notified = 0;
  for (const [userId, units] of holders) {
    const medicalUnits = medical.get(userId);
    const mine = open.filter((c) => {
      const unit = unitOf.get(c.employmentId);
      if (!unit || !units.has(unit)) return false;
      return !(c.fileId && medicalFiles.has(c.fileId)) || (medicalUnits?.has(unit) ?? false);
    });
    const counts = countsFor(mine, since, today);
    if (counts.newCount === 0) continue;
    await notifier.notify({
      type: 'deadline.digest',
      subject: { type: 'deadline_digest', id: digestSubjectId(companyId, userId, today) },
      data: { ...counts, date: today },
      recipients: [{ userId, audience: 'approver' }],
    });
    notified += 1;
  }
  return { recipients: holders.size, notified };
}
