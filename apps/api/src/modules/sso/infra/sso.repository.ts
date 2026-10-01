import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { ClientAuthMethod } from '../domain/rules.js';

export interface ClientRow {
  id: string;
  clientId: string;
  name: string;
  nameAr: string | null;
  status: 'active' | 'disabled';
  credentialSetAt: Date;
  clientAuthMethod: ClientAuthMethod;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  createdBy: string | null;
  createdAt: Date;
  disabledAt: Date | null;
  disabledReason: string | null;
}

export interface RoleRow {
  id: string;
  clientRowId: string;
  code: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  assignmentCount: number;
}

export interface AssignmentRow {
  id: string;
  userId: string;
  clientRowId: string;
  clientId: string;
  clientName: string;
  clientNameAr: string | null;
  roleId: string;
  roleCode: string;
  roleNameFr: string;
  roleNameAr: string;
  roleNameEn: string;
  assignedBy: string | null;
  assignedAt: Date;
}

export interface MemberRow {
  id: string;
  email: string;
  displayName: string;
}

const CLIENT_COLUMNS = sql`
  c.id, c.client_id as "clientId", c.name, c.name_ar as "nameAr", c.status, c.credential_set_at as "credentialSetAt",
  c.client_auth_method as "clientAuthMethod", c.redirect_uris as "redirectUris", c.post_logout_redirect_uris as "postLogoutRedirectUris",
  c.created_by as "createdBy", c.created_at as "createdAt", c.disabled_at as "disabledAt", c.disabled_reason as "disabledReason"`;

const ROLE_COLUMNS = sql`
  r.id, r.sso_client_id as "clientRowId", r.code, r.name_fr as "nameFr", r.name_ar as "nameAr", r.name_en as "nameEn",
  (select count(*)::int from sso_role_assignment x where x.company_id = r.company_id and x.sso_app_role_id = r.id) as "assignmentCount"`;

/** A unique violation of `constraint` (Postgres 23505). */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && e.constraint === constraint;
}

export function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string } | null;
  return e?.code === '23503' && e.constraint === constraint;
}

/**
 * The SSO tenant tables (sso_client, sso_app_role, sso_role_assignment) — through the CURRENT transaction (a request's,
 * or the claims transaction bound to the client's company), always filtered by company too.
 */
