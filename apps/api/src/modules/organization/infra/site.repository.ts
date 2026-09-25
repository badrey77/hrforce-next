import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';

export interface SiteRow {
  id: string;
  code: string;
  name: string;
  wilaya: string;
  address: string | null;
}

/** `%`, `_` and `\` are LIKE wildcards/escape: match them literally. */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Sites of the caller's company — through the request transaction, filtered by company (RLS is the backstop). */
@Injectable()
export class SiteRepository {
  /**
   * Sites whose code, name or wilaya contains `q` (case/accent-insensitive via search_normalize(), migration 0005),
   * ordered by code.
   */
  async list(companyId: string, params: { q?: string; limit: number }): Promise<SiteRow[]> {
    let query = currentTx()
      .selectFrom('site')
      .select(['id', 'code', 'name', 'wilaya', 'address'])
      .where('company_id', '=', companyId);
    if (params.q) {
      const pattern = likeContains(params.q);
      query = query.where(
        sql<boolean>`(search_normalize(code) like search_normalize(${pattern})
                   or search_normalize(name) like search_normalize(${pattern})
                   or search_normalize(wilaya) like search_normalize(${pattern}))`,
      );
    }
    return query.orderBy('code').limit(params.limit).execute();
  }

  async findByIds(companyId: string, ids: readonly string[]): Promise<SiteRow[]> {
    if (ids.length === 0) return [];
    return currentTx()
      .selectFrom('site')
      .select(['id', 'code', 'name', 'wilaya', 'address'])
      .where('company_id', '=', companyId)
      .where('id', 'in', ids)
      .execute();
  }

  async codeExists(companyId: string, code: string): Promise<boolean> {
    const row = await currentTx().selectFrom('site').select('id').where('company_id', '=', companyId).where('code', '=', code).executeTakeFirst();
    return row !== undefined;
  }

  async insert(companyId: string, site: Omit<SiteRow, 'id'>): Promise<SiteRow> {
    return currentTx()
      .insertInto('site')
      .values({ company_id: companyId, ...site })
      .returning(['id', 'code', 'name', 'wilaya', 'address'])
      .executeTakeFirstOrThrow();
  }
}
