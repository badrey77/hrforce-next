import { sql, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { computeDeadlines, deadlineKey, type DeadlineCandidate } from '../domain/compute.js';
import { DEFAULT_DEADLINE_POLICY, type DeadlinePolicy } from '../domain/types.js';
import { DeadlinesRepository } from './deadlines.repository.js';

/** DEMO's policy: the defaults, stored (the settings page shows a saved row). */
export const DEMO_DEADLINE_POLICY: Readonly<DeadlinePolicy> = DEFAULT_DEADLINE_POLICY;

/** The policy row of a company, ONLY when it has none (bootstrap, seed:dev). */
export async function seedDeadlinePolicy(tx: Transaction<DB>, companyId: string, policy: DeadlinePolicy = DEFAULT_DEADLINE_POLICY): Promise<void> {
  await sql`
    insert into deadline_policy (company_id, probation_notice_days, contract_notice_days, decision_notice_days, document_notice_days,
                                 retirement_age, retirement_notice_months, digest_enabled)
    values (${companyId}::uuid, ${policy.probationNoticeDays}, ${policy.contractNoticeDays}, ${policy.decisionNoticeDays}, ${policy.documentNoticeDays},
            ${policy.retirementAge}, ${policy.retirementNoticeMonths}, ${policy.digestEnabled})
    on conflict (company_id) do nothing`.execute(tx);
}

/** The demo's handled item: the first employee-file expiry, else the first probation end, else nothing. */
function pick(candidates: readonly DeadlineCandidate[]): DeadlineCandidate | undefined {
  const by = (kind: DeadlineCandidate['kind']) => candidates.filter((c) => c.kind === kind).toSorted((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.subjectId < b.subjectId ? -1 : 1))[0];
  return by('document_expiry') ?? by('probation_end');
}

/**
 * seed:dev (docs/contracts/contracts-deadlines.md › Seed): DEMO's stored policy and ONE acknowledged item, marked by
 * `ackedBy` (rh.admin) with a note. Run after the contracts and employee files are seeded. Idempotent: an existing
 * acknowledgement of the company is left as is.
 */
export async function seedDemoDeadlineAcks(tx: Transaction<DB>, companyId: string, ackedBy: string, today: string): Promise<{ acked: string | null }> {
  await seedDeadlinePolicy(tx, companyId, DEMO_DEADLINE_POLICY);
  const existing = await sql<{ n: number }>`select count(*)::int as n from deadline_ack where company_id = ${companyId}::uuid`.execute(tx);
  if ((existing.rows[0]?.n ?? 0) > 0) return { acked: null };
  const repo = new DeadlinesRepository();
  const employments = await repo.employments(companyId, { today, scope: null }, tx);
  const files = (await repo.files(companyId, employments.map((e) => e.employmentId), tx)).filter((f) => !f.medical);
  const chosen = pick(computeDeadlines(employments, files, await repo.policy(companyId, tx), today));
  if (!chosen) return { acked: null };
  await sql`
    insert into deadline_ack (company_id, kind, subject_id, due_date, note, acked_by)
    values (${companyId}::uuid, ${chosen.kind}, ${chosen.subjectId}::uuid, ${chosen.dueDate}::date,
            ${chosen.kind === 'document_expiry' ? 'Renouvellement demandé à l’intéressé(e).' : 'Période d’essai confirmée.'}, ${ackedBy}::uuid)
    on conflict (company_id, kind, subject_id, due_date) do nothing`.execute(tx);
  return { acked: deadlineKey(chosen.kind, chosen.subjectId, chosen.dueDate) };
}
