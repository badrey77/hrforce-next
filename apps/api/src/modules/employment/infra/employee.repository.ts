import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import type { EmployeeSort, StatusFilter } from '../domain/employee.js';

/** Postgres error raised by a constraint (pg's DatabaseError fields). */
export function constraintViolation(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return typeof code === 'string' && typeof constraint === 'string' ? { code, constraint } : undefined;
}

/** `%`, `_` and `\` are LIKE wildcards/escape: match them literally. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface PersonRow {
  id: string;
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
  birthDate: string | null;
  birthPlace: string | null;
  sex: 'M' | 'F' | null;
  nationality: string;
  nin: string | null;
}

export interface EmploymentRow {
  id: string;
  personId: string;
  matricule: string;
  hireDate: string;
  endDate: string | null;
  endReason: string | null;
}

export interface AssignmentRow {
  id: string;
  orgUnitId: string;
  siteId: string | null;
  jobTitle: string;
  validFrom: string;
  validTo: string | null;
}

export interface SalaryRow {
  id: string;
  baseSalary: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
}

export interface SensitiveRow {
  nss: string | null;
  rib: string | null;
  bankName: string | null;
}

/** One version of an org unit, with the unit's code and kind (for in-memory snapshots at any date). */
export interface UnitVersionRow {
  unitId: string;
  code: string;
  kind: string;
  name: string;
  nameAr: string | null;
  parentId: string | null;
  siteId: string | null;
  validFrom: string;
  validTo: string | null;
}

export interface ListRow {
  id: string;
  matricule: string;
  hire_date: string;
  end_date: string | null;
  person_id: string;
  last_name: string;
  first_name: string;
  last_name_ar: string | null;
  first_name_ar: string | null;
  job_title: string;
  unit_id: string;
  unit_code: string;
  unit_kind: string;
  unit_name: string | null;
  unit_name_ar: string | null;
  site_id: string | null;
  site_code: string | null;
  site_name: string | null;
}

