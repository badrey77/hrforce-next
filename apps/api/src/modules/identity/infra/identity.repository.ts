import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { currentContext } from '../../../platform/context/request-context.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import type { DB } from '../../../platform/db/schema.js';
import type { AccountStatus, Locale, LoginOutcome, PasswordTokenPurpose } from '../domain/account.js';

/*
 * Access to the `auth` schema — ONLY through the SECURITY DEFINER functions of migration 0007 (hrforce_app has no
 * privilege on the auth tables). The auth tables are deliberately excluded from the generated schema.ts
 * (.kysely-codegenrc.json), so the function results are typed here by hand; each row type mirrors the function's
 * RETURNS TABLE in 0007_identity.sql.
 *
 * Executor: the request transaction when there is one (GET /api/me), otherwise the root pool. The /api/auth routes
 * are @SkipTransaction() on purpose: a failed login must still record its login_event, and a detected refresh-token
 * reuse must commit the family revocation, even though the HTTP response is an error (which would roll back a
 * request transaction). Each function call is atomic on its own (row locks inside the function where needed).
 */

export interface LoginRecord {
  userId: string;
  status: AccountStatus;
  passwordHash: string | null;
  locale: Locale;
}

export interface LoginFailures {
  dbNow: Date;
  emailFailures: Date[];
  ipFailures: Date[];
}

export interface NewSession {
  sessionId: string;
  companyId: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export type RotationOutcome = 'ok' | 'race' | 'reuse' | 'expired' | 'invalid';

export interface Rotation {
  outcome: RotationOutcome;
  session: (NewSession & { userId: string }) | null;
}

export interface MeRecord {
  userId: string;
  email: string;
  displayName: string;
  locale: Locale;
  company: CompanyRecord;
}

export interface CompanyRecord {
  id: string;
  code: string;
  name: string;
}

export interface PasswordTokenTarget {
  userId: string;
  email: string;
  purpose: PasswordTokenPurpose;
}

export interface ResetTarget {
  userId: string;
  email: string;
  displayName: string;
  locale: Locale;
}

type Timestamp = Date | string;
const toDate = (value: Timestamp): Date => (value instanceof Date ? value : new Date(value));
const toDates = (values: Timestamp[] | null | undefined): Date[] => (values ?? []).map(toDate);

/** A valid IP literal for the `inet` column (IPv6 zone ids stripped), else null. */
export function inetOrNull(ip: string | undefined | null): string | null {
  if (!ip) return null;
  const value = ip.replace(/%.*$/, '');
  return isIP(value) ? value : null;
}

@Injectable()
export class IdentityRepository {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  private executor(): Kysely<DB> {
    return currentContext()?.tx ?? this.db;
  }

  async findLogin(email: string): Promise<LoginRecord | null> {
    const { rows } = await sql<{ user_id: string; status: AccountStatus; password_hash: string | null; locale: Locale }>`
      select user_id, status, password_hash, locale from auth.find_login(${email})`.execute(this.executor());
    const row = rows[0];
    return row ? { userId: row.user_id, status: row.status, passwordHash: row.password_hash, locale: row.locale } : null;
  }

  async recordLoginEvent(event: { email: string; userId: string | null; ip: string | null; userAgent: string | null; outcome: LoginOutcome }): Promise<void> {
    await sql`select auth.record_login_event(${event.email}, ${event.userId}::uuid, ${event.ip}::inet, ${event.userAgent}, ${event.outcome})`.execute(
      this.executor(),
    );
  }

  async loginFailures(email: string, ip: string | null): Promise<LoginFailures> {
    const { rows } = await sql<{ db_now: Timestamp; email_failures: Timestamp[]; ip_failures: Timestamp[] }>`
      select db_now, email_failures, ip_failures from auth.login_failures(${email}, ${ip}::inet)`.execute(this.executor());
    const row = rows[0];
    if (!row) throw new Error('auth.login_failures returned no row');
    return { dbNow: toDate(row.db_now), emailFailures: toDates(row.email_failures), ipFailures: toDates(row.ip_failures) };
  }

