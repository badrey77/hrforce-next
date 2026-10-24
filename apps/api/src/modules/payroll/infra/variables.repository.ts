import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { EmploymentFacts } from '../../attendance/index.js';
import type { PayrollSource, PayrollUnit } from '../domain/computation.js';
import type { AdjustmentFact, ClosedLineFact, RubriqueFact } from '../domain/lines.js';
import { DEFAULT_PAYROLL_SETTINGS } from '../domain/settings.js';

const ids = (list: readonly string[]): RawBuilder<unknown> => sql.join(list.map((id) => sql`${id}::uuid`));

/** An employment with its person (names) and every assignment — the Attendance module's EmploymentFacts shape. */
export type PayrollEmploymentRow = EmploymentFacts;

export interface PeriodRow {
  id: string;
  /** first day */
  month: string;
  status: 'open' | 'closed';
  hasClosings: boolean;
}

export interface ClosingRow {
  id: string;
  periodId: string;
  month: string;
  version: number;
  closedBy: string;
  closedAt: Date;
  reopenedBy: string | null;
  reopenedAt: Date | null;
  reopenReason: string | null;
  lines: number;
  employees: number;
}

export interface LineRow extends ClosedLineFact {
  closingId: string;
  employmentId: string;
  note: string | null;
  exportCode: string;
  unit: PayrollUnit;
  matricule: string;
  lastName: string;
  firstName: string;
  unitCode: string | null;
}

export interface NewLine {
  employmentId: string;
  rubriqueId: string;
  originMonth: string;
  computedValue: number | null;
  value: number;
  adjusted: boolean;
  note: string | null;
  exportCode: string;
  unit: PayrollUnit;
  matricule: string;
  lastName: string;
  firstName: string;
  unitCode: string | null;
}

export interface PayrollPolicyFacts {
  cutoffDay: number;
  regularizationMonths: number;
  overtimeMinMinutes: number;
}

/** `%q%` with LIKE wildcards escaped (the search columns are normalised by search_normalize()). */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/**
 * What the payroll computation and the closings read and write (payroll_period, payroll_adjustment,
 * payroll_closing, payroll_line) — through the request transaction, always filtered by company too (RLS is the backstop).
 */
@Injectable()
export class VariablesRepository {
  async policy(companyId: string): Promise<PayrollPolicyFacts> {
    const row = await currentTx()
      .selectFrom('payroll_policy')
      .select(['cutoff_day', 'regularization_months', 'overtime_min_minutes'])
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    return row
      ? { cutoffDay: row.cutoff_day, regularizationMonths: row.regularization_months, overtimeMinMinutes: row.overtime_min_minutes }
      : {
          cutoffDay: DEFAULT_PAYROLL_SETTINGS.cutoffDay,
          regularizationMonths: DEFAULT_PAYROLL_SETTINGS.regularizationMonths,
          overtimeMinMinutes: DEFAULT_PAYROLL_SETTINGS.overtimeMinMinutes,
        };
  }

