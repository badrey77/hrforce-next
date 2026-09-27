import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { currentContext } from '../../../platform/context/request-context.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import type { DB } from '../../../platform/db/schema.js';
import type { Locale } from '../domain/account.js';

/*
 * Two-step sign-in data — ONLY through the SECURITY DEFINER functions of migration 0013 (hrforce_app has no privilege
 * on auth.user_mfa / mfa_recovery_code / mfa_challenge). Row types mirror each function's RETURNS TABLE.
 * Executor: the request transaction when there is one (signed-in /api/me/mfa*, admin reset), else the root pool
 * (/api/auth/mfa/verify is @SkipTransaction: a failure must be recorded although the response is an error).
 */

export type MfaState = 'none' | 'pending' | 'active';

export interface MfaStatusRecord {
  status: MfaState;
  enabledAt: Date | null;
  recoveryCodesLeft: number | null;
}

export interface ChallengeStart {
  challengeId: string;
  companyId: string;
  expiresAt: Date;
}

export interface OpenChallenge {
  email: string;
  secretEnc: Buffer;
  lastUsedStep: number | null;
}

export interface OwnSecret {
  status: 'pending' | 'active';
  secretEnc: Buffer;
  lastUsedStep: number | null;
}

export type ChallengeOutcome = 'ok' | 'replay' | 'invalid' | 'expired';

export interface ResetTarget {
  email: string;
  displayName: string;
  locale: Locale;
  hadMfa: boolean;
}

type Timestamp = Date | string;
const toDate = (value: Timestamp): Date => (value instanceof Date ? value : new Date(value));
const toStep = (value: string | number | null): number | null => (value === null ? null : Number(value));

@Injectable()
export class MfaRepository {
  constructor(@Inject(KYSELY) private readonly db: Database) {}

  private executor(): Kysely<DB> {
    return currentContext()?.tx ?? this.db;
  }

  async beginChallenge(userId: string): Promise<ChallengeStart | null> {
    const { rows } = await sql<{ challenge_id: string; company_id: string; expires_at: Timestamp }>`
      select challenge_id, company_id, expires_at from auth.mfa_begin_challenge(${userId}::uuid)`.execute(this.executor());
    const row = rows[0];
    return row ? { challengeId: row.challenge_id, companyId: row.company_id, expiresAt: toDate(row.expires_at) } : null;
  }

  async openChallenge(challengeId: string, userId: string): Promise<OpenChallenge | null> {
    const { rows } = await sql<{ email: string; secret_enc: Buffer; last_used_step: string | null }>`
      select email, secret_enc, last_used_step from auth.mfa_challenge_open(${challengeId}::uuid, ${userId}::uuid)`.execute(this.executor());
    const row = rows[0];
    return row ? { email: row.email, secretEnc: row.secret_enc, lastUsedStep: toStep(row.last_used_step) } : null;
  }

  /** Failures after this one (5 = the challenge is dead), or null when it was not live. */
  async failChallenge(challengeId: string, userId: string): Promise<number | null> {
    const { rows } = await sql<{ failures: number | null }>`
      select auth.mfa_challenge_fail(${challengeId}::uuid, ${userId}::uuid) as failures`.execute(this.executor());
    return rows[0]?.failures ?? null;
  }

  async completeChallenge(
    challengeId: string,
    userId: string,
    proof: { step: number } | { recoveryHash: Buffer },
  ): Promise<{ outcome: ChallengeOutcome; recoveryCodesLeft: number | null }> {
    const step = 'step' in proof ? String(proof.step) : null;
    const recovery = 'recoveryHash' in proof ? proof.recoveryHash : null;
    const { rows } = await sql<{ outcome: ChallengeOutcome; recovery_codes_left: number | null }>`
      select outcome, recovery_codes_left
        from auth.mfa_challenge_complete(${challengeId}::uuid, ${userId}::uuid, ${step}::bigint, ${recovery}::bytea)`.execute(this.executor());
    const row = rows[0];
    if (!row) throw new Error('auth.mfa_challenge_complete returned no row');
    return { outcome: row.outcome, recoveryCodesLeft: row.recovery_codes_left };
  }

  async status(userId: string): Promise<MfaStatusRecord> {
    const { rows } = await sql<{ status: MfaState; enabled_at: Timestamp | null; recovery_codes_left: number | null }>`
      select status, enabled_at, recovery_codes_left from auth.mfa_status(${userId}::uuid)`.execute(this.executor());
    const row = rows[0];
    if (!row) throw new Error('auth.mfa_status returned no row');
    return { status: row.status, enabledAt: row.enabled_at === null ? null : toDate(row.enabled_at), recoveryCodesLeft: row.recovery_codes_left };
  }

  async enrollStart(userId: string, secretEnc: Buffer): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`select auth.mfa_enroll_start(${userId}::uuid, ${secretEnc}) as ok`.execute(this.executor());
    return rows[0]?.ok === true;
  }

  async ownSecret(userId: string): Promise<OwnSecret | null> {
    const { rows } = await sql<{ status: 'pending' | 'active'; secret_enc: Buffer; last_used_step: string | null }>`
      select status, secret_enc, last_used_step from auth.mfa_own_secret(${userId}::uuid)`.execute(this.executor());
    const row = rows[0];
    return row ? { status: row.status, secretEnc: row.secret_enc, lastUsedStep: toStep(row.last_used_step) } : null;
  }

  async enrollConfirm(userId: string, step: number, hashes: Buffer[]): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      select auth.mfa_enroll_confirm(${userId}::uuid, ${String(step)}::bigint, ${hashes}::bytea[]) as ok`.execute(this.executor());
    return rows[0]?.ok === true;
  }

  async replaceRecoveryCodes(userId: string, step: number, hashes: Buffer[]): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`
      select auth.mfa_replace_recovery_codes(${userId}::uuid, ${String(step)}::bigint, ${hashes}::bytea[]) as ok`.execute(this.executor());
    return rows[0]?.ok === true;
  }

  async disable(userId: string, step: number): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`select auth.mfa_disable(${userId}::uuid, ${String(step)}::bigint) as ok`.execute(this.executor());
    return rows[0]?.ok === true;
  }

  /** Admin reset of a member of the current tenant (never the caller); null for a non-member. */
  async reset(userId: string): Promise<ResetTarget | null> {
    const { rows } = await sql<{ email: string; display_name: string; locale: Locale; had_mfa: boolean }>`
      select email, display_name, locale, had_mfa from auth.mfa_reset(${userId}::uuid)`.execute(this.executor());
    const row = rows[0];
    return row ? { email: row.email, displayName: row.display_name, locale: row.locale, hadMfa: row.had_mfa } : null;
  }

  /**
   * A wrong code on a signed-in MFA route counts toward the per-e-mail lock (login_event 'mfa_failed'). Written on the
   * root pool, OUTSIDE the request transaction, which the error response rolls back.
   */
  async recordFailureOutsideRequest(email: string, userId: string, ip: string | null, userAgent: string | null): Promise<void> {
    await sql`select auth.record_login_event(${email}, ${userId}::uuid, ${ip}::inet, ${userAgent}, 'mfa_failed')`.execute(this.db);
  }
}
