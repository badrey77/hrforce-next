import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { SYSTEM_ROLES, type SystemRole } from '../domain/catalogue.js';

/*
 * Seeding for `seed:dev` and the `user:invite` CLI. These run as the MIGRATOR (owner, BYPASSRLS) and therefore
 * write company_id explicitly.
 */

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * Idempotently creates the system roles of a company and syncs their permissions to {@link SYSTEM_ROLES} (a
 * system role's permissions are defined by code, not by the API). A custom role that already uses a system code is
 * left alone. With `onlyIfNone`, does nothing when the company already has a system role (user:invite).
 * Returns true when it created at least one role.
 */
export async function seedSystemRoles(
  db: Executor,
  companyId: string,
  options: { onlyIfNone?: boolean; roles?: readonly SystemRole[] } = {},
): Promise<boolean> {
  if (options.onlyIfNone) {
    const existing = await db.selectFrom('role').select('id').where('company_id', '=', companyId).where('is_system', '=', true).executeTakeFirst();
    if (existing) return false;
  }
  let created = false;
  for (const role of options.roles ?? SYSTEM_ROLES) {
    const inserted = await sql<{ id: string }>`
      insert into role (company_id, code, name_fr, name_ar, name_en, is_system)
      values (${companyId}::uuid, ${role.code}, ${role.names.fr}, ${role.names.ar}, ${role.names.en}, true)
      on conflict (company_id, lower(code)) do nothing
      returning id`.execute(db);
    if (inserted.rows.length > 0) created = true;
    const row = await db
      .selectFrom('role')
      .select('id')
      .where('company_id', '=', companyId)
      .where('code', '=', role.code)
      .where('is_system', '=', true)
      .executeTakeFirst();
    if (!row) continue;
    const codes = [...role.permissions];
    await db.deleteFrom('role_permission').where('company_id', '=', companyId).where('role_id', '=', row.id).where('permission_code', 'not in', codes).execute();
    await db
      .insertInto('role_permission')
      .values(codes.map((code) => ({ company_id: companyId, role_id: row.id, permission_code: code })))
      .onConflict((oc) => oc.columns(['role_id', 'permission_code']).doNothing())
      .execute();
  }
  return created;
}

export interface SeedGrant {
  /** Fixed id (idempotency). */
  id: string;
  userId: string;
  roleCode: string;
  orgUnitId: string;
  includeDescendants: boolean;
  validFrom: string;
  validTo?: string | null;
}

/** Idempotently inserts grants (same id, or an overlapping identical grant, → left untouched). */
export async function seedGrants(db: Executor, companyId: string, grants: readonly SeedGrant[]): Promise<void> {
  for (const grant of grants) {
    const role = await db.selectFrom('role').select('id').where('company_id', '=', companyId).where('code', '=', grant.roleCode).executeTakeFirst();
    if (!role) throw new Error(`seed: unknown role ${grant.roleCode} (seed the system roles first)`);
    await sql`
      insert into role_grant (id, company_id, user_id, role_id, org_unit_id, include_descendants, valid_from, valid_to)
      values (${grant.id}::uuid, ${companyId}::uuid, ${grant.userId}::uuid, ${role.id}::uuid, ${grant.orgUnitId}::uuid,
              ${grant.includeDescendants}, ${grant.validFrom}::date, ${grant.validTo ?? null}::date)
      on conflict do nothing`.execute(db);
  }
}
