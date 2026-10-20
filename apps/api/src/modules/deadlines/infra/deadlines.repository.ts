import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import { scopeAssignmentSql } from '../../staffing/index.js';
import type { ContractFact, EmploymentFact } from '../domain/compute.js';
import { DEFAULT_DEADLINE_POLICY, type ContractType, type DeadlineKind, type DeadlinePolicy } from '../domain/types.js';

/** Postgres error raised by a constraint (pg's DatabaseError fields). */
export function pgError(error: unknown): { code: string; constraint?: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  if (typeof code !== 'string') return undefined;
  return typeof constraint === 'string' ? { code, constraint } : { code };
}

/** An open employment with its scope unit today. */
export interface EmploymentRow extends EmploymentFact {
  unitId: string;
}

export interface FileRow {
  id: string;
  employmentId: string;
  expiresOn: string;
  title: string;
  categoryCode: string;
  categoryNameFr: string;
  categoryNameAr: string;
  categoryNameEn: string;
  medical: boolean;
}

export interface AckRow {
  id: string;
  kind: DeadlineKind;
  subjectId: string;
  dueDate: string;
  note: string | null;
  ackedBy: string;
  ackedAt: string;
}

export interface DecisionRef {
  id: string;
  status: string;
  contractId: string;
}

export interface FactsFilter {
  today: string;
  /** the caller's `deadline.read` scope; null = every unit (the worker) */
  scope: UnitIdQuery | null;
  unitId?: string | undefined;
  includeSubUnits?: boolean | undefined;
  q?: string | undefined;
}

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const ISO_AT = (ref: RawBuilder<unknown>) => sql<string>`to_char(${ref} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Deadlines data (docs/contracts/contracts-deadlines.md › Deadlines): the facts the computation reads (open
 * employments, their contracts, employee files with an expiry date), acknowledgements, the policy, and for the daily
 * job the holders of a permission with their units. Every method takes the transaction explicitly or uses the request
 * one (`currentTx()`), always filters by company; RLS is the backstop.
 */
@Injectable()
export class DeadlinesRepository {
  private tx(tx?: Transaction<DB>): Transaction<DB> {
    return tx ?? currentTx();
  }

  /** The employments open on `today` (no end date, or one not yet passed) in the scope, with their scope unit. */
  async employments(companyId: string, f: FactsFilter, tx?: Transaction<DB>): Promise<EmploymentRow[]> {
    const where: RawBuilder<unknown>[] = [sql`e.company_id = ${companyId}::uuid`, sql`(e.end_date is null or e.end_date >= ${f.today}::date)`];
    if (f.scope) where.push(sql`a.org_unit_id in (${f.scope})`);
    if (f.unitId) {
      const depth = f.includeSubUnits === false ? sql`and c.depth = 0` : sql``;
      where.push(sql`a.org_unit_id in (select c.descendant_id from org_unit_closure c
        where c.company_id = ${companyId}::uuid and c.ancestor_id = ${f.unitId}::uuid ${depth})`);
    }
    if (f.q) {
      const pattern = likeContains(f.q);
      where.push(sql`(p.search_text like search_normalize(${pattern}) or e.matricule_search like search_normalize(${pattern}))`);
    }
    const { rows } = await sql<{ employmentId: string; hireDate: string; endDate: string | null; birthDate: string | null; unitId: string }>`
      select e.id as "employmentId", to_char(e.hire_date, 'YYYY-MM-DD') as "hireDate", to_char(e.end_date, 'YYYY-MM-DD') as "endDate",
             to_char(p.birth_date, 'YYYY-MM-DD') as "birthDate", a.org_unit_id as "unitId"
        from employment e
        join person p on p.company_id = e.company_id and p.id = e.person_id
        join lateral ${scopeAssignmentSql(sql`e.id`, f.today)} a on true
       where ${sql.join(where, sql` and `)}`.execute(this.tx(tx));
    const contracts = await this.contractsOf(companyId, rows.map((r) => r.employmentId), tx);
    return rows.map((r) => ({ ...r, contracts: contracts.get(r.employmentId) ?? [] }));
  }

  private async contractsOf(companyId: string, employmentIds: readonly string[], tx?: Transaction<DB>): Promise<Map<string, ContractFact[]>> {
    const out = new Map<string, ContractFact[]>();
    if (employmentIds.length === 0) return out;
    const { rows } = await sql<ContractFact & { employmentId: string }>`
      select c.id, c.employment_id as "employmentId", c.contract_type as "contractType", to_char(c.start_date, 'YYYY-MM-DD') as "startDate",
             to_char(c.end_date, 'YYYY-MM-DD') as "endDate", to_char(c.probation_end, 'YYYY-MM-DD') as "probationEnd"
        from employment_contract c
       where c.company_id = ${companyId}::uuid and c.employment_id = any(${[...employmentIds]}::uuid[])
       order by c.employment_id, c.start_date`.execute(this.tx(tx));
    for (const { employmentId, ...c } of rows) {
      const list = out.get(employmentId) ?? [];
      list.push({ ...c, contractType: c.contractType as ContractType });
      out.set(employmentId, list);
    }
    return out;
  }

  /** Employee files with an expiry date, neither deleted nor purged, of these employments. */
  async files(companyId: string, employmentIds: readonly string[], tx?: Transaction<DB>): Promise<FileRow[]> {
    if (employmentIds.length === 0) return [];
    const { rows } = await sql<FileRow>`
      select f.id, f.employment_id as "employmentId", to_char(f.expires_on, 'YYYY-MM-DD') as "expiresOn", f.title,
             c.code as "categoryCode", c.name_fr as "categoryNameFr", c.name_ar as "categoryNameAr", c.name_en as "categoryNameEn",
             c.access_class = 'medical' as medical
        from employee_file f
        join employee_file_category c on c.company_id = f.company_id and c.id = f.category_id
       where f.company_id = ${companyId}::uuid and f.employment_id = any(${[...employmentIds]}::uuid[])
         and f.expires_on is not null and f.deleted_at is null and f.purged_at is null`.execute(this.tx(tx));
    return rows;
  }

  /** The pending decision of each contract, else its latest approved one. */
  async decisions(companyId: string, contractIds: readonly string[]): Promise<Map<string, DecisionRef>> {
    const out = new Map<string, DecisionRef>();
    if (contractIds.length === 0) return out;
    const { rows } = await sql<DecisionRef>`
      select distinct on (d.contract_id) d.id, d.status, d.contract_id as "contractId"
        from contract_decision d
       where d.company_id = ${companyId}::uuid and d.contract_id = any(${[...contractIds]}::uuid[]) and d.status in ('pending', 'approved')
       order by d.contract_id, (d.status = 'pending') desc, d.created_at desc`.execute(currentTx());
    for (const r of rows) out.set(r.contractId, r);
    return out;
  }

  async acks(companyId: string, subjectIds: readonly string[], tx?: Transaction<DB>): Promise<AckRow[]> {
    if (subjectIds.length === 0) return [];
    const { rows } = await sql<AckRow>`
      select k.id, k.kind, k.subject_id as "subjectId", to_char(k.due_date, 'YYYY-MM-DD') as "dueDate", k.note, k.acked_by as "ackedBy",
             ${ISO_AT(sql`k.acked_at`)} as "ackedAt"
        from deadline_ack k
       where k.company_id = ${companyId}::uuid and k.subject_id = any(${[...new Set(subjectIds)]}::uuid[])`.execute(this.tx(tx));
    return rows;
  }

  async ack(companyId: string, id: string): Promise<AckRow | undefined> {
    const { rows } = await sql<AckRow>`
      select k.id, k.kind, k.subject_id as "subjectId", to_char(k.due_date, 'YYYY-MM-DD') as "dueDate", k.note, k.acked_by as "ackedBy",
             ${ISO_AT(sql`k.acked_at`)} as "ackedAt"
        from deadline_ack k where k.company_id = ${companyId}::uuid and k.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async insertAck(companyId: string, a: { kind: DeadlineKind; subjectId: string; dueDate: string; note: string | null; ackedBy: string }): Promise<string> {
    const row = await currentTx()
      .insertInto('deadline_ack')
      .values({ company_id: companyId, kind: a.kind, subject_id: a.subjectId, due_date: a.dueDate, note: a.note, acked_by: a.ackedBy })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async deleteAck(companyId: string, id: string): Promise<void> {
    await currentTx().deleteFrom('deadline_ack').where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async policy(companyId: string, tx?: Transaction<DB>): Promise<DeadlinePolicy> {
    const { rows } = await sql<DeadlinePolicy>`
      select probation_notice_days as "probationNoticeDays", contract_notice_days as "contractNoticeDays",
             decision_notice_days as "decisionNoticeDays", document_notice_days as "documentNoticeDays",
             retirement_age as "retirementAge", retirement_notice_months as "retirementNoticeMonths", digest_enabled as "digestEnabled"
        from deadline_policy where company_id = ${companyId}::uuid`.execute(this.tx(tx));
    return rows[0] ?? { ...DEFAULT_DEADLINE_POLICY };
  }

  /** Upsert; an unchanged policy writes nothing (no audit row). */
  async savePolicy(companyId: string, p: DeadlinePolicy, tx?: Transaction<DB>): Promise<void> {
    await sql`
      insert into deadline_policy (company_id, probation_notice_days, contract_notice_days, decision_notice_days, document_notice_days,
                                   retirement_age, retirement_notice_months, digest_enabled)
      values (${companyId}::uuid, ${p.probationNoticeDays}, ${p.contractNoticeDays}, ${p.decisionNoticeDays}, ${p.documentNoticeDays},
              ${p.retirementAge}, ${p.retirementNoticeMonths}, ${p.digestEnabled})
      on conflict (company_id) do update set
        probation_notice_days = excluded.probation_notice_days, contract_notice_days = excluded.contract_notice_days,
        decision_notice_days = excluded.decision_notice_days, document_notice_days = excluded.document_notice_days,
        retirement_age = excluded.retirement_age, retirement_notice_months = excluded.retirement_notice_months,
        digest_enabled = excluded.digest_enabled, updated_at = now()
      where (deadline_policy.probation_notice_days, deadline_policy.contract_notice_days, deadline_policy.decision_notice_days,
             deadline_policy.document_notice_days, deadline_policy.retirement_age, deadline_policy.retirement_notice_months,
             deadline_policy.digest_enabled)
        is distinct from (excluded.probation_notice_days, excluded.contract_notice_days, excluded.decision_notice_days,
             excluded.document_notice_days, excluded.retirement_age, excluded.retirement_notice_months, excluded.digest_enabled)`.execute(this.tx(tx));
  }

  /** The scope unit today of the employee a deadline subject belongs to (contract, employee file or employment). */
  async subjectUnit(companyId: string, kind: DeadlineKind, subjectId: string, today: string): Promise<string | undefined> {
    const employment =
      kind === 'probation_end' || kind === 'contract_end'
        ? sql`(select c.employment_id from employment_contract c where c.company_id = ${companyId}::uuid and c.id = ${subjectId}::uuid)`
        : kind === 'document_expiry'
          ? sql`(select f.employment_id from employee_file f where f.company_id = ${companyId}::uuid and f.id = ${subjectId}::uuid)`
          : sql`${subjectId}::uuid`;
    const { rows } = await sql<{ unitId: string }>`
      select a.org_unit_id as "unitId" from employment e join lateral ${scopeAssignmentSql(sql`e.id`, today)} a on true
       where e.company_id = ${companyId}::uuid and e.id = ${employment}`.execute(currentTx());
    return rows[0]?.unitId;
  }

  async names(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }

  /**
   * For the daily job: each holder of `permission` today and the units it covers (role grants valid today, the
   * grant's unit and, with include_descendants, its subtree in today's tree) — the same rule as the request-time
   * scope (authorization.md › Evaluation).
   */
  async holders(companyId: string, permission: string, today: string, tx: Transaction<DB>): Promise<Map<string, Set<string>>> {
    const { rows } = await sql<{ userId: string; unitId: string }>`
      select distinct g.user_id as "userId", c.descendant_id as "unitId"
        from role_grant g
        join role_permission rp on rp.company_id = g.company_id and rp.role_id = g.role_id
        join org_unit_closure c on c.company_id = g.company_id and c.ancestor_id = g.org_unit_id
        join org_unit_closure s on s.company_id = g.company_id and s.ancestor_id = g.org_unit_id and s.descendant_id = g.org_unit_id
       where g.company_id = ${companyId}::uuid and rp.permission_code = ${permission} and g.valid @> ${today}::date
         and (g.include_descendants or c.depth = 0)`.execute(tx);
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      const units = out.get(r.userId) ?? new Set<string>();
      units.add(r.unitId);
      out.set(r.userId, units);
    }
    return out;
  }
}
