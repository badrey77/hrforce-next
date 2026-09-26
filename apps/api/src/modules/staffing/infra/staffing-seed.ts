import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';

/*
 * Seeding helpers for `seed:dev` and the e2e fixtures. They run as the MIGRATOR (owner, BYPASSRLS) and therefore
 * write company_id explicitly. Idempotent: fixed ids, `on conflict do nothing`.
 */

type Executor = Kysely<DB> | Transaction<DB>;

export interface SeedLink {
  id: string;
  userId: string;
  employmentId: string;
}

export interface SeedHead {
  id: string;
  orgUnitId: string;
  employmentId: string;
  validFrom: string;
  /** exclusive end (null = open) */
  validTo: string | null;
}

export async function seedLinks(db: Executor, companyId: string, links: readonly SeedLink[]): Promise<void> {
  for (const link of links) {
    await sql`
      insert into user_employment (id, company_id, user_id, employment_id)
      values (${link.id}::uuid, ${companyId}::uuid, ${link.userId}::uuid, ${link.employmentId}::uuid)
      on conflict do nothing`.execute(db);
  }
}

export async function seedHeads(db: Executor, companyId: string, heads: readonly SeedHead[]): Promise<void> {
  for (const head of heads) {
    await sql`
      insert into org_unit_head (id, company_id, org_unit_id, employment_id, valid)
      values (${head.id}::uuid, ${companyId}::uuid, ${head.orgUnitId}::uuid, ${head.employmentId}::uuid,
              daterange(${head.validFrom}::date, ${head.validTo}::date, '[)'))
      on conflict do nothing`.execute(db);
  }
}
