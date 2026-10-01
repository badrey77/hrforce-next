import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { ChainLink } from '../domain/manager.js';

/** An employment with its person and its scope assignment's unit as of a date. */
export interface EmployeeCardRow {
  id: string;
  matricule: string;
  hireDate: string;
  endDate: string | null;
  personId: string;
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
  jobTitle: string;
  unitId: string;
  unitCode: string;
  unitKind: string;
  unitName: string;
  unitNameAr: string | null;
}

export interface EmployeeClaimRow {
  matricule: string;
  active: boolean;
  unitId: string | null;
  unitCode: string | null;
  unitName: string | null;
  unitNameAr: string | null;
}

export interface HeadRow {
  id: string;
  employmentId: string;
  validFrom: string;
  validTo: string | null;
}

export interface MemberRow {
  id: string;
  email: string;
  displayName: string;
}

/**
 * The SCOPE assignment of employment `e` on date `d` (docs/contracts/employment.md › Scope): the one valid on d;
 * else the latest one started before d (an ended employment's last one); else the first one. Lateral sub-query.
 */
export function scopeAssignmentSql(employmentRef: RawBuilder<unknown>, date: string): RawBuilder<{ org_unit_id: string; site_id: string | null; job_title: string }> {
  return sql`(
    select x.org_unit_id, x.site_id, x.job_title
      from assignment x
     where x.company_id = e.company_id and x.employment_id = ${employmentRef}
     order by case when x.valid @> ${date}::date then 0 when lower(x.valid) <= ${date}::date then 1 else 2 end,
              case when lower(x.valid) <= ${date}::date then lower(x.valid) end desc nulls last,
              lower(x.valid) asc
     limit 1
  )`;
}

