import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { NotificationCursor } from '../domain/notification-rules.js';

export interface NotificationRow {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string;
  data: Record<string, unknown>;
  createdAt: string;
  /** ISO-8601 UTC with microseconds (cursor) */
  createdAtMicros: string;
  readAt: string | null;
}

export interface NewNotification {
  id: string;
  userId: string;
  type: string;
  subjectType: string;
  subjectId: string;
  data: Record<string, unknown>;
}

const ISO = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const MICROS = (column: string) => sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** The channel of the SSE fan-out (migration 0012: the insert trigger; the read routes for count changes). */
export const NOTIFICATION_CHANNEL = 'hrforce_notifications';

/**
 * Notifications and preferences through the request transaction. Reads and updates are always filtered by the caller
 * (company + user); RLS (tenant policy + the restrictive own-user policy of migration 0012) is the backstop.
 * Inserts for OTHER users never use RETURNING (it would need the recipient's SELECT policy).
 */
@Injectable()
export class NotificationRepository {
  /** true when the row was created (false: this recipient already has this type for this subject). */
  async insert(companyId: string, n: NewNotification): Promise<boolean> {
    const result = await currentTx()
      .insertInto('notification')
      .values({
        id: n.id,
        company_id: companyId,
        user_id: n.userId,
        type: n.type,
        subject_type: n.subjectType,
        subject_id: n.subjectId,
        data: JSON.stringify(n.data),
      })
      // no conflict target: naming the arbiter index makes Postgres apply the recipient's SELECT policy (RLS)
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async list(companyId: string, userId: string, options: { unreadOnly: boolean; cursor: NotificationCursor | null; limit: number }): Promise<NotificationRow[]> {
    let query = currentTx()
      .selectFrom('notification as n')
      .select([
        'n.id',
        'n.type',
        'n.subject_type as subjectType',
        'n.subject_id as subjectId',
        'n.data',
        ISO('n.created_at').as('createdAt'),
        MICROS('n.created_at').as('createdAtMicros'),
        ISO('n.read_at').as('readAt'),
      ])
      .where('n.company_id', '=', companyId)
      .where('n.user_id', '=', userId);
    if (options.unreadOnly) query = query.where('n.read_at', 'is', null);
    if (options.cursor) {
      const { at, id } = options.cursor;
      query = query.where(sql<boolean>`(n.created_at, n.id) < (${at}::timestamptz, ${id}::uuid)`);
    }
    const rows = await query.orderBy('n.created_at', 'desc').orderBy('n.id', 'desc').limit(options.limit).execute();
    return rows.map((r) => ({ ...r, data: (r.data ?? {}) as Record<string, unknown> }));
  }

  async one(companyId: string, userId: string, id: string): Promise<NotificationRow | undefined> {
    const [row] = await this.byIds(companyId, userId, [id]);
    return row;
  }

  private async byIds(companyId: string, userId: string, ids: string[]): Promise<NotificationRow[]> {
    const rows = await currentTx()
      .selectFrom('notification as n')
      .select([
        'n.id',
        'n.type',
        'n.subject_type as subjectType',
        'n.subject_id as subjectId',
        'n.data',
        ISO('n.created_at').as('createdAt'),
        MICROS('n.created_at').as('createdAtMicros'),
        ISO('n.read_at').as('readAt'),
      ])
      .where('n.company_id', '=', companyId)
      .where('n.user_id', '=', userId)
      .where('n.id', 'in', ids)
      .execute();
    return rows.map((r) => ({ ...r, data: (r.data ?? {}) as Record<string, unknown> }));
  }

  async unreadCount(companyId: string, userId: string): Promise<number> {
    const row = await currentTx()
      .selectFrom('notification')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** Marks one of the caller's notifications read. undefined = not theirs / unknown; false = was already read. */
  async markRead(companyId: string, userId: string, id: string): Promise<boolean | undefined> {
    const result = await currentTx()
      .updateTable('notification')
      .set({ read_at: sql`now()` })
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .where('id', '=', id)
      .where('read_at', 'is', null)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) > 0) return true;
    return (await this.one(companyId, userId, id)) ? false : undefined;
  }

  async markAllRead(companyId: string, userId: string): Promise<number> {
    const result = await currentTx()
      .updateTable('notification')
      .set({ read_at: sql`now()` })
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .where('read_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /**
   * Tells the caller's open streams (every API process) that their counts changed — `id: null` — on commit.
   * Same channel and payload keys as the insert trigger.
   */
  async signalCountChanged(companyId: string, userId: string): Promise<void> {
    await sql`select pg_notify(${NOTIFICATION_CHANNEL}, json_build_object('companyId', ${companyId}::uuid, 'userId', ${userId}::uuid, 'id', null)::text)`.execute(
      currentTx(),
    );
  }

  async preferences(companyId: string, userId: string): Promise<Map<string, boolean>> {
    const rows = await currentTx()
      .selectFrom('notification_preference')
      .select(['type', 'email'])
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .execute();
    return new Map(rows.map((r) => [r.type, r.email]));
  }

  /** Upsert; an unchanged value writes nothing (no audit row). */
  async setPreference(companyId: string, userId: string, type: string, email: boolean): Promise<void> {
    await sql`
      insert into notification_preference (company_id, user_id, type, email)
      values (${companyId}::uuid, ${userId}::uuid, ${type}, ${email})
      on conflict (company_id, user_id, type) do update set email = excluded.email, updated_at = now()
        where notification_preference.email is distinct from excluded.email`.execute(currentTx());
  }
}
