import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { OrgUnitKind } from '../domain/org-unit.js';
import type { OrgSnapshotUnit } from '../domain/tree.js';
import type { OrgUnitVersionData } from '../domain/versions.js';
import { insertLeaf, moveSubtree, rebuildClosure } from './closure.js';

export interface OrgUnitRow {
  id: string;
  kind: OrgUnitKind;
  code: string;
  createdAt: string;
}

export interface OrgUnitVersionRow extends OrgUnitVersionData {
  id: string;
}

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

const VALID_FROM = sql<string>`lower(v.valid)::text`;
const VALID_TO = sql<string | null>`upper(v.valid)::text`;

/**
 * Org units, their versions and the closure — always through the request transaction (`currentTx()`), and
 * always filtered by the caller's company as well (RLS on app.company_id is the backstop, not the filter).
 */
@Injectable()
export class OrgUnitRepository {
  async findUnit(companyId: string, id: string): Promise<OrgUnitRow | undefined> {
    const row = await currentTx()
      .selectFrom('org_unit')
      .select(['id', 'kind', 'code', sql<string>`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.as('createdAt')])
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? { ...row, kind: row.kind as OrgUnitKind } : undefined;
  }

  async codeExists(companyId: string, code: string): Promise<boolean> {
    const row = await currentTx()
      .selectFrom('org_unit')
      .select('id')
      .where('company_id', '=', companyId)
      .where('code', '=', code)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Oldest first. */
  async listVersions(companyId: string, unitId: string): Promise<OrgUnitVersionRow[]> {
    const rows = await currentTx()
      .selectFrom('org_unit_version as v')
      .select(['v.id', 'v.name', 'v.parent_id as parentId', VALID_FROM.as('validFrom'), VALID_TO.as('validTo')])
      .where('v.company_id', '=', companyId)
      .where('v.org_unit_id', '=', unitId)
      .orderBy(sql`lower(v.valid)`)
      .execute();
    return rows;
  }

  /** Every unit that has a version valid on `asOf`, with that version's name and parent. */
  async snapshot(companyId: string, asOf: string): Promise<OrgSnapshotUnit[]> {
    const rows = await currentTx()
      .selectFrom('org_unit as u')
      .innerJoin('org_unit_version as v', (join) =>
        join.onRef('v.company_id', '=', 'u.company_id').onRef('v.org_unit_id', '=', 'u.id'),
      )
      .select(['u.id', 'u.kind', 'u.code', 'v.name', 'v.parent_id as parentId'])
      .where('u.company_id', '=', companyId)
      .where(sql<boolean>`v.valid @> ${asOf}::date`)
      .execute();
    return rows.map((r) => ({ ...r, kind: r.kind as OrgUnitKind }));
  }

  /**
   * Units valid on `asOf` whose code or name contains `q`, ignoring case and accents (search_normalize(), see
   * migration 0005: lower() + translate() of accented Latin letters, backing the generated `name_search` column).
   */
  async search(companyId: string, params: { asOf: string; q?: string; kind?: OrgUnitKind; limit: number }): Promise<string[]> {
    let query = currentTx()
      .selectFrom('org_unit as u')
      .innerJoin('org_unit_version as v', (join) =>
        join.onRef('v.company_id', '=', 'u.company_id').onRef('v.org_unit_id', '=', 'u.id'),
      )
      .select('u.id')
      .where('u.company_id', '=', companyId)
      .where(sql<boolean>`v.valid @> ${params.asOf}::date`);
    if (params.kind) query = query.where('u.kind', '=', params.kind);
    if (params.q) {
      const pattern = likeContains(params.q);
      query = query.where(
        sql<boolean>`(v.name_search like search_normalize(${pattern}) or search_normalize(u.code) like search_normalize(${pattern}))`,
      );
    }
    const rows = await query.orderBy('u.code').limit(params.limit).execute();
    return rows.map((r) => r.id);
  }

  async insertUnit(companyId: string, unit: { kind: OrgUnitKind; code: string }): Promise<string> {
    const row = await currentTx()
      .insertInto('org_unit')
      .values({ company_id: companyId, kind: unit.kind, code: unit.code })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async insertVersion(companyId: string, unitId: string, version: OrgUnitVersionData): Promise<void> {
    await currentTx()
      .insertInto('org_unit_version')
      .values({
        company_id: companyId,
        org_unit_id: unitId,
        name: version.name,
        parent_id: version.parentId,
        valid: sql<string>`daterange(${version.validFrom}::date, ${version.validTo}::date, '[)')`,
      })
      .execute();
  }

  /** Ends a version at `validTo` (exclusive). */
  async closeVersion(companyId: string, versionId: string, validTo: string): Promise<void> {
    await currentTx()
      .updateTable('org_unit_version')
      .set({ valid: sql<string>`daterange(lower(valid), ${validTo}::date, '[)')` })
      .where('company_id', '=', companyId)
      .where('id', '=', versionId)
      .execute();
  }

  insertClosureLeaf(companyId: string, unitId: string, parentId: string | null): Promise<void> {
    return insertLeaf(currentTx(), companyId, unitId, parentId);
  }

  moveClosureSubtree(companyId: string, unitId: string, newParentId: string): Promise<void> {
    return moveSubtree(currentTx(), companyId, unitId, newParentId);
  }

  rebuildClosure(companyId: string, asOf: string): Promise<void> {
    return rebuildClosure(currentTx(), companyId, asOf);
  }
}