@Injectable()
export class SsoRepository {
  async members(companyId: string): Promise<MemberRow[]> {
    const { rows } = await sql<{ user_id: string; email: string; display_name: string }>`
      select user_id, email, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return rows.map((r) => ({ id: r.user_id, email: r.email, displayName: r.display_name }));
  }

  async clients(companyId: string): Promise<ClientRow[]> {
    const { rows } = await sql<ClientRow>`select ${CLIENT_COLUMNS} from sso_client c where c.company_id = ${companyId}::uuid order by c.name, c.client_id`.execute(
      currentTx(),
    );
    return rows;
  }

  async client(companyId: string, id: string, { lock = false } = {}): Promise<ClientRow | undefined> {
    const { rows } = await sql<ClientRow>`
      select ${CLIENT_COLUMNS} from sso_client c where c.company_id = ${companyId}::uuid and c.id = ${id}::uuid
      ${lock ? sql`for update` : sql``}`.execute(currentTx());
    return rows[0];
  }

  async insertClient(
    companyId: string,
    input: { clientId: string; name: string; nameAr: string | null; secretEnc: Buffer; clientAuthMethod: ClientAuthMethod; redirectUris: string[]; postLogoutRedirectUris: string[]; createdBy: string | null },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into sso_client (company_id, client_id, name, name_ar, secret_enc, client_auth_method, redirect_uris, post_logout_redirect_uris, created_by)
      values (${companyId}::uuid, ${input.clientId}, ${input.name}, ${input.nameAr}, ${input.secretEnc}, ${input.clientAuthMethod},
              ${input.redirectUris}::text[], ${input.postLogoutRedirectUris}::text[], ${input.createdBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('sso_client insert returned no id');
    return id;
  }

  async updateClient(
    companyId: string,
    id: string,
    patch: { name?: string; nameAr?: string | null; redirectUris?: string[]; postLogoutRedirectUris?: string[]; clientAuthMethod?: ClientAuthMethod },
  ): Promise<void> {
    const sets = [
      ...(patch.name !== undefined ? [sql`name = ${patch.name}`] : []),
      ...(patch.nameAr !== undefined ? [sql`name_ar = ${patch.nameAr}`] : []),
      ...(patch.redirectUris !== undefined ? [sql`redirect_uris = ${patch.redirectUris}::text[]`] : []),
      ...(patch.postLogoutRedirectUris !== undefined ? [sql`post_logout_redirect_uris = ${patch.postLogoutRedirectUris}::text[]`] : []),
      ...(patch.clientAuthMethod !== undefined ? [sql`client_auth_method = ${patch.clientAuthMethod}`] : []),
    ];
    if (sets.length === 0) return;
    await sql`update sso_client set ${sql.join(sets)} where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async setSecret(companyId: string, id: string, secretEnc: Buffer): Promise<void> {
    await sql`update sso_client set secret_enc = ${secretEnc}, credential_set_at = now() where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async disable(companyId: string, id: string, by: string, reason: string): Promise<void> {
    await sql`update sso_client set status = 'disabled', disabled_at = now(), disabled_by = ${by}::uuid, disabled_reason = ${reason}
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async enable(companyId: string, id: string): Promise<void> {
    await sql`update sso_client set status = 'active', disabled_at = null, disabled_by = null, disabled_reason = null
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** Number of users holding at least one role of each app. */
  async userCounts(companyId: string): Promise<Map<string, number>> {
    const { rows } = await sql<{ clientRowId: string; users: number }>`
      select r.sso_client_id as "clientRowId", count(distinct a.user_id)::int as users
        from sso_role_assignment a
        join sso_app_role r on r.company_id = a.company_id and r.id = a.sso_app_role_id
       where a.company_id = ${companyId}::uuid
       group by r.sso_client_id`.execute(currentTx());
    return new Map(rows.map((r) => [r.clientRowId, r.users]));
  }

  async roles(companyId: string, clientRowId?: string): Promise<RoleRow[]> {
    const { rows } = await sql<RoleRow>`
      select ${ROLE_COLUMNS} from sso_app_role r
       where r.company_id = ${companyId}::uuid ${clientRowId ? sql`and r.sso_client_id = ${clientRowId}::uuid` : sql``}
       order by r.code`.execute(currentTx());
    return rows;
  }

  async role(companyId: string, id: string): Promise<RoleRow | undefined> {
    const { rows } = await sql<RoleRow>`select ${ROLE_COLUMNS} from sso_app_role r where r.company_id = ${companyId}::uuid and r.id = ${id}::uuid`.execute(
      currentTx(),
    );
    return rows[0];
  }

  async insertRole(companyId: string, clientRowId: string, input: { code: string; nameFr: string; nameAr: string; nameEn: string }): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into sso_app_role (company_id, sso_client_id, code, name_fr, name_ar, name_en)
      values (${companyId}::uuid, ${clientRowId}::uuid, ${input.code}, ${input.nameFr}, ${input.nameAr}, ${input.nameEn})
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('sso_app_role insert returned no id');
    return id;
  }

  async updateRoleNames(companyId: string, id: string, names: { nameFr: string; nameAr: string; nameEn: string }): Promise<void> {
    await sql`update sso_app_role set name_fr = ${names.nameFr}, name_ar = ${names.nameAr}, name_en = ${names.nameEn}
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async deleteRole(companyId: string, id: string): Promise<void> {
    await sql`delete from sso_app_role where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async assignments(companyId: string, filters: { clientRowId?: string; userId?: string; roleId?: string; id?: string }): Promise<AssignmentRow[]> {
    const where = [
      sql`a.company_id = ${companyId}::uuid`,
      ...(filters.clientRowId ? [sql`r.sso_client_id = ${filters.clientRowId}::uuid`] : []),
      ...(filters.userId ? [sql`a.user_id = ${filters.userId}::uuid`] : []),
      ...(filters.roleId ? [sql`a.sso_app_role_id = ${filters.roleId}::uuid`] : []),
      ...(filters.id ? [sql`a.id = ${filters.id}::uuid`] : []),
    ];
    const { rows } = await sql<AssignmentRow>`
      select a.id, a.user_id as "userId", c.id as "clientRowId", c.client_id as "clientId", c.name as "clientName", c.name_ar as "clientNameAr",
             r.id as "roleId", r.code as "roleCode", r.name_fr as "roleNameFr", r.name_ar as "roleNameAr", r.name_en as "roleNameEn",
             a.assigned_by as "assignedBy", a.assigned_at as "assignedAt"
        from sso_role_assignment a
        join sso_app_role r on r.company_id = a.company_id and r.id = a.sso_app_role_id
        join sso_client c on c.company_id = r.company_id and c.id = r.sso_client_id
       where ${sql.join(where, sql` and `)}
       order by c.name, r.code, a.user_id
       limit 5000`.execute(currentTx());
    return rows;
  }

  async insertAssignment(companyId: string, roleId: string, userId: string, assignedBy: string | null): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into sso_role_assignment (company_id, sso_app_role_id, user_id, assigned_by)
      values (${companyId}::uuid, ${roleId}::uuid, ${userId}::uuid, ${assignedBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('sso_role_assignment insert returned no id');
    return id;
  }

  async deleteAssignment(companyId: string, id: string): Promise<void> {
    await sql`delete from sso_role_assignment where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** The `roles` claim: codes of the user's roles in ONE app, sorted. */
  async roleCodesOf(companyId: string, clientId: string, userId: string): Promise<string[]> {
    const { rows } = await sql<{ code: string }>`
      select r.code
        from sso_role_assignment a
        join sso_app_role r on r.company_id = a.company_id and r.id = a.sso_app_role_id
        join sso_client c on c.company_id = r.company_id and c.id = r.sso_client_id
       where a.company_id = ${companyId}::uuid and c.client_id = ${clientId} and a.user_id = ${userId}::uuid
       order by r.code`.execute(currentTx());
    return rows.map((r) => r.code);
  }
}
