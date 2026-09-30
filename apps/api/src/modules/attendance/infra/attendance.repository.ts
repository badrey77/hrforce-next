import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import { scopeAssignmentSql } from '../../staffing/index.js';

export interface PunchRow {
  id: string;
  employmentId: string;
  direction: 'in' | 'out';
  occurredAt: Date;
  workDate: string;
  source: 'qr' | 'manual';
  deviceId: string | null;
  qrWindow: number | null;
  siteId: string | null;
  deviceRef: string | null;
  reason: string | null;
  createdBy: string | null;
  status: 'live' | 'void';
  voidedAt: Date | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface NewPunch {
  employmentId: string;
  direction: 'in' | 'out';
  occurredAt: Date;
  source: 'qr' | 'manual';
  deviceId: string | null;
  qrWindow: number | null;
  siteId: string | null;
  deviceRef: string | null;
  reason: string | null;
  createdBy: string | null;
}

/** An employment with its person (names) and every assignment. */
export interface EmploymentFacts {
  id: string;
  matricule: string;
  hireDate: string;
  endDate: string | null;
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
  sortName: string;
  assignments: { orgUnitId: string; siteId: string | null; from: string; to: string | null }[];
}

export interface UnitVersionRow {
  unitId: string;
  kind: string;
  code: string;
  name: string;
  nameAr: string | null;
  parentId: string | null;
  siteId: string | null;
  isRoot: boolean;
  from: string;
  to: string | null;
}

export interface SiteRow {
  id: string;
  code: string;
  name: string;
}

const PUNCH_COLUMNS = sql`
  p.id, p.employment_id as "employmentId", p.direction, p.occurred_at as "occurredAt", p.work_date::text as "workDate", p.source,
  p.device_id as "deviceId", p.qr_window::int8 as "qrWindow", p.site_id as "siteId", p.device_ref as "deviceRef", p.reason,
  p.created_by as "createdBy", p.status, p.voided_at as "voidedAt", p.voided_by as "voidedBy", p.void_reason as "voidReason"`;

function toPunch(r: PunchRow): PunchRow {
  return { ...r, qrWindow: r.qrWindow === null ? null : Number(r.qrWindow) };
}

const ids = (list: readonly string[]): RawBuilder<unknown> => sql.join(list.map((id) => sql`${id}::uuid`));

/**
 * Punches, the people and the organisation the daily computation reads — through the request transaction, always
 * filtered by company too (RLS is the backstop).
 */
@Injectable()
export class AttendanceRepository {
  // ── punches ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** Punches (live and void) of the employments (null = all) whose work day is in [from, to], oldest first. */
  async punches(companyId: string, employmentIds: readonly string[] | null, from: string, to: string): Promise<PunchRow[]> {
    if (employmentIds !== null && employmentIds.length === 0) return [];
    const only = employmentIds === null ? sql`` : sql`and p.employment_id in (${ids(employmentIds)})`;
    const { rows } = await sql<PunchRow>`
      select ${PUNCH_COLUMNS} from attendance_punch p
       where p.company_id = ${companyId}::uuid and p.work_date between ${from}::date and ${to}::date ${only}
       order by p.occurred_at, p.id`.execute(currentTx());
    return rows.map(toPunch);
  }

  async punch(companyId: string, id: string, { lock = false } = {}): Promise<PunchRow | undefined> {
    const { rows } = await sql<PunchRow>`
      select ${PUNCH_COLUMNS} from attendance_punch p where p.company_id = ${companyId}::uuid and p.id = ${id}::uuid
      ${lock ? sql`for update` : sql``}`.execute(currentTx());
    const row = rows[0];
    return row ? toPunch(row) : undefined;
  }

