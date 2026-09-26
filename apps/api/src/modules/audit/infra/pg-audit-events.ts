import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { AuditEvents, type AuditEventInput, type AuditTenant } from '../../../platform/audit/audit-events.js';
import { currentContext, currentTx } from '../../../platform/context/request-context.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import type { DB } from '../../../platform/db/schema.js';

async function recordEvent(db: Kysely<DB>, event: AuditEventInput): Promise<void> {
  await sql`select audit.record_event(${event.type}, ${event.subject?.type ?? null}, ${event.subject?.id ?? null}::uuid,
                                      ${JSON.stringify(event.data ?? {})}::jsonb)`.execute(db);
}

/**
 * {@link AuditEvents} on Postgres: audit.record_event() (SECURITY DEFINER; hrforce_app has no INSERT on audit.*),
 * which takes the tenant, actor and request id from the transaction's settings.
 */
@Injectable()
export class PgAuditEvents extends AuditEvents {
  constructor(@Inject(KYSELY) private readonly db: Database) {
    super();
  }

  record(event: AuditEventInput): Promise<void> {
    return recordEvent(currentTx(), event);
  }

  async recordFor(tenant: AuditTenant, event: AuditEventInput): Promise<void> {
    const requestId = currentContext()?.requestId ?? '';
    await this.db.transaction().execute(async (tx) => {
      await sql`select
          set_config('app.company_id', ${tenant.companyId}, true),
          set_config('app.user_id', ${tenant.actorUserId ?? ''}, true),
          set_config('app.request_id', ${requestId}, true)`.execute(tx);
      await recordEvent(tx, event);
    });
  }
}
