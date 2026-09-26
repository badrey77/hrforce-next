import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import type { TimelineCursor, TimelineSubject } from '../domain/timeline.js';

/** One merged timeline row: a change_log row (kind 0) or an event (kind 1). */
export interface TimelineRow {
  kind: 0 | 1;
  id: string;
  /** ISO-8601 UTC, microseconds (cursor) */
  atMicros: string;
  at: Date;
  actorUserId: string | null;
  requestId: string | null;
  tableName: string | null;
  op: 'insert' | 'update' | 'delete' | null;
  before: unknown;
  after: unknown;
  changed: string[] | null;
  type: string | null;
  data: Record<string, unknown> | null;
}

export interface MemberName {
  id: string;
  displayName: string;
}

const AT_MICROS = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Reads of the audit trail — through the request transaction (hrforce_app: SELECT on the parents, RLS on
 * app.company_id), always filtered by the caller's company too.
 */
@Injectable()
export class AuditRepository {
  async orgUnitExists(companyId: string, id: string): Promise<boolean> {
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row !== undefined;
  }

  /** The row exists in `table`, or has audit history there (e.g. deleted by an operator). */
  async rowKnown(companyId: string, table: 'site' | 'role', id: string): Promise<boolean> {
    const tx = currentTx();
    const live = table === 'site'
      ? await tx.selectFrom('site').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst()
      : await tx.selectFrom('role').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    if (live) return true;
    const logged = await tx
      .selectFrom('audit.change_log')
      .select('id')
      .where('company_id', '=', companyId)
      .where('table_name', '=', table)
      .where('row_id', '=', id)
      .limit(1)
      .executeTakeFirst();
    return logged !== undefined;
  }

  /** Members of the caller's company (auth.company_members refuses any other company). */
  async members(companyId: string): Promise<MemberName[]> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return rows.map((r) => ({ id: r.user_id, displayName: r.display_name }));
  }

  /** Units of every grant of the user (current, future and ended). */
  async grantUnitsOf(companyId: string, userId: string): Promise<string[]> {
    const rows = await currentTx()
      .selectFrom('role_grant')
      .select('org_unit_id')
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .execute();
    return rows.map((r) => r.org_unit_id);
  }

  /** Columns currently masked, per table. */
  async maskedColumns(): Promise<Map<string, Set<string>>> {
    const rows = await currentTx().selectFrom('audit.masked_column').select(['table_name', 'column_name']).execute();
    const out = new Map<string, Set<string>>();
    for (const r of rows) out.set(r.table_name, (out.get(r.table_name) ?? new Set<string>()).add(r.column_name));
    return out;
  }

  /**
   * Newest first, (at, kind, id) descending, strictly after `cursor`. `unitScope` = the caller's audit.read scope
   * (grants of a user are listed only when their unit is in it).
   */
  async timeline(
    companyId: string,
    subject: TimelineSubject,
    options: { cursor: TimelineCursor | null; limit: number; unitScope: UnitIdQuery },
  ): Promise<TimelineRow[]> {
    const changes = this.changeFilter(companyId, subject, options.unitScope);
    const after = options.cursor
      ? sql`(x.at, x.kind, x.id) < (${options.cursor.at}::timestamptz, ${options.cursor.kind}::int, ${options.cursor.id}::bigint)`
      : sql`true`;
    const { rows } = await sql<{
      kind: number;
      id: string;
      at_micros: string;
      at: Date;
      actor_user_id: string | null;
      request_id: string | null;
      table_name: string | null;
      op: 'insert' | 'update' | 'delete' | null;
      before: unknown;
      after: unknown;
      changed: string[] | null;
      type: string | null;
      data: Record<string, unknown> | null;
    }>`
      select x.* from (
        select 0 as kind, c.id, c.at, ${AT_MICROS('c.at')} as at_micros, c.actor_user_id, c.request_id,
               c.table_name, c.op, c.before, c.after, c.changed, null::text as type, null::jsonb as data
          from audit.change_log c
         where c.company_id = ${companyId}::uuid and (${changes})
        union all
        select 1 as kind, e.id, e.at, ${AT_MICROS('e.at')} as at_micros, e.actor_user_id, e.request_id,
               null, null, null, null, null, e.type, e.data
          from audit.event e
         where e.company_id = ${companyId}::uuid and e.subject_type = ${subject.type} and e.subject_id = ${subject.id}::uuid
           and (${this.eventFilter(options.unitScope)})
      ) x
      where ${after}
      order by x.at desc, x.kind desc, x.id desc
      limit ${options.limit}`.execute(currentTx());
    return rows.map((r) => ({
      kind: r.kind === 1 ? 1 : 0,
      id: String(r.id),
      atMicros: r.at_micros,
      at: r.at,
      actorUserId: r.actor_user_id,
      requestId: r.request_id,
      tableName: r.table_name,
      op: r.op,
      before: r.before,
      after: r.after,
      changed: r.changed,
      type: r.type,
      data: r.data,
    }));
  }

  /**
   * Events about a unit (`data.unitId`, e.g. access.grant_created / grant_ended) are listed only when that unit is in
   * the caller's audit.read scope, like the role_grant rows they accompany (alias `e`).
   */
  private eventFilter(unitScope: UnitIdQuery): RawBuilder<boolean> {
    return sql<boolean>`e.data ->> 'unitId' is null or (e.data ->> 'unitId')::uuid in (${unitScope})`;
  }

  /** Which change_log rows belong to the subject (alias `c`). */
  private changeFilter(companyId: string, subject: TimelineSubject, unitScope: UnitIdQuery): RawBuilder<boolean> {
    const id = subject.id;
    switch (subject.type) {
      case 'org_unit':
        // the unit and its versions (live ones, plus any recorded by an insert — e.g. a version deleted by hand)
        return sql<boolean>`(c.table_name = 'org_unit' and c.row_id = ${id}::uuid)
          or (c.table_name = 'org_unit_version' and c.row_id in (
                select v.id from org_unit_version v where v.company_id = ${companyId}::uuid and v.org_unit_id = ${id}::uuid
                union
                select i.row_id from audit.change_log i
                 where i.company_id = ${companyId}::uuid and i.table_name = 'org_unit_version' and i.op = 'insert'
                   and i.after ->> 'org_unit_id' = ${id}::text))`;
      case 'site':
        return sql<boolean>`c.table_name = 'site' and c.row_id = ${id}::uuid`;
      case 'role':
        // role_permission rows are keyed on their role (audit.capture('role_id'))
        return sql<boolean>`c.table_name in ('role', 'role_permission') and c.row_id = ${id}::uuid`;
      case 'user':
        // the user's grants whose unit is in the caller's audit.read scope (grants are never deleted by the app; an
        // insert row also identifies one removed by hand)
        return sql<boolean>`c.table_name = 'role_grant' and c.row_id in (
                select g.id from role_grant g
                 where g.company_id = ${companyId}::uuid and g.user_id = ${id}::uuid and g.org_unit_id in (${unitScope})
                union
                select i.row_id from audit.change_log i
                 where i.company_id = ${companyId}::uuid and i.table_name = 'role_grant' and i.op = 'insert'
                   and i.after ->> 'user_id' = ${id}::text
                   and (i.after ->> 'org_unit_id')::uuid in (${unitScope}))`;
    }
  }
}