  async insertPunch(companyId: string, p: NewPunch): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into attendance_punch (company_id, employment_id, direction, occurred_at, source, device_id, qr_window, site_id, device_ref, reason, created_by)
      values (${companyId}::uuid, ${p.employmentId}::uuid, ${p.direction}, ${p.occurredAt}, ${p.source}, ${p.deviceId}::uuid, ${p.qrWindow},
              ${p.siteId}::uuid, ${p.deviceRef}, ${p.reason}, ${p.createdBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('attendance_punch insert returned no id');
    return id;
  }

  async voidPunch(companyId: string, id: string, by: string, reason: string): Promise<void> {
    await sql`update attendance_punch set status = 'void', voided_at = now(), voided_by = ${by}::uuid, void_reason = ${reason}
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** Serialises the punch writes of one employment (double taps, parallel scans): held until the transaction ends. */
  async lockEmployment(companyId: string, employmentId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`attendance:${companyId}:${employmentId}`}, 0))`.execute(currentTx());
  }

  /**
   * An earlier scan that makes this one a duplicate: a live punch of the employment within `gapSeconds` of the
   * instant, or any QR punch of the same (device, window).
   */
  async duplicateOf(companyId: string, employmentId: string, at: Date, gapSeconds: number, deviceId: string, window: number): Promise<PunchRow | undefined> {
    const { rows } = await sql<PunchRow>`
      select ${PUNCH_COLUMNS} from attendance_punch p
       where p.company_id = ${companyId}::uuid and p.employment_id = ${employmentId}::uuid
         and ((p.status = 'live' and abs(extract(epoch from (p.occurred_at - ${at}::timestamptz))) < ${gapSeconds})
              or (p.source = 'qr' and p.device_id = ${deviceId}::uuid and p.qr_window = ${window}))
       order by (p.source = 'qr' and p.device_id = ${deviceId}::uuid and p.qr_window = ${window}) desc, p.occurred_at desc
       limit 1`.execute(currentTx());
    const row = rows[0];
    return row ? toPunch(row) : undefined;
  }

  /** The latest live punch of the employment on `workDate` strictly before `at`. */
  async lastLiveBefore(companyId: string, employmentId: string, workDate: string, at: Date): Promise<PunchRow | undefined> {
    const { rows } = await sql<PunchRow>`
      select ${PUNCH_COLUMNS} from attendance_punch p
       where p.company_id = ${companyId}::uuid and p.employment_id = ${employmentId}::uuid and p.work_date = ${workDate}::date
         and p.status = 'live' and p.occurred_at < ${at}::timestamptz
       order by p.occurred_at desc, p.id desc
       limit 1`.execute(currentTx());
    const row = rows[0];
    return row ? toPunch(row) : undefined;
  }

  /** A live punch of the employment in the same minute (manual entry duplicate check). */
  async liveInMinute(companyId: string, employmentId: string, minuteStart: Date): Promise<boolean> {
    const { rows } = await sql<{ id: string }>`
      select p.id from attendance_punch p
       where p.company_id = ${companyId}::uuid and p.employment_id = ${employmentId}::uuid and p.status = 'live'
         and p.occurred_at >= ${minuteStart}::timestamptz and p.occurred_at < ${minuteStart}::timestamptz + interval '1 minute'
       limit 1`.execute(currentTx());
    return rows.length > 0;
  }

  /**
   * For each work day of [from, to]: device ref → the employments whose live QR punches used it (the shared_device
   * flag: a ref used by two employments of the company the same day).
   */
  async deviceRefs(companyId: string, from: string, to: string): Promise<Map<string, Map<string, Set<string>>>> {
    const { rows } = await sql<{ workDate: string; ref: string; employmentId: string }>`
      select distinct p.work_date::text as "workDate", p.device_ref as ref, p.employment_id as "employmentId"
        from attendance_punch p
       where p.company_id = ${companyId}::uuid and p.work_date between ${from}::date and ${to}::date
         and p.source = 'qr' and p.status = 'live' and p.device_ref is not null`.execute(currentTx());
    const out = new Map<string, Map<string, Set<string>>>();
    for (const r of rows) {
      const day = out.get(r.workDate) ?? new Map<string, Set<string>>();
      day.set(r.ref, (day.get(r.ref) ?? new Set<string>()).add(r.employmentId));
      out.set(r.workDate, day);
    }
    return out;
  }

  // ── people ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The caller's linked employment (user_employment), if any. */
  async linkedEmployment(companyId: string, userId: string): Promise<string | undefined> {
    const row = await currentTx()
      .selectFrom('user_employment')
      .select('employment_id')
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.employment_id;
  }

  /** Employments with their person and every assignment. */
  async employments(companyId: string, employmentIds: readonly string[]): Promise<EmploymentFacts[]> {
    if (employmentIds.length === 0) return [];
    const { rows } = await sql<Omit<EmploymentFacts, 'assignments'>>`
      select e.id, e.matricule, e.hire_date::text as "hireDate", e.end_date::text as "endDate",
             p.last_name as "lastName", p.first_name as "firstName", p.last_name_ar as "lastNameAr", p.first_name_ar as "firstNameAr",
             coalesce(p.sort_name, '') as "sortName"
        from employment e
        join person p on p.company_id = e.company_id and p.id = e.person_id
       where e.company_id = ${companyId}::uuid and e.id in (${ids(employmentIds)})`.execute(currentTx());
    const assignments = await sql<{ employmentId: string; orgUnitId: string; siteId: string | null; from: string; to: string | null }>`
      select a.employment_id as "employmentId", a.org_unit_id as "orgUnitId", a.site_id as "siteId",
             lower(a.valid)::text as "from", upper(a.valid)::text as "to"
        from assignment a
       where a.company_id = ${companyId}::uuid and a.employment_id in (${ids(employmentIds)})
       order by lower(a.valid)`.execute(currentTx());
    return rows.map((r) => ({
      ...r,
      assignments: assignments.rows.filter((a) => a.employmentId === r.id).map(({ employmentId: _e, ...a }) => a),
    }));
  }

  /**
   * Employments active on `date` whose scope assignment on `date` (valid then; else the rule of employment.md) has
   * its unit in `units` (a scope sub-query or an explicit list), optionally matching `q` on the name (Latin / Arabic)
   * or the matricule, as GET /employees. Ids only (the facts are loaded by {@link employments}).
   */
  async activeOn(companyId: string, date: string, units: UnitIdQuery | readonly string[], q: string | undefined): Promise<{ id: string; unitId: string }[]> {
    if (Array.isArray(units) && units.length === 0) return [];
    const unitFilter = Array.isArray(units) ? sql`a.org_unit_id in (${ids(units as readonly string[])})` : sql`a.org_unit_id in (${units as UnitIdQuery})`;
    const search = q
      ? sql`and (p.search_text like search_normalize(${likeContains(q)}) or e.matricule_search like search_normalize(${likeContains(q)}))`
      : sql``;
    const { rows } = await sql<{ id: string; unitId: string }>`
      select e.id, a.org_unit_id as "unitId"
        from employment e
        join person p on p.company_id = e.company_id and p.id = e.person_id
        join lateral ${scopeAssignmentSql(sql`e.id`, date)} a on true
       where e.company_id = ${companyId}::uuid
         and e.hire_date <= ${date}::date and (e.end_date is null or e.end_date >= ${date}::date)
         and ${unitFilter}
         ${search}`.execute(currentTx());
    return rows;
  }

  /** The scope unit of an employment on `date` (employment.md › Scope); undefined for an unknown id. */
  async scopeUnit(companyId: string, employmentId: string, date: string): Promise<string | undefined> {
    const { rows } = await sql<{ unitId: string }>`
      select a.org_unit_id as "unitId"
        from employment e
        join lateral ${scopeAssignmentSql(sql`e.id`, date)} a on true
       where e.company_id = ${companyId}::uuid and e.id = ${employmentId}::uuid`.execute(currentTx());
    return rows[0]?.unitId;
  }

  /** employmentId → linked user. */
  async linkedUsers(companyId: string, employmentIds: readonly string[]): Promise<Map<string, string>> {
    if (employmentIds.length === 0) return new Map();
    const rows = await currentTx()
      .selectFrom('user_employment')
      .select(['employment_id', 'user_id'])
      .where('company_id', '=', companyId)
      .where('employment_id', 'in', [...employmentIds])
      .execute();
    return new Map(rows.map((r) => [r.employment_id, r.user_id]));
  }

  /** Display names of the company's members (auth.company_members: current members only). */
  async members(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }

  // ── organisation ──────────────────────────────────────────────────────────────────────────────────────────────

  async unitVersions(companyId: string): Promise<UnitVersionRow[]> {
    const { rows } = await sql<UnitVersionRow>`
      select v.org_unit_id as "unitId", u.kind, u.code, v.name, v.name_ar as "nameAr", v.parent_id as "parentId", v.site_id as "siteId",
             u.is_root as "isRoot", lower(v.valid)::text as "from", upper(v.valid)::text as "to"
        from org_unit_version v
        join org_unit u on u.company_id = v.company_id and u.id = v.org_unit_id
       where v.company_id = ${companyId}::uuid
       order by v.org_unit_id, lower(v.valid)`.execute(currentTx());
    return rows;
  }

  /** Today's tree (org_unit_closure): descendant → ancestors, nearest first (the unit itself first). */
  async ancestors(companyId: string): Promise<Map<string, string[]>> {
    const { rows } = await sql<{ ancestorId: string; descendantId: string; depth: number }>`
      select ancestor_id as "ancestorId", descendant_id as "descendantId", depth
        from org_unit_closure where company_id = ${companyId}::uuid
       order by descendant_id, depth`.execute(currentTx());
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.descendantId, [...(out.get(r.descendantId) ?? []), r.ancestorId]);
    return out;
  }

