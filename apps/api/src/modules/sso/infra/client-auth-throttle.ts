import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { KYSELY, type Database } from '../../../platform/db/database.js';

/** Failed client authentications from one IP within {@link THROTTLE_WINDOW_SECONDS} before /oidc/token answers 429. */
export const THROTTLE_LIMIT = 20;
export const THROTTLE_WINDOW_SECONDS = 15 * 60;

/** `ip` as stored in an inet column (zone ids stripped), else null. */
function inet(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const value = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').replace(/%.*$/, '');
  return /^[0-9a-fA-F:.]+$/.test(value) ? value : null;
}

/**
 * Token-endpoint throttle (docs/contracts/sso.md › Provider configuration, middleware 3): every `401 invalid_client`
 * writes one oidc.client_auth_failure row; ≥ 20 rows for the caller's IP in the last 15 minutes → 429 with
 * Retry-After. Root pool (global provider state); the worker's oidc.cleanup deletes rows older than a day.
 */
@Injectable()
export class ClientAuthThrottle {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  /** Seconds until the caller may try again, or 0 when not throttled. */
  async retryAfter(ip: string | undefined): Promise<number> {
    const { rows } = await sql<{ at: Date; now: Date }>`
      select f.at, now() as now from oidc.client_auth_failure f
       where f.ip is not distinct from ${inet(ip)}::inet and f.at > now() - make_interval(secs => ${THROTTLE_WINDOW_SECONDS})
       order by f.at desc
       limit ${THROTTLE_LIMIT}`.execute(this.db);
    const limiting = rows[THROTTLE_LIMIT - 1];
    if (!limiting) return 0;
    const ms = limiting.at.getTime() + THROTTLE_WINDOW_SECONDS * 1000 - limiting.now.getTime();
    return Math.max(1, Math.ceil(ms / 1000));
  }

  async record(ip: string | undefined, clientId: string): Promise<void> {
    await sql`insert into oidc.client_auth_failure (ip, client_id) values (${inet(ip)}::inet, ${clientId.slice(0, 64)})`.execute(this.db);
  }
}
