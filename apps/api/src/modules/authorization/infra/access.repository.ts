import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import type { LinkedEmploymentView } from '../application/access-views.js';
import type { Names } from '../domain/catalogue.js';

export interface PermissionRow {
  code: string;
  group: string;
  sensitive: boolean;
  labels: Names;
  sortOrder: number;
}

export interface RoleRow {
  id: string;
  code: string;
  names: Names;
  isSystem: boolean;
  permissions: string[];
}

export interface MemberRow {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  status: string;
}

export interface GrantRow {
  id: string;
  userId: string;
  role: { id: string; code: string; names: Names };
  unit: { id: string; code: string; name: string; kind: string };
  includeDescendants: boolean;
  validFrom: string;
  validTo: string | null;
  grantedBy: string | null;
  grantedAt: string;
}

export interface GrantFilter {
  ids?: readonly string[];
  userId?: string;
  unitId?: string;
  /** false: only current and future grants (validTo null or after `today`). */
  includeEnded: boolean;
  today: string;
  /** Only grants whose unit is in this scope (the caller's access.read scope). */
  unitScope?: UnitIdQuery;
}

/** Postgres error raised by a constraint (pg's DatabaseError fields). */
export function constraintViolation(error: unknown): { code: string; constraint: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return typeof code === 'string' && typeof constraint === 'string' ? { code, constraint } : undefined;
}

const ISO_TIMESTAMP = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Permissions, roles, grants and company members — always through the request transaction and always filtered by
 * the caller's company (RLS on app.company_id is the backstop).
 */
@Injectable()
export class AccessRepository {
  async permissions(): Promise<PermissionRow[]> {
    const rows = await currentTx()
      .selectFrom('permission')
      .select(['code', 'group_code', 'sensitive', 'label_fr', 'label_ar', 'label_en', 'sort_order'])
      .orderBy('sort_order')
      .execute();
    return rows.map((r) => ({
      code: r.code,
      group: r.group_code,
      sensitive: r.sensitive,
      labels: { fr: r.label_fr, ar: r.label_ar, en: r.label_en },
      sortOrder: r.sort_order,
    }));
  }