  async sites(companyId: string): Promise<Map<string, SiteRow>> {
    const rows = await currentTx().selectFrom('site').select(['id', 'code', 'name']).where('company_id', '=', companyId).execute();
    return new Map(rows.map((r) => [r.id, r]));
  }

  async rootUnit(companyId: string): Promise<string | undefined> {
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', companyId).where('is_root', '=', true).executeTakeFirst();
    return row?.id;
  }
}

/** `%q%` with LIKE wildcards escaped (the search column is normalised by search_normalize()). */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// ── retention (worker) ────────────────────────────────────────────────────────────────────────────────────────────

/** Deletes the punches of work days before `cutoff` (worker role, company transaction) → the count. */
export async function purgePunches(tx: Transaction<DB>, companyId: string, cutoff: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    with gone as (
      delete from attendance_punch where company_id = ${companyId}::uuid and work_date < ${cutoff}::date returning 1
    )
    select count(*)::int as n from gone`.execute(tx);
  return rows[0]?.n ?? 0;
}

export async function retentionMonthsOf(tx: Transaction<DB>, companyId: string): Promise<number> {
  const row = await tx.selectFrom('attendance_policy').select('retention_months').where('company_id', '=', companyId).executeTakeFirst();
  return row?.retention_months ?? 60;
}
