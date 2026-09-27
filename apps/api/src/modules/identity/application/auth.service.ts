import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import { identityOf, RequestIdentityResolver } from '../../../platform/context/request-identity.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { MFA_COOKIE, readCookie, REFRESH_COOKIE, XSRF_COOKIE } from '../../../platform/security/cookies.js';
import { signAccessToken, signMfaPendingToken, verifyMfaPendingToken } from '../../../platform/security/jwt.js';
import { ANON_BINDING, verifyXsrfToken, verifyXsrfTokenForAny } from '../../../platform/security/xsrf.js';
import { ACCESS_TOKEN_TTL_SECONDS, normalizeEmail, type LoginOutcome } from '../domain/account.js';
import { hashRecoveryCode, MFA_CHALLENGE_TTL_SECONDS, MFA_MAX_FAILURES, normalizeRecoveryCode, verifyTotp } from '../domain/mfa.js';
import { emailLockedUntil, ipThrottledUntil, retryAfterSeconds } from '../domain/throttle.js';
import { AuthCookies } from '../infra/auth-cookies.js';
import { IdentityRepository, type NewSession } from '../infra/identity.repository.js';
import { MfaCipher } from '../infra/mfa-cipher.js';
import { MfaRepository } from '../infra/mfa.repository.js';
import { PasswordHasher } from '../infra/password-hasher.js';
import { hashOpaqueToken, newOpaqueToken, sha256 } from '../infra/secure-token.js';
import { clientOf } from './client-info.js';
import { MfaClock } from './mfa-clock.js';
import type { MfaRequiredView } from './mfa-views.js';
import { mfaInvalid, MfaService } from './mfa.service.js';

export interface LoginInput {
  email: string;
  password: string;
}

/** POST /api/auth/mfa/verify: exactly one of the two. */
export interface MfaVerifyInput {
  code?: string | undefined;
  recoveryCode?: string | undefined;
}

/** Problem slugs of the auth endpoints (docs/contracts/identity.md › Endpoints). */
const invalidCredentials = () => new ProblemException(401, 'invalid-credentials', 'Invalid e-mail or password.');
const sessionExpired = () => new ProblemException(401, 'session-expired', 'Your session has expired. Please sign in again.');

function retryAfter(status: 423 | 429, slug: string, detail: string, seconds: number): ProblemException {
  return new ProblemException(status, slug, detail, undefined, { headers: { 'Retry-After': String(seconds) } });
}

const challengeExpired = () => new ProblemException(401, 'mfa-challenge-expired', 'The sign-in step has expired. Please sign in again.');