  async rubriques(companyId: string): Promise<RubriqueFact[]> {
    const rows = await currentTx()
      .selectFrom('payroll_rubrique')
      .select(['id', 'source', 'leave_type_id', 'export_code', 'name_fr', 'name_ar', 'name_en', 'unit', 'active', 'sort_order'])
      .where('company_id', '=', companyId)
      .orderBy('sort_order')
      .orderBy('export_code')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      source: r.source as PayrollSource,
      leaveTypeId: r.leave_type_id,
      exportCode: r.export_code,
      names: { fr: r.name_fr, ar: r.name_ar, en: r.name_en },
      unit: r.unit as PayrollUnit,
      active: r.active,
      sortOrder: r.sort_order,
    }));
  }

  /** Employments active on at least one day of [from, to], optionally matching `q` (name or matricule, as GET /employees). */
  async activeIn(companyId: string, from: string, to: string, q?: string): Promise<string[]> {
    const search = q
      ? sql`and (p.search_text like search_normalize(${likeContains(q)}) or e.matricule_search like search_normalize(${likeContains(q)}))`
      : sql``;
    const { rows } = await sql<{ id: string }>`
      select e.id from employment e
        join person p on p.company_id = e.company_id and p.id = e.person_id
       where e.company_id = ${companyId}::uuid and e.hire_date <= ${to}::date and (e.end_date is null or e.end_date >= ${from}::date)
       ${search}`.execute(currentTx());
    return rows.map((r) => r.id);
  }

  /** Employments with their person and every assignment (the scope filter runs before the computation). */
  async employments(companyId: string, employmentIds: readonly string[]): Promise<PayrollEmploymentRow[]> {
    if (employmentIds.length === 0) return [];
    const [employments, assignments] = await Promise.all([
      sql<Omit<PayrollEmploymentRow, 'assignments'>>`
        select e.id, e.matricule, e.hire_date::text as "hireDate", e.end_date::text as "endDate",
               p.last_name as "lastName", p.first_name as "firstName", p.last_name_ar as "lastNameAr", p.first_name_ar as "firstNameAr",
               coalesce(p.sort_name, '') as "sortName"
          from employment e
          join person p on p.company_id = e.company_id and p.id = e.person_id
         where e.company_id = ${companyId}::uuid and e.id in (${ids(employmentIds)})`.execute(currentTx()),
      sql<{ employmentId: string; orgUnitId: string; siteId: string | null; from: string; to: string | null }>`
        select a.employment_id as "employmentId", a.org_unit_id as "orgUnitId", a.site_id as "siteId",
               lower(a.valid)::text as "from", upper(a.valid)::text as "to"
          from assignment a
         where a.company_id = ${companyId}::uuid and a.employment_id in (${ids(employmentIds)})
         order by lower(a.valid)`.execute(currentTx()),
    ]);
    const byEmployment = new Map<string, PayrollEmploymentRow['assignments']>();
    for (const { employmentId, ...a } of assignments.rows) byEmployment.set(employmentId, [...(byEmployment.get(employmentId) ?? []), a]);
    return employments.rows.map((e) => ({ ...e, assignments: byEmployment.get(e.id) ?? [] }));
  }

  /** employmentId → « matricule paie ». */
  async employeeCodes(companyId: string, employmentIds: readonly string[] | null): Promise<Map<string, string>> {
    if (employmentIds !== null && employmentIds.length === 0) return new Map();
    let q = currentTx().selectFrom('payroll_employee_code').select(['employment_id', 'code']).where('company_id', '=', companyId);
    if (employmentIds !== null) q = q.where('employment_id', 'in', [...employmentIds]);
    return new Map((await q.execute()).map((r) => [r.employment_id, r.code]));
  }

  // ── periods and closings ──────────────────────────────────────────────────────────────────────────────────────

  async periods(companyId: string): Promise<PeriodRow[]> {
    const { rows } = await sql<PeriodRow>`
      select p.id, p.month::text as month, p.status,
             exists (select 1 from payroll_closing c where c.company_id = p.company_id and c.period_id = p.id) as "hasClosings"
        from payroll_period p where p.company_id = ${companyId}::uuid order by p.month`.execute(currentTx());
    return rows;
  }

  /**
   * The period row of `month`, created open when missing ("created on first write or close"), and locked: `update`
   * for a close / reopen (two concurrent closes queue here; the second one then reads `closed`), `share` for an
   * adjustment (so it never lands in a month being closed).
   */
  async lockPeriod(companyId: string, month: string, mode: 'update' | 'share'): Promise<PeriodRow> {
    await sql`insert into payroll_period (company_id, month) values (${companyId}::uuid, ${month}::date)
              on conflict (company_id, month) do nothing`.execute(currentTx());
    const { rows } = await sql<PeriodRow>`
      select p.id, p.month::text as month, p.status,
             exists (select 1 from payroll_closing c where c.company_id = p.company_id and c.period_id = p.id) as "hasClosings"
        from payroll_period p where p.company_id = ${companyId}::uuid and p.month = ${month}::date
       ${mode === 'update' ? sql`for update of p` : sql`for share of p`}`.execute(currentTx());
    const row = rows[0];
    if (!row) throw new Error(`payroll_period ${month} vanished`);
    return row;
  }

  async setPeriodStatus(companyId: string, periodId: string, status: 'open' | 'closed'): Promise<void> {
    await currentTx().updateTable('payroll_period').set({ status }).where('company_id', '=', companyId).where('id', '=', periodId).execute();
  }

  /** Every closing of the months (any version), oldest version first. */
  async closings(companyId: string, months: readonly string[] | null): Promise<ClosingRow[]> {
    if (months !== null && months.length === 0) return [];
    const only = months === null ? sql`` : sql`and p.month in (${sql.join(months.map((m) => sql`${m}::date`))})`;
    const { rows } = await sql<ClosingRow>`
      select c.id, c.period_id as "periodId", p.month::text as month, c.version, c.closed_by as "closedBy", c.closed_at as "closedAt",
             c.reopened_by as "reopenedBy", c.reopened_at as "reopenedAt", c.reopen_reason as "reopenReason", c.lines, c.employees
        from payroll_closing c
        join payroll_period p on p.company_id = c.company_id and p.id = c.period_id
       where c.company_id = ${companyId}::uuid ${only}
       order by p.month, c.version`.execute(currentTx());
    return rows;
  }

  /** The lines of the closings (optionally of some employments). */
  async lines(companyId: string, closingIds: readonly string[], employmentIds: readonly string[] | null = null): Promise<LineRow[]> {
    if (closingIds.length === 0 || (employmentIds !== null && employmentIds.length === 0)) return [];
    const only = employmentIds === null ? sql`` : sql`and l.employment_id in (${ids(employmentIds)})`;
    const { rows } = await sql<Omit<LineRow, 'computedValue' | 'value'> & { computedValue: string | null; value: string }>`
      select l.closing_id as "closingId", l.employment_id as "employmentId", l.rubrique_id as "rubriqueId", l.origin_month::text as "originMonth",
             l.computed_value::text as "computedValue", l.value::text as value, l.adjusted, l.note, l.export_code as "exportCode", l.unit,
             l.matricule, l.last_name as "lastName", l.first_name as "firstName", l.unit_code as "unitCode"
        from payroll_line l
       where l.company_id = ${companyId}::uuid and l.closing_id in (${ids(closingIds)}) ${only}`.execute(currentTx());
    return rows.map((r) => ({ ...r, computedValue: num(r.computedValue), value: Number(r.value) }));
  }

  async insertClosing(companyId: string, c: { periodId: string; version: number; closedBy: string; lines: number; employees: number }): Promise<string> {
    const row = await currentTx()
      .insertInto('payroll_closing')
      .values({ company_id: companyId, period_id: c.periodId, version: c.version, closed_by: c.closedBy, lines: c.lines, employees: c.employees })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async insertLines(companyId: string, closingId: string, lines: readonly NewLine[]): Promise<void> {
    for (let i = 0; i < lines.length; i += 1000) {
      await currentTx()
        .insertInto('payroll_line')
        .values(
          lines.slice(i, i + 1000).map((l) => ({
            company_id: companyId,
            closing_id: closingId,
            employment_id: l.employmentId,
            rubrique_id: l.rubriqueId,
            origin_month: l.originMonth,
            computed_value: l.computedValue === null ? null : l.computedValue.toFixed(2),
            value: l.value.toFixed(2),
            adjusted: l.adjusted,
            note: l.note,
            export_code: l.exportCode,
            unit: l.unit,
            matricule: l.matricule,
            last_name: l.lastName,
            first_name: l.firstName,
            unit_code: l.unitCode,
          })),
        )
        .execute();
    }
  }

  async reopenClosing(companyId: string, closingId: string, by: string, reason: string): Promise<void> {
    await currentTx()
      .updateTable('payroll_closing')
      .set({ reopened_by: by, reopened_at: sql<Date>`now()`, reopen_reason: reason })
      .where('company_id', '=', companyId)
      .where('id', '=', closingId)
      .execute();
  }

  // ── adjustments ───────────────────────────────────────────────────────────────────────────────────────────────

  async adjustments(companyId: string, month: string, employmentIds: readonly string[] | null): Promise<(AdjustmentFact & { employmentId: string })[]> {
    if (employmentIds !== null && employmentIds.length === 0) return [];
    const only = employmentIds === null ? sql`` : sql`and a.employment_id in (${ids(employmentIds)})`;
    const { rows } = await sql<{ employmentId: string; originMonth: string; rubriqueId: string; value: string; note: string | null }>`
      select a.employment_id as "employmentId", a.origin_month::text as "originMonth", a.rubrique_id as "rubriqueId", a.value::text as value, a.note
        from payroll_adjustment a
       where a.company_id = ${companyId}::uuid and a.month = ${month}::date ${only}`.execute(currentTx());
    return rows.map((r) => ({ ...r, value: Number(r.value) }));
  }

  async upsertAdjustment(
    companyId: string,
    a: { month: string; originMonth: string; employmentId: string; rubriqueId: string; value: number; note: string | null; by: string },
  ): Promise<void> {
    await sql`
      insert into payroll_adjustment (company_id, month, origin_month, employment_id, rubrique_id, value, note, updated_by)
      values (${companyId}::uuid, ${a.month}::date, ${a.originMonth}::date, ${a.employmentId}::uuid, ${a.rubriqueId}::uuid, ${a.value.toFixed(2)}::numeric,
              ${a.note}, ${a.by}::uuid)
      on conflict (company_id, month, origin_month, employment_id, rubrique_id)
      do update set value = excluded.value, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
       where (payroll_adjustment.value, payroll_adjustment.note) is distinct from (excluded.value, excluded.note)`.execute(currentTx());
  }

  async deleteAdjustment(companyId: string, a: { month: string; originMonth: string; employmentId: string; rubriqueId: string }): Promise<boolean> {
    const res = await currentTx()
      .deleteFrom('payroll_adjustment')
      .where('company_id', '=', companyId)
      .where('month', '=', sql<Date>`${a.month}::date`)
      .where('origin_month', '=', sql<Date>`${a.originMonth}::date`)
      .where('employment_id', '=', a.employmentId)
      .where('rubrique_id', '=', a.rubriqueId)
      .executeTakeFirst();
    return Number(res.numDeletedRows) > 0;
  }

  /** Display names of the company's members (auth.company_members). */
  async members(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }
}