  async createSession(userId: string, refreshHash: Buffer, ip: string | null, userAgent: string | null): Promise<NewSession | null> {
    const { rows } = await sql<{ session_id: string; company_id: string; expires_at: Timestamp; absolute_expires_at: Timestamp }>`
      select session_id, company_id, expires_at, absolute_expires_at
        from auth.create_session(${userId}::uuid, ${refreshHash}, ${ip}::inet, ${userAgent})`.execute(this.executor());
    const row = rows[0];
    return row
      ? { sessionId: row.session_id, companyId: row.company_id, expiresAt: toDate(row.expires_at), absoluteExpiresAt: toDate(row.absolute_expires_at) }
      : null;
  }

  async rotateSession(oldHash: Buffer, newHash: Buffer, ip: string | null, userAgent: string | null): Promise<Rotation> {
    const { rows } = await sql<{
      outcome: RotationOutcome;
      session_id: string | null;
      user_id: string | null;
      company_id: string | null;
      expires_at: Timestamp | null;
      absolute_expires_at: Timestamp | null;
    }>`
      select outcome, session_id, user_id, company_id, expires_at, absolute_expires_at
        from auth.rotate_session(${oldHash}, ${newHash}, ${ip}::inet, ${userAgent})`.execute(this.executor());
    const row = rows[0];
    if (!row) throw new Error('auth.rotate_session returned no row');
    if (row.outcome !== 'ok' || !row.session_id || !row.user_id || !row.company_id || !row.expires_at || !row.absolute_expires_at) {
      return { outcome: row.outcome, session: null };
    }
    return {
      outcome: 'ok',
      session: {
        sessionId: row.session_id,
        userId: row.user_id,
        companyId: row.company_id,
        expiresAt: toDate(row.expires_at),
        absoluteExpiresAt: toDate(row.absolute_expires_at),
      },
    };
  }

  async sessionSid(refreshHash: Buffer): Promise<string | null> {
    const { rows } = await sql<{ sid: string | null }>`select auth.session_sid(${refreshHash}) as sid`.execute(this.executor());
    return rows[0]?.sid ?? null;
  }

  async revokeFamily(refreshHash: Buffer | null, sid: string | null, userId: string | null): Promise<void> {
    await sql`select auth.revoke_family(${refreshHash}, ${sid}::uuid, ${userId}::uuid)`.execute(this.executor());
  }

  async me(userId: string, companyId: string): Promise<MeRecord | null> {
    const { rows } = await sql<{
      user_id: string;
      email: string;
      display_name: string;
      locale: Locale;
      company_id: string;
      company_code: string;
      company_name: string;
    }>`select user_id, email, display_name, locale, company_id, company_code, company_name
         from auth.me(${userId}::uuid, ${companyId}::uuid)`.execute(this.executor());
    const row = rows[0];
    return row
      ? {
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          locale: row.locale,
          company: { id: row.company_id, code: row.company_code, name: row.company_name },
        }
      : null;
  }

  async userCompanies(userId: string): Promise<CompanyRecord[]> {
    const { rows } = await sql<{ company_id: string; code: string; name: string }>`
      select company_id, code, name from auth.user_companies(${userId}::uuid)`.execute(this.executor());
    return rows.map((r) => ({ id: r.company_id, code: r.code, name: r.name }));
  }

  async passwordTokenTarget(tokenHash: Buffer): Promise<PasswordTokenTarget | null> {
    const { rows } = await sql<{ user_id: string; email: string; purpose: PasswordTokenPurpose }>`
      select user_id, email, purpose from auth.password_token_target(${tokenHash})`.execute(this.executor());
    const row = rows[0];
    return row ? { userId: row.user_id, email: row.email, purpose: row.purpose } : null;
  }

  async consumePasswordToken(tokenHash: Buffer, passwordHash: string): Promise<string | null> {
    const { rows } = await sql<{ user_id: string | null }>`
      select auth.consume_password_token(${tokenHash}, ${passwordHash}) as user_id`.execute(this.executor());
    return rows[0]?.user_id ?? null;
  }

  async requestPasswordReset(email: string, tokenHash: Buffer): Promise<ResetTarget | null> {
    const { rows } = await sql<{ user_id: string; email: string; display_name: string; locale: Locale }>`
      select user_id, email, display_name, locale from auth.request_password_reset(${email}, ${tokenHash})`.execute(this.executor());
    const row = rows[0];
    return row ? { userId: row.user_id, email: row.email, displayName: row.display_name, locale: row.locale } : null;
  }
}
