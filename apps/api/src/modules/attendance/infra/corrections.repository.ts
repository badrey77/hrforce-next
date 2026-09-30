import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import { scopeAssignmentSql } from '../../staffing/index.js';

export type CorrectionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface CorrectionRow {
  id: string;
  employmentId: string;
  orgUnitId: string;
  workDate: string;
  reason: string;
  status: CorrectionStatus;
  requestedBy: string;
  requestedAt: Date;
  workflowInstanceId: string | null;
}

export interface CorrectionItemRow {
  id: string;
  correctionId: string;
  position: number;
  action: 'add' | 'void';
  direction: 'in' | 'out' | null;
  occurredAt: Date | null;
  punchId: string | null;
  resultPunchId: string | null;
}

export interface CorrectionListQuery {
  /** attendance.read scope: the employee's scope unit today must be in it */
  scope: UnitIdQuery;
  today: string;
  status?: CorrectionStatus | undefined;
  /** the employee's scope unit is one of these (unitId, with sub-units or not) */
  units?: readonly string[] | undefined;
  employmentId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  limit: number;
  offset: number;
}

const COLUMNS = sql`
  c.id, c.employment_id as "employmentId", c.org_unit_id as "orgUnitId", c.work_date::text as "workDate", c.reason, c.status,
  c.requested_by as "requestedBy", c.requested_at as "requestedAt", c.workflow_instance_id as "workflowInstanceId"`;

const ids = (list: readonly string[]): RawBuilder<unknown> => sql.join(list.map((id) => sql`${id}::uuid`));

/** `%q%` with LIKE wildcards escaped (the search columns are normalised by search_normalize()). */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Postgres error helper: the constraint of a driver error. */
export function constraintOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const c = (error as { constraint?: unknown }).constraint;
  return typeof c === 'string' ? c : undefined;
}

/**
 * Punch corrections and their items (docs/contracts/attendance.md › Phase B) — through the request transaction,
 * always filtered by company too (RLS is the backstop).
 */