/** Login, refresh rotation, logout and XSRF issuing (ADR 004). */
@Injectable()
export class AuthService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly repo: IdentityRepository,
    private readonly hasher: PasswordHasher,
    private readonly cookies: AuthCookies,
    private readonly identityResolver: RequestIdentityResolver,
    private readonly audit: AuditEvents,
    private readonly mfa: MfaRepository,
    private readonly cipher: MfaCipher,
    private readonly clock: MfaClock,
    private readonly mfaService: MfaService,
  ) {}

  /**
   * Order: IP throttle (429) → e-mail lock (423) → argon2 verify (dummy hash for unknown e-mail / no password)
   * → invited = invalid credentials (401, same body) → disabled only after a correct password (403) → session.
   * Every attempt writes one login_event.
   * With an ACTIVE second factor (docs/contracts/mfa.md › Login flow) a correct password starts a 5-minute challenge
   * instead: 200 {mfaRequired: true} + the hrf_mfa cookie, no session cookies (the login_event comes with the second
   * step).
   */
  async login(req: Request, res: Response, input: LoginInput): Promise<MfaRequiredView | undefined> {
    const email = normalizeEmail(input.email);
    const { ip, userAgent } = clientOf(req);
    const record = (outcome: LoginOutcome, userId: string | null = null) =>
      this.repo.recordLoginEvent({ email, userId, ip, userAgent, outcome });

    const failures = await this.repo.loginFailures(email, ip);
    const ipUntil = ipThrottledUntil(failures.ipFailures, failures.dbNow);
    if (ipUntil) {
      await record('throttled_ip');
      throw retryAfter(429, 'too-many-attempts', 'Too many failed sign-in attempts from this address.', retryAfterSeconds(ipUntil, failures.dbNow));
    }
    const lockedUntil = emailLockedUntil(failures.emailFailures, failures.dbNow);
    if (lockedUntil) {
      await record('locked');
      throw retryAfter(423, 'account-locked', 'Too many failed sign-in attempts for this account.', retryAfterSeconds(lockedUntil, failures.dbNow));
    }

    const account = await this.repo.findLogin(email);
    const passwordOk = await this.hasher.verify(account?.passwordHash ?? null, input.password);
    if (!account || !passwordOk || account.status === 'invited') {
      await record('bad_credentials', account?.userId ?? null);
      throw invalidCredentials();
    }
    if (account.status === 'disabled') {
      await record('disabled', account.userId);
      throw new ProblemException(403, 'account-disabled', 'This account is disabled.');
    }

    const challenge = await this.mfa.beginChallenge(account.userId);
    if (challenge) {
      const now = Math.floor(Date.now() / 1000);
      const token = signMfaPendingToken(this.env.AUTH_ACCESS_SECRET, {
        sub: account.userId,
        cid: challenge.companyId,
        mfa: challenge.challengeId,
        iat: now,
        exp: now + MFA_CHALLENGE_TTL_SECONDS,
      });
      this.cookies.setMfaPending(res, token);
      return { mfaRequired: true };
    }
    await this.startSession(req, res, account.userId, email, {});
    return undefined;
  }

  /**
   * POST /api/auth/mfa/verify (docs/contracts/mfa.md › Login flow, step 2), with the hrf_mfa cookie of step 1.
   * Order: pending token → live challenge (else 401 mfa-challenge-expired, cookie cleared) → IP throttle (429) /
   * e-mail lock (423) → the code (TOTP: current step ±1, never a step already used) or a recovery code (single use).
   * Wrong → 401 mfa-invalid + login_event 'mfa_failed' (counts toward the e-mail lock); the 5th failure kills the
   * challenge → 401 mfa-challenge-expired. Right → the usual session cookies, hrf_mfa cleared, login_event success,
   * audit auth.login {mfa: totp|recovery}; a recovery code also mails the user and records auth.mfa_recovery_used.
   */
  async verifyMfa(req: Request, res: Response, input: MfaVerifyInput): Promise<void> {
    const token = readCookie(req, MFA_COOKIE);
    const claims = token ? verifyMfaPendingToken(this.env.AUTH_ACCESS_SECRET, token) : null;
    const expired = () => {
      this.cookies.clearMfaPending(res);
      return challengeExpired();
    };
    if (!claims) throw expired();
    const challenge = await this.mfa.openChallenge(claims.mfa, claims.sub);
    if (!challenge) throw expired();

    const { ip, userAgent } = clientOf(req);
    const email = challenge.email;
    const record = (outcome: LoginOutcome) => this.repo.recordLoginEvent({ email, userId: claims.sub, ip, userAgent, outcome });
    const failures = await this.repo.loginFailures(email, ip);
    const ipUntil = ipThrottledUntil(failures.ipFailures, failures.dbNow);
    if (ipUntil) {
      await record('throttled_ip');
      throw retryAfter(429, 'too-many-attempts', 'Too many failed sign-in attempts from this address.', retryAfterSeconds(ipUntil, failures.dbNow));
    }
    const lockedUntil = emailLockedUntil(failures.emailFailures, failures.dbNow);
    if (lockedUntil) {
      await record('locked');
      throw retryAfter(423, 'account-locked', 'Too many failed sign-in attempts for this account.', retryAfterSeconds(lockedUntil, failures.dbNow));
    }

    let method: 'totp' | 'recovery';
    let outcome: { outcome: string; recoveryCodesLeft: number | null } | null = null;
    if (input.recoveryCode !== undefined) {
      method = 'recovery';
      const normalized = normalizeRecoveryCode(input.recoveryCode);
      if (normalized) outcome = await this.mfa.completeChallenge(claims.mfa, claims.sub, { recoveryHash: hashRecoveryCode(normalized) });
    } else {
      method = 'totp';
      const secret = this.cipher.decrypt(challenge.secretEnc, claims.sub);
      const check = secret ? verifyTotp(secret, input.code ?? '', this.clock.nowMs(), challenge.lastUsedStep) : null;
      if (check?.ok) outcome = await this.mfa.completeChallenge(claims.mfa, claims.sub, { step: check.step });
    }
    if (outcome?.outcome === 'expired') throw expired();
    if (outcome?.outcome !== 'ok') {
      await record('mfa_failed');
      const count = await this.mfa.failChallenge(claims.mfa, claims.sub);
      if (count === null || count >= MFA_MAX_FAILURES) throw expired();
      throw mfaInvalid(401);
    }

    this.cookies.clearMfaPending(res);
    const session = await this.startSession(req, res, claims.sub, email, { mfa: method });
    if (method === 'recovery') {
      const left = outcome.recoveryCodesLeft ?? 0;
      await this.audit.recordFor(
        { companyId: session.companyId, actorUserId: claims.sub },
        { type: 'auth.mfa_recovery_used', subject: { type: 'user', id: claims.sub }, data: { recoveryCodesLeft: left } },
      );
      const me = await this.repo.me(claims.sub, session.companyId);
      if (me) this.mfaService.sendMail(me.email, { kind: 'recovery_used', locale: me.locale, displayName: me.displayName, codesLeft: left });
    }
  }

  /**
   * The end of a successful sign-in: session row, login_event success, audit auth.login (own short transaction under
   * the session's company), the browser's previous session revoked, cookies issued.
   */
  private async startSession(req: Request, res: Response, userId: string, email: string, extra: Record<string, unknown>): Promise<NewSession> {
    const { ip, userAgent } = clientOf(req);
    const record = (outcome: LoginOutcome) => this.repo.recordLoginEvent({ email, userId, ip, userAgent, outcome });
    const refresh = newOpaqueToken();
    const session = await this.repo.createSession(userId, sha256(refresh), ip, userAgent);
    if (!session) {
      // active but member of no company: no access at all
      await record('disabled');
      throw new ProblemException(403, 'account-disabled', 'This account has no access to any company.');
    }
    await record('success');
    // docs/contracts/audit.md: own short transaction under the session's company (no request transaction here)
    await this.audit.recordFor(
      { companyId: session.companyId, actorUserId: userId },
      { type: 'auth.login', subject: { type: 'user', id: userId }, data: { ip, userAgent, ...extra } },
    );
    // this browser's previous session (if any) is replaced: revoke its family
    const previous = hashOpaqueToken(readCookie(req, REFRESH_COOKIE));
    if (previous) await this.repo.revokeFamily(previous, null, null);
    this.issue(res, userId, session, refresh);
    return session;
  }

  /** Rotates hrf_rt. ok → new cookies; race → 409 (nothing changed); anything else → 401 + cookies cleared. */
  async refresh(req: Request, res: Response): Promise<void> {
    const oldHash = hashOpaqueToken(readCookie(req, REFRESH_COOKIE));
    if (!oldHash) {
      this.cookies.clearSession(res);
      throw sessionExpired();
    }
    const { ip, userAgent } = clientOf(req);
    const refresh = newOpaqueToken();
    const rotation = await this.repo.rotateSession(oldHash, sha256(refresh), ip, userAgent);
    if (rotation.outcome === 'race') {
      throw new ProblemException(409, 'refresh-race', 'The session was refreshed concurrently; retry the original request.');
    }
    if (rotation.outcome === 'reuse') await this.recordReuse(oldHash);
    if (rotation.outcome !== 'ok' || !rotation.session) {
      this.cookies.clearSession(res);
      throw sessionExpired();
    }
    this.issue(res, rotation.session.userId, rotation.session, refresh);
  }

  /** Revokes the family of the presented refresh token (and of the access token's session), clears the cookies. */
  async logout(req: Request, res: Response): Promise<void> {
    const refreshHash = hashOpaqueToken(readCookie(req, REFRESH_COOKIE));
    const identity = await identityOf(this.identityResolver, req);
    const sid = identity.sessionId ?? null;
    if (refreshHash || sid) await this.repo.revokeFamily(refreshHash, sid, sid ? identity.userId : null);
    // who signed out: the access token's user, else the owner of the presented refresh token
    const owner =
      sid && identity.userId && identity.companyId
        ? { userId: identity.userId, companyId: identity.companyId }
        : refreshHash
          ? await this.repo.sessionOwner(refreshHash)
          : null;
    if (owner) {
      await this.audit.recordFor(
        { companyId: owner.companyId, actorUserId: owner.userId },
        { type: 'auth.logout', subject: { type: 'user', id: owner.userId }, data: {} },
      );
    }
    this.cookies.clearSession(res);
  }

  /** A revoked / long-rotated refresh token was presented: its family was revoked (actor: system). */
  private async recordReuse(oldHash: Buffer): Promise<void> {
    const owner = await this.repo.sessionOwner(oldHash);
    if (!owner) return;
    await this.audit.recordFor(
      { companyId: owner.companyId, actorUserId: null },
      { type: 'auth.session_reuse', subject: { type: 'user', id: owner.userId }, data: { familyId: owner.familyId } },
    );
  }

  /**
   * GET /api/auth/csrf: keeps a present XSRF-TOKEN that is valid for the caller's binding, otherwise issues one.
   * Binding = sid of a valid access cookie, else the session of the refresh cookie (the access cookie lives 15 min,
   * the refresh cookie up to 7 days), else anon.
   */
  async ensureXsrf(req: Request, res: Response): Promise<void> {
    const binding = await this.preferredBinding(req);
    const current = readCookie(req, XSRF_COOKIE);
    if (current && verifyXsrfToken(this.env.AUTH_XSRF_SECRET, current, binding)) return;
    this.cookies.setXsrf(res, binding === ANON_BINDING ? null : binding);
  }

  /**
   * XSRF signature check of the /api/auth POST routes (the global XsrfGuard already checked header == cookie):
   * accepted when signed for anon, for the access cookie's sid, or for the refresh cookie's session.
   */
  async isAuthRouteXsrfValid(req: Request, token: string): Promise<boolean> {
    const secret = this.env.AUTH_XSRF_SECRET;
    const identity = await identityOf(this.identityResolver, req);
    if (verifyXsrfTokenForAny(secret, token, [ANON_BINDING, ...(identity.sessionId ? [identity.sessionId] : [])])) return true;
    const refreshHash = hashOpaqueToken(readCookie(req, REFRESH_COOKIE));
    const sid = refreshHash ? await this.repo.sessionSid(refreshHash) : null;
    return sid !== null && verifyXsrfToken(secret, token, sid);
  }

  private async preferredBinding(req: Request): Promise<string> {
    const identity = await identityOf(this.identityResolver, req);
    if (identity.sessionId) return identity.sessionId;
    const refreshHash = hashOpaqueToken(readCookie(req, REFRESH_COOKIE));
    const sid = refreshHash ? await this.repo.sessionSid(refreshHash) : null;
    return sid ?? ANON_BINDING;
  }

  private issue(res: Response, userId: string, session: NewSession, refresh: string): void {
    const now = Math.floor(Date.now() / 1000);
    const access = signAccessToken(this.env.AUTH_ACCESS_SECRET, {
      sub: userId,
      cid: session.companyId,
      sid: session.sessionId,
      iat: now,
      exp: now + ACCESS_TOKEN_TTL_SECONDS,
    });
    const refreshMaxAgeSeconds = Math.max(0, Math.floor((session.absoluteExpiresAt.getTime() - Date.now()) / 1000));
    this.cookies.setSession(res, { access, refresh, refreshMaxAgeSeconds, sid: session.sessionId });
  }
}
