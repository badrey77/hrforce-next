import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import { scopeAssignmentSql } from '../../staffing/index.js';
import type { CountMode } from '../domain/days.js';
import type { LedgerSums, RequestStatus } from '../domain/rules.js';

/** Postgres error raised by a constraint (pg's DatabaseError fields). */
export function constraintViolation(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return typeof code === 'string' && typeof constraint === 'string' ? { code, constraint } : undefined;
}

export interface PolicyRow {
  referenceStartMonth: number;
  weekendDays: number[];
  entitlementDelayMonths: number;
}

export const DEFAULT_POLICY: PolicyRow = { referenceStartMonth: 7, weekendDays: [5, 6], entitlementDelayMonths: 12 };

export interface TypeRow {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  countMode: CountMode;
  hasBalance: boolean;
  accrualDaysPerMonth: string | null;
  maxDaysPerYear: string | null;
  maxDaysPerRequest: string | null;
  oncePerCareer: boolean;
  requiresDocument: boolean;
  workflowDefinitionId: string;
  active: boolean;
  sortOrder: number;
}

export interface HolidayRow {
  id: string;
  date: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  approximate: boolean;
}

export interface RequestRow {
  id: string;
  employmentId: string;
  leaveTypeId: string;
  orgUnitId: string;
  startDate: string;
  endDate: string;
  days: string;
  halfDayStart: boolean;
  halfDayEnd: boolean;
  reason: string | null;
  documentRef: string | null;
  status: RequestStatus;
  requestedBy: string;
  requestedAt: string;
  workflowInstanceId: string | null;
}

export interface LedgerRow {
  id: string;
  leaveTypeId: string;
  periodStart: string;
  kind: 'accrual' | 'taken' | 'adjustment' | 'reversal';
  days: string;
  requestId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface NewLedgerRow {
  employmentId: string;
  leaveTypeId: string;
  periodStart: string;
  kind: LedgerRow['kind'];
  /** days (not tenths) */
  days: number;
  requestId?: string | null;
  note?: string | null;
  createdBy: string | null;
}

export interface EmploymentFacts {
  id: string;
  personId: string;
  hireDate: string;
  endDate: string | null;
}

export interface ListFilter {
  scope: UnitIdQuery;
  status?: RequestStatus | undefined;
  unitId?: string | undefined;
  includeSubUnits?: boolean;
  from?: string | undefined;
  to?: string | undefined;
  typeId?: string | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

const TS = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const TYPE_COLUMNS = sql`t.id, t.code, t.name_fr as "nameFr", t.name_ar as "nameAr", t.name_en as "nameEn", t.count_mode as "countMode",
  t.has_balance as "hasBalance", t.accrual_days_per_month::text as "accrualDaysPerMonth", t.max_days_per_year::text as "maxDaysPerYear",
  t.max_days_per_request::text as "maxDaysPerRequest", t.once_per_career as "oncePerCareer", t.requires_document as "requiresDocument",
  t.workflow_definition_id as "workflowDefinitionId", t.active, t.sort_order as "sortOrder"`;

const REQUEST_COLUMNS = sql`r.id, r.employment_id as "employmentId", r.leave_type_id as "leaveTypeId", r.org_unit_id as "orgUnitId",
  r.start_date::text as "startDate", r.end_date::text as "endDate", r.days::text as days, r.half_day_start as "halfDayStart",
  r.half_day_end as "halfDayEnd", r.reason, r.document_ref as "documentRef", r.status, r.requested_by as "requestedBy",
  ${TS('r.requested_at')} as "requestedAt", r.workflow_instance_id as "workflowInstanceId"`;

function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Leave configuration, requests and ledger — through the request transaction, always filtered by company. */
@Injectable()
export class LeaveRepository {
  // ── configuration ───────────────────────────────────────────────────────────────────────────────────────────────

  async policy(companyId: string): Promise<PolicyRow> {
    const { rows } = await sql<PolicyRow>`
      select reference_start_month as "referenceStartMonth", weekend_days as "weekendDays", entitlement_delay_months as "entitlementDelayMonths"
        from leave_policy where company_id = ${companyId}::uuid`.execute(currentTx());
    return rows[0] ?? DEFAULT_POLICY;
  }