/** Links (user ↔ employment), unit heads, employee cards and the management chain — through the request transaction. */
@Injectable()
export class StaffingRepository {
  async members(companyId: string): Promise<MemberRow[]> {
    const { rows } = await sql<{ user_id: string; email: string; display_name: string }>`
      select user_id, email, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return rows.map((r) => ({ id: r.user_id, email: r.email, displayName: r.display_name }));
  }

  async linkOfUser(companyId: string, userId: string): Promise<string | undefined> {
    const row = await currentTx()
      .selectFrom('user_employment')
      .select('employment_id')
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.employment_id;
  }

  /**
   * The SSO `employee` claim of a user (docs/contracts/sso.md › Claims): the linked employment's matricule, whether it
   * is open on `date`, and the unit of its assignment valid on `date` (none → null unit). undefined = not linked.
   */
  async employeeClaim(companyId: string, userId: string, date: string): Promise<EmployeeClaimRow | undefined> {
    const { rows } = await sql<EmployeeClaimRow>`
      select e.matricule,
             (e.hire_date <= ${date}::date and (e.end_date is null or e.end_date >= ${date}::date)) as active,
             u.id as "unitId", u.code as "unitCode", coalesce(v.name, u.code) as "unitName", v.name_ar as "unitNameAr"
        from user_employment ue
        join employment e on e.company_id = ue.company_id and e.id = ue.employment_id
        left join assignment a on a.company_id = e.company_id and a.employment_id = e.id and a.valid @> ${date}::date
        left join org_unit u on u.company_id = a.company_id and u.id = a.org_unit_id
        left join lateral (
          select vv.name, vv.name_ar from org_unit_version vv
           where vv.company_id = u.company_id and vv.org_unit_id = u.id
           order by (vv.valid @> ${date}::date) desc, lower(vv.valid) desc
           limit 1
        ) v on true
       where ue.company_id = ${companyId}::uuid and ue.user_id = ${userId}::uuid
       order by lower(a.valid) desc nulls last
       limit 1`.execute(currentTx());
    return rows[0];
  }

  async usersOfEmployments(companyId: string, employmentIds: readonly string[]): Promise<Map<string, string>> {
    if (employmentIds.length === 0) return new Map();
    const rows = await currentTx()
      .selectFrom('user_employment')
      .select(['employment_id', 'user_id'])
      .where('company_id', '=', companyId)
      .where('employment_id', 'in', [...employmentIds])
      .execute();
    return new Map(rows.map((r) => [r.employment_id, r.user_id]));
  }

  async unlink(companyId: string, userId: string): Promise<void> {
    await currentTx().deleteFrom('user_employment').where('company_id', '=', companyId).where('user_id', '=', userId).execute();
  }

  async link(companyId: string, userId: string, employmentId: string, linkedBy: string): Promise<void> {
    await currentTx()
      .insertInto('user_employment')
      .values({ company_id: companyId, user_id: userId, employment_id: employmentId, linked_by: linkedBy })
      .execute();
  }

  async cards(companyId: string, ids: readonly string[], date: string): Promise<EmployeeCardRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<EmployeeCardRow>`
      select e.id, e.matricule, e.hire_date::text as "hireDate", e.end_date::text as "endDate",
             p.id as "personId", p.last_name as "lastName", p.first_name as "firstName",
             p.last_name_ar as "lastNameAr", p.first_name_ar as "firstNameAr",
             a.job_title as "jobTitle", u.id as "unitId", u.code as "unitCode", u.kind as "unitKind",
             coalesce(v.name, '') as "unitName", v.name_ar as "unitNameAr"
        from employment e
        join person p on p.company_id = e.company_id and p.id = e.person_id
        join lateral ${scopeAssignmentSql(sql`e.id`, date)} a on true
        join org_unit u on u.company_id = e.company_id and u.id = a.org_unit_id
        left join lateral (
          select vv.name, vv.name_ar from org_unit_version vv
           where vv.company_id = u.company_id and vv.org_unit_id = u.id
           order by (vv.valid @> ${date}::date) desc, lower(vv.valid) desc
           limit 1
        ) v on true
       where e.company_id = ${companyId}::uuid and e.id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})`.execute(currentTx());
    return rows;
  }

  /**
   * The management chain of `unitId` on `date`: the unit then each ancestor (tree as of `date`, from the versions),
   * with the head valid on `date` and the user linked to that head's employment.
   */
  async chain(companyId: string, unitId: string, date: string): Promise<ChainLink[]> {
    const { rows } = await sql<{ unit_id: string; depth: number; head: string | null; user_id: string | null }>`
      with recursive
      uv as (
        select distinct on (v.org_unit_id) v.org_unit_id as id, v.parent_id
          from org_unit_version v
         where v.company_id = ${companyId}::uuid
         order by v.org_unit_id, (v.valid @> ${date}::date) desc, lower(v.valid) asc
      ),
      up (id, depth) as (
        select ${unitId}::uuid, 0
        union all
        select uv.parent_id, up.depth + 1 from up join uv on uv.id = up.id where uv.parent_id is not null and up.depth < 64
      )
      select up.id as unit_id, up.depth, h.employment_id as head, ue.user_id
        from up
        left join org_unit_head h on h.company_id = ${companyId}::uuid and h.org_unit_id = up.id and h.valid @> ${date}::date
        left join user_employment ue on ue.company_id = ${companyId}::uuid and ue.employment_id = h.employment_id
       order by up.depth`.execute(currentTx());
    return rows.map((r) => ({ unitId: r.unit_id, depth: r.depth, headEmploymentId: r.head, headUserId: r.user_id }));
  }

  /** Units headed on `date` by the employment, with their version valid on that date (code order). */
  async unitsHeadedBy(companyId: string, employmentId: string, date: string): Promise<{ id: string; code: string; name: string; nameAr: string | null; kind: string }[]> {
    const { rows } = await sql<{ id: string; code: string; name: string; nameAr: string | null; kind: string }>`
      select u.id, u.code, coalesce(v.name, '') as name, v.name_ar as "nameAr", u.kind
        from org_unit_head h
        join org_unit u on u.company_id = h.company_id and u.id = h.org_unit_id
        left join lateral (
          select vv.name, vv.name_ar from org_unit_version vv
           where vv.company_id = u.company_id and vv.org_unit_id = u.id
           order by (vv.valid @> ${date}::date) desc, lower(vv.valid) desc
           limit 1
        ) v on true
       where h.company_id = ${companyId}::uuid and h.employment_id = ${employmentId}::uuid and h.valid @> ${date}::date
       order by u.code`.execute(currentTx());
    return rows;
  }

  async unitExists(companyId: string, unitId: string): Promise<boolean> {
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', companyId).where('id', '=', unitId).executeTakeFirst();
    return row !== undefined;
  }

  async heads(companyId: string, unitId: string): Promise<HeadRow[]> {
    const { rows } = await sql<HeadRow>`
      select h.id, h.employment_id as "employmentId", lower(h.valid)::text as "validFrom", upper(h.valid)::text as "validTo"
        from org_unit_head h
       where h.company_id = ${companyId}::uuid and h.org_unit_id = ${unitId}::uuid
       order by lower(h.valid) desc`.execute(currentTx());
    return rows;
  }

  async closeHead(companyId: string, headId: string, validTo: string): Promise<void> {
    await sql`update org_unit_head set valid = daterange(lower(valid), ${validTo}::date, '[)')
               where company_id = ${companyId}::uuid and id = ${headId}::uuid`.execute(currentTx());
  }

  async insertHead(companyId: string, unitId: string, employmentId: string, validFrom: string): Promise<void> {
    await sql`insert into org_unit_head (company_id, org_unit_id, employment_id, valid)
              values (${companyId}::uuid, ${unitId}::uuid, ${employmentId}::uuid, daterange(${validFrom}::date, null, '[)'))`.execute(currentTx());
  }
}