export interface ListParams {
  asOf: string;
  scope: UnitIdQuery;
  q?: string | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  siteId?: string | undefined;
  status: StatusFilter;
  sort: EmployeeSort;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export type PersonPatch = Partial<Omit<PersonRow, 'id'>>;

const DATE = (column: string) => sql<string>`${sql.ref(column)}::text`;
const VALID_FROM = (alias: string) => sql<string>`lower(${sql.ref(`${alias}.valid`)})::text`;
const VALID_TO = (alias: string) => sql<string | null>`upper(${sql.ref(`${alias}.valid`)})::text`;

/**
 * Persons, employments, assignments, salaries and sensitive data — always through the request transaction
 * (`currentTx()`), always filtered by the caller's company too (RLS on app.company_id is the backstop).
 */
@Injectable()
export class EmployeeRepository {
  // ── list ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The filtered set as a CTE chain (docs/contracts/employment.md › Scope, GET /employees):
   *   uv   every unit with its version valid on asOf (else its earliest version: a unit that starts later);
   *   eff  effective site of each unit on asOf (own site, else the nearest ancestor's), walking uv from the root;
   *   under (unitId filter) the unit and — includeSubUnits — its sub-units in the asOf tree;
   *   rows each employment with its SCOPE assignment as of asOf (valid on asOf; else the latest one started before —
   *        an ended employment's last assignment; else the first one), kept when that unit is in the caller's
   *        employee.read scope and the filters match.
   */
  private filtered(companyId: string, p: ListParams): RawBuilder<unknown> {
    const d = p.asOf;
    const under = p.unitId
      ? sql`, under (id, depth) as (
            select ${p.unitId}::uuid, 0
            union all
            select uv.id, under.depth + 1 from uv join under on uv.parent_id = under.id
             where ${p.includeSubUnits} and under.depth < 64
          )`
      : sql``;
    const filters: RawBuilder<unknown>[] = [];
    if (p.status === 'active') filters.push(sql`(e.end_date is null or e.end_date >= ${d}::date)`);
    if (p.status === 'ended') filters.push(sql`e.end_date < ${d}::date`);
    if (p.q) {
      const pattern = likeContains(p.q);
      filters.push(sql`(p.search_text like search_normalize(${pattern}) or e.matricule_search like search_normalize(${pattern}))`);
    }
    if (p.unitId) filters.push(sql`a.org_unit_id in (select id from under)`);
    if (p.siteId) filters.push(sql`coalesce(a.site_id, eff.site_id) = ${p.siteId}::uuid`);
    const where = filters.length ? sql`and ${sql.join(filters, sql` and `)}` : sql``;
    return sql`
      with recursive
      uv as (
        select distinct on (v.org_unit_id) v.org_unit_id as id, v.parent_id, v.site_id, v.name, v.name_ar
          from org_unit_version v
         where v.company_id = ${companyId}::uuid
         order by v.org_unit_id, (v.valid @> ${d}::date) desc, lower(v.valid) asc
      ),
      eff (id, site_id, depth) as (
        select uv.id, uv.site_id, 0 from uv where uv.parent_id is null
        union all
        select uv.id, coalesce(uv.site_id, eff.site_id), eff.depth + 1 from uv join eff on uv.parent_id = eff.id where eff.depth < 64
      )
      ${under},
      rows as (
        select e.id, e.matricule, e.hire_date::text as hire_date, e.end_date::text as end_date,
               p.id as person_id, p.last_name, p.first_name, p.last_name_ar, p.first_name_ar, p.sort_name,
               a.org_unit_id as unit_id, a.job_title, coalesce(a.site_id, eff.site_id) as site_id
          from employment e
          join person p on p.company_id = e.company_id and p.id = e.person_id
          join lateral (
            select x.org_unit_id, x.site_id, x.job_title
              from assignment x
             where x.company_id = e.company_id and x.employment_id = e.id
             order by case when x.valid @> ${d}::date then 0 when lower(x.valid) <= ${d}::date then 1 else 2 end,
                      case when lower(x.valid) <= ${d}::date then lower(x.valid) end desc nulls last,
                      lower(x.valid) asc
             limit 1
          ) a on true
          left join eff on eff.id = a.org_unit_id
         where e.company_id = ${companyId}::uuid
           and a.org_unit_id in (${p.scope})
           ${where}
      )`;
  }

  async listCount(companyId: string, params: ListParams): Promise<number> {
    const { rows } = await sql<{ n: number }>`${this.filtered(companyId, params)} select count(*)::int as n from rows`.execute(currentTx());
    return rows[0]?.n ?? 0;
  }

  async listPage(companyId: string, params: ListParams): Promise<{ rows: ListRow[]; total: number }> {
    const dir = params.dir === 'desc' ? sql`desc` : sql`asc`;
    const order = {
      name: sql`r.sort_name ${dir}, r.matricule ${dir}`,
      matricule: sql`r.matricule ${dir}`,
      hireDate: sql`r.hire_date ${dir}, r.sort_name asc`,
      unit: sql`search_normalize(uv.name) ${dir}, r.sort_name asc`,
    }[params.sort];
    const { rows } = await sql<ListRow & { total: number }>`
      ${this.filtered(companyId, params)}
      select r.id, r.matricule, r.hire_date, r.end_date, r.person_id, r.last_name, r.first_name, r.last_name_ar, r.first_name_ar,
             r.job_title, r.unit_id, u.code as unit_code, u.kind as unit_kind, uv.name as unit_name, uv.name_ar as unit_name_ar,
             r.site_id, s.code as site_code, s.name as site_name, count(*) over ()::int as total
        from rows r
        join org_unit u on u.company_id = ${companyId}::uuid and u.id = r.unit_id
        left join uv on uv.id = r.unit_id
        left join site s on s.company_id = ${companyId}::uuid and s.id = r.site_id
       order by ${order}, r.id asc
       limit ${params.limit} offset ${params.offset}`.execute(currentTx());
    // a page past the end has no rows to carry the window total
    const total = rows[0]?.total ?? (params.offset > 0 ? await this.listCount(companyId, params) : 0);
    return { rows, total };
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async findEmployment(companyId: string, id: string): Promise<EmploymentRow | undefined> {
    return currentTx()
      .selectFrom('employment as e')
      .select(['e.id', 'e.person_id as personId', 'e.matricule', DATE('e.hire_date').as('hireDate'), sql<string | null>`e.end_date::text`.as('endDate'), 'e.end_reason as endReason'])
      .where('e.company_id', '=', companyId)
      .where('e.id', '=', id)
      .executeTakeFirst();
  }

  /** The person's employments, newest hire first. */
  async employmentsOf(companyId: string, personId: string): Promise<EmploymentRow[]> {
    return currentTx()
      .selectFrom('employment as e')
      .select(['e.id', 'e.person_id as personId', 'e.matricule', DATE('e.hire_date').as('hireDate'), sql<string | null>`e.end_date::text`.as('endDate'), 'e.end_reason as endReason'])
      .where('e.company_id', '=', companyId)
      .where('e.person_id', '=', personId)
      .orderBy('e.hire_date', 'desc')
      .execute();
  }

  async findPerson(companyId: string, id: string): Promise<PersonRow | undefined> {
    const row = await currentTx()
      .selectFrom('person as p')
      .select([
        'p.id',
        'p.last_name as lastName',
        'p.first_name as firstName',
        'p.last_name_ar as lastNameAr',
        'p.first_name_ar as firstNameAr',
        sql<string | null>`p.birth_date::text`.as('birthDate'),
        'p.birth_place as birthPlace',
        'p.sex',
        'p.nationality',
        'p.nin',
      ])
      .where('p.company_id', '=', companyId)
      .where('p.id', '=', id)
      .executeTakeFirst();
    return row ? { ...row, sex: row.sex === 'M' || row.sex === 'F' ? row.sex : null } : undefined;
  }

  /** Oldest first. */
  listAssignments(companyId: string, employmentId: string): Promise<AssignmentRow[]> {
    return currentTx()
      .selectFrom('assignment as a')
      .select(['a.id', 'a.org_unit_id as orgUnitId', 'a.site_id as siteId', 'a.job_title as jobTitle', VALID_FROM('a').as('validFrom'), VALID_TO('a').as('validTo')])
      .where('a.company_id', '=', companyId)
      .where('a.employment_id', '=', employmentId)
      .orderBy(sql`lower(a.valid)`)
      .execute();
  }

  /** Oldest first. `base_salary` comes back from pg as a decimal string (numeric), never a float. */
  listSalaries(companyId: string, employmentId: string): Promise<SalaryRow[]> {
    return currentTx()
      .selectFrom('employment_salary as s')
      .select(['s.id', sql<string>`s.base_salary::text`.as('baseSalary'), 's.currency', VALID_FROM('s').as('validFrom'), VALID_TO('s').as('validTo')])
      .where('s.company_id', '=', companyId)
      .where('s.employment_id', '=', employmentId)
      .orderBy(sql`lower(s.valid)`)
      .execute();
  }

  async findSensitive(companyId: string, personId: string): Promise<SensitiveRow | undefined> {
    return currentTx()
      .selectFrom('person_sensitive')
      .select(['nss', 'rib', 'bank_name as bankName'])
      .where('company_id', '=', companyId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
  }

  /** Every version of every unit of the company (small: the org tree), with the unit's code and kind. */
  unitVersions(companyId: string): Promise<UnitVersionRow[]> {
    return currentTx()
      .selectFrom('org_unit as u')
      .innerJoin('org_unit_version as v', (join) => join.onRef('v.company_id', '=', 'u.company_id').onRef('v.org_unit_id', '=', 'u.id'))
      .select([
        'u.id as unitId',
        'u.code',
        'u.kind',
        'v.name',
        'v.name_ar as nameAr',
        'v.parent_id as parentId',
        'v.site_id as siteId',
        VALID_FROM('v').as('validFrom'),
        VALID_TO('v').as('validTo'),
      ])
      .where('u.company_id', '=', companyId)
      .execute();
  }

  async sitesByIds(companyId: string, ids: readonly string[]): Promise<{ id: string; code: string; name: string }[]> {
    if (ids.length === 0) return [];
    return currentTx().selectFrom('site').select(['id', 'code', 'name']).where('company_id', '=', companyId).where('id', 'in', ids).execute();
  }

  async unitExists(companyId: string, id: string): Promise<boolean> {
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row !== undefined;
  }

  async siteExists(companyId: string, id: string): Promise<boolean> {
    const row = await currentTx().selectFrom('site').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row !== undefined;
  }

  async matriculeTaken(companyId: string, matricule: string): Promise<boolean> {
    const row = await currentTx().selectFrom('employment').select('id').where('company_id', '=', companyId).where('matricule', '=', matricule).executeTakeFirst();
    return row !== undefined;
  }

  async ninTaken(companyId: string, nin: string, exceptPersonId?: string): Promise<boolean> {
    let query = currentTx().selectFrom('person').select('id').where('company_id', '=', companyId).where('nin', '=', nin);
    if (exceptPersonId) query = query.where('id', '<>', exceptPersonId);
    return (await query.executeTakeFirst()) !== undefined;
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────────────────────────────

  async insertPerson(companyId: string, person: Omit<PersonRow, 'id'>): Promise<string> {
    const row = await currentTx()
      .insertInto('person')
      .values({
        company_id: companyId,
        last_name: person.lastName,
        first_name: person.firstName,
        last_name_ar: person.lastNameAr,
        first_name_ar: person.firstNameAr,
        birth_date: person.birthDate,
        birth_place: person.birthPlace,
        sex: person.sex,
        nationality: person.nationality,
        nin: person.nin,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async updatePerson(companyId: string, id: string, patch: PersonPatch): Promise<void> {
    const set = {
      ...(patch.lastName !== undefined ? { last_name: patch.lastName } : {}),
      ...(patch.firstName !== undefined ? { first_name: patch.firstName } : {}),
      ...(patch.lastNameAr !== undefined ? { last_name_ar: patch.lastNameAr } : {}),
      ...(patch.firstNameAr !== undefined ? { first_name_ar: patch.firstNameAr } : {}),
      ...(patch.birthDate !== undefined ? { birth_date: patch.birthDate } : {}),
      ...(patch.birthPlace !== undefined ? { birth_place: patch.birthPlace } : {}),
      ...(patch.sex !== undefined ? { sex: patch.sex } : {}),
      ...(patch.nationality !== undefined ? { nationality: patch.nationality } : {}),
      ...(patch.nin !== undefined ? { nin: patch.nin } : {}),
    };
    if (Object.keys(set).length === 0) return;
    await currentTx().updateTable('person').set(set).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async insertEmployment(companyId: string, e: { personId: string; matricule: string; hireDate: string }): Promise<string> {
    const row = await currentTx()
      .insertInto('employment')
      .values({ company_id: companyId, person_id: e.personId, matricule: e.matricule, hire_date: e.hireDate })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async endEmployment(companyId: string, id: string, endDate: string, reason: string): Promise<void> {
    await currentTx().updateTable('employment').set({ end_date: endDate, end_reason: reason }).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async insertAssignment(
    companyId: string,
    employmentId: string,
    a: { orgUnitId: string; siteId: string | null; jobTitle: string; validFrom: string },
  ): Promise<void> {
    await currentTx()
      .insertInto('assignment')
      .values({
        company_id: companyId,
        employment_id: employmentId,
        org_unit_id: a.orgUnitId,
        site_id: a.siteId,
        job_title: a.jobTitle,
        valid: sql<string>`daterange(${a.validFrom}::date, null, '[)')`,
      })
      .execute();
  }

  /** Sets the exclusive end of an assignment. */
  async closeAssignment(companyId: string, id: string, validTo: string): Promise<void> {
    await currentTx()
      .updateTable('assignment')
      .set({ valid: sql<string>`daterange(lower(valid), ${validTo}::date, '[)')` })
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .execute();
  }

  async insertSalary(companyId: string, employmentId: string, s: { baseSalary: string; validFrom: string }): Promise<void> {
    await currentTx()
      .insertInto('employment_salary')
      .values({
        company_id: companyId,
        employment_id: employmentId,
        base_salary: s.baseSalary,
        currency: 'DZD',
        valid: sql<string>`daterange(${s.validFrom}::date, null, '[)')`,
      })
      .execute();
  }

  async closeSalary(companyId: string, id: string, validTo: string): Promise<void> {
    await currentTx()
      .updateTable('employment_salary')
      .set({ valid: sql<string>`daterange(lower(valid), ${validTo}::date, '[)')` })
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .execute();
  }

  /** Creates or updates the person's sensitive row; only the given fields change. */
  async upsertSensitive(companyId: string, personId: string, patch: Partial<SensitiveRow>): Promise<void> {
    const values = {
      ...(patch.nss !== undefined ? { nss: patch.nss } : {}),
      ...(patch.rib !== undefined ? { rib: patch.rib } : {}),
      ...(patch.bankName !== undefined ? { bank_name: patch.bankName } : {}),
    };
    await currentTx()
      .insertInto('person_sensitive')
      .values({ company_id: companyId, person_id: personId, ...values })
      .onConflict((oc) => oc.column('person_id').doUpdateSet({ ...values, updated_at: sql<Date>`now()` }))
      .execute();
  }
}