  async savePolicy(companyId: string, policy: PolicyRow): Promise<void> {
    await sql`
      insert into leave_policy (company_id, reference_start_month, weekend_days, entitlement_delay_months)
      values (${companyId}::uuid, ${policy.referenceStartMonth}, ${policy.weekendDays}::integer[], ${policy.entitlementDelayMonths})
      on conflict (company_id) do update
        set reference_start_month = excluded.reference_start_month, weekend_days = excluded.weekend_days,
            entitlement_delay_months = excluded.entitlement_delay_months, updated_at = now()`.execute(currentTx());
  }

  async types(companyId: string): Promise<TypeRow[]> {
    const { rows } = await sql<TypeRow>`select ${TYPE_COLUMNS} from leave_type t where t.company_id = ${companyId}::uuid
      order by t.sort_order, t.code`.execute(currentTx());
    return rows;
  }

  async type(companyId: string, id: string): Promise<TypeRow | undefined> {
    const { rows } = await sql<TypeRow>`select ${TYPE_COLUMNS} from leave_type t
      where t.company_id = ${companyId}::uuid and t.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async updateType(companyId: string, id: string, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await currentTx().updateTable('leave_type').set(patch).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async definitionExists(companyId: string, id: string): Promise<boolean> {
    const row = await currentTx().selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row !== undefined;
  }

  async holidays(companyId: string, from: string, to: string): Promise<HolidayRow[]> {
    const { rows } = await sql<HolidayRow>`
      select id, date::text as date, name_fr as "nameFr", name_ar as "nameAr", name_en as "nameEn", approximate
        from public_holiday
       where company_id = ${companyId}::uuid and date between ${from}::date and ${to}::date
       order by date`.execute(currentTx());
    return rows;
  }

  async holiday(companyId: string, id: string): Promise<HolidayRow | undefined> {
    const { rows } = await sql<HolidayRow>`
      select id, date::text as date, name_fr as "nameFr", name_ar as "nameAr", name_en as "nameEn", approximate
        from public_holiday where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async insertHoliday(companyId: string, h: Omit<HolidayRow, 'id'>): Promise<string> {
    const row = await currentTx()
      .insertInto('public_holiday')
      .values({ company_id: companyId, date: h.date, name_fr: h.nameFr, name_ar: h.nameAr, name_en: h.nameEn, approximate: h.approximate })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async updateHoliday(companyId: string, id: string, h: Omit<HolidayRow, 'id'>): Promise<void> {
    await currentTx()
      .updateTable('public_holiday')
      .set({ date: h.date, name_fr: h.nameFr, name_ar: h.nameAr, name_en: h.nameEn, approximate: h.approximate })
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .execute();
  }

  async deleteHoliday(companyId: string, id: string): Promise<void> {
    await currentTx().deleteFrom('public_holiday').where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  // ── employments ─────────────────────────────────────────────────────────────────────────────────────────────────

  async employment(companyId: string, id: string): Promise<EmploymentFacts | undefined> {
    const { rows } = await sql<EmploymentFacts>`
      select id, person_id as "personId", hire_date::text as "hireDate", end_date::text as "endDate"
        from employment where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  // ── requests ────────────────────────────────────────────────────────────────────────────────────────────────────

  async insertRequest(companyId: string, r: Omit<RequestRow, 'id' | 'status' | 'requestedAt' | 'workflowInstanceId'>): Promise<string> {
    const row = await currentTx()
      .insertInto('leave_request')
      .values({
        company_id: companyId,
        employment_id: r.employmentId,
        leave_type_id: r.leaveTypeId,
        org_unit_id: r.orgUnitId,
        start_date: r.startDate,
        end_date: r.endDate,
        days: r.days,
        half_day_start: r.halfDayStart,
        half_day_end: r.halfDayEnd,
        reason: r.reason,
        document_ref: r.documentRef,
        requested_by: r.requestedBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async setInstance(companyId: string, id: string, instanceId: string): Promise<void> {
    await currentTx().updateTable('leave_request').set({ workflow_instance_id: instanceId }).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async setStatus(companyId: string, id: string, status: RequestStatus): Promise<void> {
    await currentTx().updateTable('leave_request').set({ status }).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async request(companyId: string, id: string): Promise<RequestRow | undefined> {
    const { rows } = await sql<RequestRow>`select ${REQUEST_COLUMNS} from leave_request r
      where r.company_id = ${companyId}::uuid and r.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async requests(companyId: string, ids: readonly string[]): Promise<RequestRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<RequestRow>`select ${REQUEST_COLUMNS} from leave_request r
      where r.company_id = ${companyId}::uuid and r.id = any(${[...ids]}::uuid[])`.execute(currentTx());
    return rows;
  }

  async requestsOf(companyId: string, employmentId: string): Promise<RequestRow[]> {
    const { rows } = await sql<RequestRow>`select ${REQUEST_COLUMNS} from leave_request r
      where r.company_id = ${companyId}::uuid and r.employment_id = ${employmentId}::uuid
      order by r.requested_at desc, r.id desc`.execute(currentTx());
    return rows;
  }

  private filtered(companyId: string, f: ListFilter): RawBuilder<unknown> {
    const where: RawBuilder<unknown>[] = [sql`r.company_id = ${companyId}::uuid`, sql`r.org_unit_id in (${f.scope})`];
    if (f.status) where.push(sql`r.status = ${f.status}`);
    if (f.unitId) {
      const depth = f.includeSubUnits ? sql`` : sql`and c.depth = 0`;
      where.push(sql`r.org_unit_id in (select c.descendant_id from org_unit_closure c
        where c.company_id = ${companyId}::uuid and c.ancestor_id = ${f.unitId}::uuid ${depth})`);
    }
    if (f.from) where.push(sql`r.end_date >= ${f.from}::date`);
    if (f.to) where.push(sql`r.start_date <= ${f.to}::date`);
    if (f.typeId) where.push(sql`r.leave_type_id = ${f.typeId}::uuid`);
    if (f.q) {
      const pattern = likeContains(f.q);
      where.push(sql`(p.search_text like search_normalize(${pattern}) or e.matricule_search like search_normalize(${pattern}))`);
    }
    return sql`from leave_request r
      join employment e on e.company_id = r.company_id and e.id = r.employment_id
      join person p on p.company_id = e.company_id and p.id = e.person_id
      where ${sql.join(where, sql` and `)}`;
  }

  async list(companyId: string, f: ListFilter): Promise<{ rows: RequestRow[]; total: number }> {
    const from = this.filtered(companyId, f);
    const count = await sql<{ n: number }>`select count(*)::int as n ${from}`.execute(currentTx());
    const { rows } = await sql<RequestRow>`select ${REQUEST_COLUMNS} ${from}
      order by r.start_date desc, r.requested_at desc, r.id limit ${f.limit} offset ${f.offset}`.execute(currentTx());
    return { rows, total: count.rows[0]?.n ?? 0 };
  }

  /** Another pending/approved request of the employment intersects [start, end]. */
  async overlaps(companyId: string, employmentId: string, start: string, end: string): Promise<boolean> {
    const { rows } = await sql`select 1 from leave_request
      where company_id = ${companyId}::uuid and employment_id = ${employmentId}::uuid and status in ('pending', 'approved')
        and daterange(start_date, end_date, '[]') && daterange(${start}::date, ${end}::date, '[]') limit 1`.execute(currentTx());
    return rows.length > 0;
  }

  /** A pending/approved request of this type exists for the PERSON (any of their employments). */
  async takenByPerson(companyId: string, personId: string, typeId: string): Promise<boolean> {
    const { rows } = await sql`select 1 from leave_request r
      join employment e on e.company_id = r.company_id and e.id = r.employment_id
      where r.company_id = ${companyId}::uuid and e.person_id = ${personId}::uuid and r.leave_type_id = ${typeId}::uuid
        and r.status in ('pending', 'approved') limit 1`.execute(currentTx());
    return rows.length > 0;
  }

  /** Days (tenths) of the employment's pending requests per type. */
  async pendingTenths(companyId: string, employmentId: string, excludeRequestId?: string): Promise<Map<string, number>> {
    const { rows } = await sql<{ type: string; tenths: number }>`
      select leave_type_id as type, round(sum(days) * 10)::int as tenths from leave_request
       where company_id = ${companyId}::uuid and employment_id = ${employmentId}::uuid and status = 'pending'
         and id is distinct from ${excludeRequestId ?? null}::uuid
       group by leave_type_id`.execute(currentTx());
    return new Map(rows.map((r) => [r.type, r.tenths]));
  }

  /** Employments whose scope unit (as of `date`) is in `scope`. */
  async employmentsIn(companyId: string, scope: UnitIdQuery, date: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      select e.id from employment e join lateral ${scopeAssignmentSql(sql`e.id`, date)} a on true
       where e.company_id = ${companyId}::uuid and a.org_unit_id in (${scope})`.execute(currentTx());
    return rows.map((r) => r.id);
  }

  // ── ledger ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Sums (tenths) per type and reference year. */
  async sums(companyId: string, employmentId: string): Promise<Map<string, LedgerSums[]>> {
    const { rows } = await sql<{ type: string; period: string; accrual: number; taken: number; adjustment: number; reversal: number }>`
      select leave_type_id as type, period_start::text as period,
             coalesce(round(sum(days) filter (where kind = 'accrual') * 10), 0)::int as accrual,
             coalesce(round(sum(days) filter (where kind = 'taken') * 10), 0)::int as taken,
             coalesce(round(sum(days) filter (where kind = 'adjustment') * 10), 0)::int as adjustment,
             coalesce(round(sum(days) filter (where kind = 'reversal') * 10), 0)::int as reversal
        from leave_ledger
       where company_id = ${companyId}::uuid and employment_id = ${employmentId}::uuid
       group by leave_type_id, period_start`.execute(currentTx());
    const out = new Map<string, LedgerSums[]>();
    for (const r of rows) {
      out.set(r.type, [...(out.get(r.type) ?? []), { periodStart: r.period, accrual: r.accrual, taken: r.taken, adjustment: r.adjustment, reversal: r.reversal }]);
    }
    return out;
  }

  async ledger(companyId: string, employmentId: string): Promise<LedgerRow[]> {
    const { rows } = await sql<LedgerRow>`
      select id, leave_type_id as "leaveTypeId", period_start::text as "periodStart", kind, days::text as days, request_id as "requestId",
             note, created_by as "createdBy", ${TS('created_at')} as "createdAt"
        from leave_ledger
       where company_id = ${companyId}::uuid and employment_id = ${employmentId}::uuid
       order by created_at desc, id desc`.execute(currentTx());
    return rows;
  }

  async ledgerOfRequest(companyId: string, requestId: string): Promise<LedgerRow[]> {
    const { rows } = await sql<LedgerRow>`
      select id, leave_type_id as "leaveTypeId", period_start::text as "periodStart", kind, days::text as days, request_id as "requestId",
             note, created_by as "createdBy", ${TS('created_at')} as "createdAt"
        from leave_ledger where company_id = ${companyId}::uuid and request_id = ${requestId}::uuid order by created_at, id`.execute(currentTx());
    return rows;
  }

  async insertLedger(companyId: string, rows: readonly NewLedgerRow[]): Promise<void> {
    if (rows.length === 0) return;
    await currentTx()
      .insertInto('leave_ledger')
      .values(
        rows.map((r) => ({
          company_id: companyId,
          employment_id: r.employmentId,
          leave_type_id: r.leaveTypeId,
          period_start: r.periodStart,
          kind: r.kind,
          days: r.days,
          request_id: r.requestId ?? null,
          note: r.note ?? null,
          created_by: r.createdBy,
        })),
      )
      .execute();
  }
}
