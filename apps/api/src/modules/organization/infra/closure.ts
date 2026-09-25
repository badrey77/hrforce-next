import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * org_unit_closure maintenance. The closure reflects the tree AS OF TODAY (docs/contracts/organization.md):
 * callers only apply these when a structural change takes effect on or before today.
 */

/** A new unit (leaf): its self row plus one row per ancestor of `parentId` (the parent's own closure rows). */
export async function insertLeaf(db: Executor, companyId: string, unitId: string, parentId: string | null): Promise<void> {
  await db
    .insertInto('org_unit_closure')
    .values({ company_id: companyId, ancestor_id: unitId, descendant_id: unitId, depth: 0 })
    .execute();
  if (!parentId) return;
  await sql`
    insert into org_unit_closure (company_id, ancestor_id, descendant_id, depth)
    select company_id, ancestor_id, ${unitId}::uuid, depth + 1
      from org_unit_closure
     where company_id = ${companyId}::uuid and descendant_id = ${parentId}::uuid`.execute(db);
}

/**
 * Moves the subtree rooted at `unitId` under `newParentId`: drops every (outside ancestor → subtree member) row,
 * then links each ancestor of the new parent (self included) to each subtree member. Rows inside the subtree
 * are untouched (their relative depths do not change).
 */
export async function moveSubtree(db: Executor, companyId: string, unitId: string, newParentId: string): Promise<void> {
  await sql`
    delete from org_unit_closure c
     using org_unit_closure sub
     where sub.company_id = ${companyId}::uuid
       and sub.ancestor_id = ${unitId}::uuid
       and c.company_id = ${companyId}::uuid
       and c.descendant_id = sub.descendant_id
       and c.ancestor_id not in (
         select descendant_id from org_unit_closure where company_id = ${companyId}::uuid and ancestor_id = ${unitId}::uuid
       )`.execute(db);
  await sql`
    insert into org_unit_closure (company_id, ancestor_id, descendant_id, depth)
    select ${companyId}::uuid, sup.ancestor_id, sub.descendant_id, sup.depth + sub.depth + 1
      from org_unit_closure sup
      join org_unit_closure sub on sub.company_id = sup.company_id
     where sup.company_id = ${companyId}::uuid
       and sup.descendant_id = ${newParentId}::uuid
       and sub.ancestor_id = ${unitId}::uuid`.execute(db);
}

/**
 * Recomputes a company's whole closure from the versions valid on `asOf` (normally today). Used by the seed and
 * for a daily refresh once future-dated changes take effect (a scheduled job lands with the worker).
 */
export async function rebuildClosure(db: Executor, companyId: string, asOf: string): Promise<void> {
  await db.deleteFrom('org_unit_closure').where('company_id', '=', companyId).execute();
  await sql`
    insert into org_unit_closure (company_id, ancestor_id, descendant_id, depth)
    with recursive current_parent as (
      select org_unit_id as id, parent_id
        from org_unit_version
       where company_id = ${companyId}::uuid and valid @> ${asOf}::date
    ), walk (ancestor_id, descendant_id, depth) as (
      select id, id, 0 from current_parent
      union all
      select cp.parent_id, w.descendant_id, w.depth + 1
        from walk w
        join current_parent cp on cp.id = w.ancestor_id
       where cp.parent_id is not null and w.depth < 64
    )
    select ${companyId}::uuid, ancestor_id, descendant_id, depth
      from walk
     where ancestor_id in (select id from current_parent)`.execute(db);
}