  async roles(companyId: string, ids?: readonly string[]): Promise<RoleRow[]> {
    let query = currentTx()
      .selectFrom('role as r')
      .select([
        'r.id',
        'r.code',
        'r.name_fr',
        'r.name_ar',
        'r.name_en',
        'r.is_system',
        sql<string[]>`coalesce((select array_agg(rp.permission_code order by p.sort_order)
                                  from role_permission rp join permission p on p.code = rp.permission_code
                                 where rp.company_id = r.company_id and rp.role_id = r.id), '{}')`.as('permissions'),
      ])
      .where('r.company_id', '=', companyId);
    if (ids) {
      if (ids.length === 0) return [];
      query = query.where('r.id', 'in', ids);
    }
    const rows = await query.orderBy('r.is_system', 'desc').orderBy(sql`lower(r.code)`).execute();
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      names: { fr: r.name_fr, ar: r.name_ar, en: r.name_en },
      isSystem: r.is_system,
      permissions: r.permissions,
    }));
  }

  async roleCodeExists(companyId: string, code: string): Promise<boolean> {
    const row = await currentTx()
      .selectFrom('role')
      .select('id')
      .where('company_id', '=', companyId)
      .where(sql<boolean>`lower(code) = lower(${code})`)
      .executeTakeFirst();
    return row !== undefined;
  }

  async insertRole(companyId: string, role: { code: string; names: Names }): Promise<string> {
    const row = await currentTx()
      .insertInto('role')
      .values({ company_id: companyId, code: role.code, name_fr: role.names.fr, name_ar: role.names.ar, name_en: role.names.en })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async updateRoleNames(companyId: string, roleId: string, names: Names): Promise<void> {
    await currentTx()
      .updateTable('role')
      .set({ name_fr: names.fr, name_ar: names.ar, name_en: names.en })
      .where('company_id', '=', companyId)
      .where('id', '=', roleId)
      .execute();
  }

  /** Replaces the role's permission set. */
  async setRolePermissions(companyId: string, roleId: string, codes: readonly string[]): Promise<void> {
    const tx = currentTx();
    let remove = tx.deleteFrom('role_permission').where('company_id', '=', companyId).where('role_id', '=', roleId);
    if (codes.length > 0) remove = remove.where('permission_code', 'not in', codes);
    await remove.execute();
    if (codes.length === 0) return;
    await tx
      .insertInto('role_permission')
      .values(codes.map((code) => ({ company_id: companyId, role_id: roleId, permission_code: code })))
      .onConflict((oc) => oc.columns(['role_id', 'permission_code']).doNothing())
      .execute();
  }

  /** Linked employments of members (user id → employee), docs/contracts/leave.md › user_employment. */
  async linkedEmployments(companyId: string): Promise<Map<string, LinkedEmploymentView>> {
    const { rows } = await sql<{ user_id: string; id: string; matricule: string; last_name: string; first_name: string; last_name_ar: string | null; first_name_ar: string | null }>`
      select ue.user_id, e.id, e.matricule, p.last_name, p.first_name, p.last_name_ar, p.first_name_ar
        from user_employment ue
        join employment e on e.company_id = ue.company_id and e.id = ue.employment_id
        join person p on p.company_id = e.company_id and p.id = e.person_id
       where ue.company_id = ${companyId}::uuid`.execute(currentTx());
    return new Map(
      rows.map((r) => [
        r.user_id,
        { id: r.id, matricule: r.matricule, person: { lastName: r.last_name, firstName: r.first_name, lastNameAr: r.last_name_ar, firstNameAr: r.first_name_ar } },
      ]),
    );
  }

  /** Members of the caller's company (auth.company_members refuses any other company). */
  async members(companyId: string): Promise<MemberRow[]> {
    const { rows } = await sql<{ user_id: string; email: string; display_name: string; locale: string; status: string }>`
      select user_id, email, display_name, locale, status from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return rows.map((r) => ({ id: r.user_id, email: r.email, displayName: r.display_name, locale: r.locale, status: r.status }));
  }

  async grants(companyId: string, filter: GrantFilter): Promise<GrantRow[]> {
    let query = currentTx()
      .selectFrom('role_grant as g')
      .innerJoin('role as r', (join) => join.onRef('r.company_id', '=', 'g.company_id').onRef('r.id', '=', 'g.role_id'))
      .innerJoin('org_unit as u', (join) => join.onRef('u.company_id', '=', 'g.company_id').onRef('u.id', '=', 'g.org_unit_id'))
      .select([
        'g.id',
        'g.user_id',
        'g.role_id',
        'r.code as role_code',
        'r.name_fr',
        'r.name_ar',
        'r.name_en',
        'g.org_unit_id',
        'u.code as unit_code',
        'u.kind as unit_kind',
        // the unit's name today, else its latest version's
        sql<string>`(select v.name from org_unit_version v
                      where v.company_id = u.company_id and v.org_unit_id = u.id
                      order by (v.valid @> ${filter.today}::date) desc, lower(v.valid) desc limit 1)`.as('unit_name'),
        'g.include_descendants',
        sql<string>`g.valid_from::text`.as('valid_from'),
        sql<string | null>`g.valid_to::text`.as('valid_to'),
        'g.granted_by',
        ISO_TIMESTAMP('g.granted_at').as('granted_at'),
      ])
      .where('g.company_id', '=', companyId);
    if (filter.ids) {
      if (filter.ids.length === 0) return [];
      query = query.where('g.id', 'in', filter.ids);
    }
    if (filter.userId) query = query.where('g.user_id', '=', filter.userId);
    if (filter.unitId) query = query.where('g.org_unit_id', '=', filter.unitId);
    if (!filter.includeEnded) query = query.where(sql<boolean>`(g.valid_to is null or g.valid_to > ${filter.today}::date)`);
    if (filter.unitScope) query = query.where('g.org_unit_id', 'in', filter.unitScope);
    const rows = await query.orderBy('g.valid_from', 'desc').orderBy('r.code').orderBy('u.code').orderBy('g.id').execute();
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      role: { id: r.role_id, code: r.role_code, names: { fr: r.name_fr, ar: r.name_ar, en: r.name_en } },
      unit: { id: r.org_unit_id, code: r.unit_code, name: r.unit_name, kind: r.unit_kind },
      includeDescendants: r.include_descendants,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
    }));
  }

  async unitExists(companyId: string, unitId: string): Promise<boolean> {
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', companyId).where('id', '=', unitId).executeTakeFirst();
    return row !== undefined;
  }

  async insertGrant(
    companyId: string,
    grant: { userId: string; roleId: string; orgUnitId: string; includeDescendants: boolean; validFrom: string; validTo: string | null; grantedBy: string },
  ): Promise<string> {
    const row = await currentTx()
      .insertInto('role_grant')
      .values({
        company_id: companyId,
        user_id: grant.userId,
        role_id: grant.roleId,
        org_unit_id: grant.orgUnitId,
        include_descendants: grant.includeDescendants,
        valid_from: sql<string>`${grant.validFrom}::date`,
        valid_to: sql<string | null>`${grant.validTo}::date`,
        granted_by: grant.grantedBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async endGrant(companyId: string, grantId: string, validTo: string, endedBy: string): Promise<void> {
    await currentTx()
      .updateTable('role_grant')
      .set({ valid_to: sql<string>`${validTo}::date`, ended_by: endedBy, ended_at: sql<string>`now()` })
      .where('company_id', '=', companyId)
      .where('id', '=', grantId)
      .execute();
  }
}