@Injectable()
export class CorrectionsRepository {
  async insert(
    companyId: string,
    c: { employmentId: string; orgUnitId: string; workDate: string; reason: string; requestedBy: string },
    items: readonly { position: number; action: 'add' | 'void'; direction: 'in' | 'out' | null; occurredAt: Date | null; punchId: string | null }[],
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into attendance_correction (company_id, employment_id, org_unit_id, work_date, reason, requested_by)
      values (${companyId}::uuid, ${c.employmentId}::uuid, ${c.orgUnitId}::uuid, ${c.workDate}::date, ${c.reason}, ${c.requestedBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('attendance_correction insert returned no id');
    for (const item of items) {
      await sql`
        insert into attendance_correction_item (company_id, correction_id, position, action, direction, occurred_at, punch_id)
        values (${companyId}::uuid, ${id}::uuid, ${item.position}, ${item.action}, ${item.direction}, ${item.occurredAt}, ${item.punchId}::uuid)`.execute(currentTx());
    }
    return id;
  }

  async setInstance(companyId: string, id: string, instanceId: string): Promise<void> {
    await sql`update attendance_correction set workflow_instance_id = ${instanceId}::uuid where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async setStatus(companyId: string, id: string, status: CorrectionStatus): Promise<void> {
    await sql`update attendance_correction set status = ${status} where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async setResultPunch(companyId: string, itemId: string, punchId: string): Promise<void> {
    await sql`update attendance_correction_item set result_punch_id = ${punchId}::uuid where company_id = ${companyId}::uuid and id = ${itemId}::uuid`.execute(currentTx());
  }

  async get(companyId: string, id: string, { lock = false } = {}): Promise<CorrectionRow | undefined> {
    const { rows } = await sql<CorrectionRow>`
      select ${COLUMNS} from attendance_correction c where c.company_id = ${companyId}::uuid and c.id = ${id}::uuid
      ${lock ? sql`for update` : sql``}`.execute(currentTx());
    return rows[0];
  }

  async many(companyId: string, list: readonly string[]): Promise<CorrectionRow[]> {
    if (list.length === 0) return [];
    const { rows } = await sql<CorrectionRow>`
      select ${COLUMNS} from attendance_correction c where c.company_id = ${companyId}::uuid and c.id in (${ids(list)})`.execute(currentTx());
    return rows;
  }

  async ofEmployment(companyId: string, employmentId: string, status?: CorrectionStatus): Promise<CorrectionRow[]> {
    const { rows } = await sql<CorrectionRow>`
      select ${COLUMNS} from attendance_correction c
       where c.company_id = ${companyId}::uuid and c.employment_id = ${employmentId}::uuid ${status ? sql`and c.status = ${status}` : sql``}
       order by c.requested_at desc, c.id desc`.execute(currentTx());
    return rows;
  }

  async pendingExists(companyId: string, employmentId: string, workDate: string): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      select id from attendance_correction
       where company_id = ${companyId}::uuid and employment_id = ${employmentId}::uuid and work_date = ${workDate}::date and status = 'pending'
       limit 1`.execute(currentTx());
    return rows.length > 0;
  }

  async items(companyId: string, correctionIds: readonly string[]): Promise<CorrectionItemRow[]> {
    if (correctionIds.length === 0) return [];
    const { rows } = await sql<CorrectionItemRow>`
      select i.id, i.correction_id as "correctionId", i.position, i.action, i.direction, i.occurred_at as "occurredAt",
             i.punch_id as "punchId", i.result_punch_id as "resultPunchId"
        from attendance_correction_item i
       where i.company_id = ${companyId}::uuid and i.correction_id in (${ids(correctionIds)})
       order by i.correction_id, i.position`.execute(currentTx());
    return rows;
  }

  /** The HR list: scoped by the employee's scope unit today (employment.md › Scope), newest first. */
  async list(companyId: string, query: CorrectionListQuery): Promise<{ rows: CorrectionRow[]; total: number }> {
    if (query.units !== undefined && query.units.length === 0) return { rows: [], total: 0 };
    const filters: RawBuilder<unknown>[] = [sql`c.company_id = ${companyId}::uuid`, sql`a.org_unit_id in (${query.scope})`];
    if (query.units) filters.push(sql`a.org_unit_id in (${ids(query.units)})`);
    if (query.status) filters.push(sql`c.status = ${query.status}`);
    if (query.employmentId) filters.push(sql`c.employment_id = ${query.employmentId}::uuid`);
    if (query.from) filters.push(sql`c.work_date >= ${query.from}::date`);
    if (query.to) filters.push(sql`c.work_date <= ${query.to}::date`);
    if (query.q) filters.push(sql`(p.search_text like search_normalize(${likeContains(query.q)}) or e.matricule_search like search_normalize(${likeContains(query.q)}))`);
    const { rows } = await sql<CorrectionRow & { total: number }>`
      select ${COLUMNS}, count(*) over ()::int as total
        from attendance_correction c
        join employment e on e.company_id = c.company_id and e.id = c.employment_id
        join person p on p.company_id = e.company_id and p.id = e.person_id
        join lateral ${scopeAssignmentSql(sql`e.id`, query.today)} a on true
       where ${sql.join(filters, sql` and `)}
       order by c.requested_at desc, c.id desc
       limit ${query.limit} offset ${query.offset}`.execute(currentTx());
    return { rows: rows.map(({ total: _t, ...r }) => r), total: rows[0]?.total ?? 0 };
  }

  /** The definition of a workflow code (seeded per company). */
  async definitionId(companyId: string, code: string): Promise<string | undefined> {
    const row = await currentTx().selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('code', '=', code).executeTakeFirst();
    return row?.id;
  }

  /** Employments active on at least one day of [from, to] (hired by `to`), optionally matching `q`. */
  async activeIn(companyId: string, from: string, to: string, q: string | undefined): Promise<string[]> {
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
}
