import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import QRCode from 'qrcode';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { MfaRequirement } from '../../../platform/authz/mfa-requirement.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import {
  base32Encode,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from '../domain/mfa.js';
import { renderMfaMail, type MfaMailInput } from '../domain/mfa-mail.js';
import { emailLockedUntil, retryAfterSeconds } from '../domain/throttle.js';
import { IdentityRepository } from '../infra/identity.repository.js';
import { MfaCipher } from '../infra/mfa-cipher.js';
import { MfaRepository } from '../infra/mfa.repository.js';
import type { ClientInfo } from './client-info.js';
import { MailSender } from './mail-sender.js';
import { MfaClock } from './mfa-clock.js';
import type { MeMfaView, MfaEnrollmentView, MfaStatusView, RecoveryCodesView } from './mfa-views.js';

export const mfaInvalid = (status: 401 | 422 = 422) =>
  new ProblemException(
    status,
    'mfa-invalid',
    'The code is not valid.',
    status === 422 ? [{ field: 'code', code: 'mfa_invalid', message: 'The code is not valid.' }] : undefined,
  );

export function accountLocked(until: Date, now: Date): ProblemException {
  return new ProblemException(423, 'account-locked', 'Too many failed sign-in attempts for this account.', undefined, {
    headers: { 'Retry-After': String(retryAfterSeconds(until, now)) },
  });
}

/** 10 new codes (shown once) and their sha-256 (stored). */
function recoverySet(): { codes: string[]; hashes: Buffer[] } {
  const codes = newRecoveryCodes();
  return { codes, hashes: codes.map((c) => hashRecoveryCode(normalizeRecoveryCode(c) ?? '')) };
}

/**
 * The signed-in user's own second factor (docs/contracts/mfa.md › Endpoints: /api/me/mfa*) and the admin reset.
 * Runs in the request transaction. A wrong code answers 422 `mfa-invalid` and counts toward the per-e-mail lock
 * (login_event 'mfa_failed', written outside the transaction); a locked e-mail answers 423 before any check.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger('MfaService');

  constructor(
    private readonly repo: MfaRepository,
    private readonly identity: IdentityRepository,
    private readonly cipher: MfaCipher,
    private readonly requirement: MfaRequirement,
    private readonly clock: MfaClock,
    private readonly audit: AuditEvents,
    private readonly mail: MailSender,
  ) {}

  private caller(): { userId: string; companyId: string } {
    const { userId, companyId } = requireContext();
    if (!userId || !companyId) throw new UnauthorizedException();
    return { userId, companyId };
  }

  private async account(): Promise<{ userId: string; companyId: string; email: string }> {
    const { userId, companyId } = this.caller();
    const me = await this.identity.me(userId, companyId);
    if (!me) throw new UnauthorizedException();
    return { userId, companyId, email: me.email };
  }

  /** GET /api/me/mfa */
  async status(): Promise<MfaStatusView> {
    const { userId, companyId } = this.caller();
    const status = await this.repo.status(userId);
    return {
      enabled: status.status === 'active',
      required: await this.requirement.isRequired({ userId, companyId }),
      enrolledAt: status.status === 'active' && status.enabledAt ? status.enabledAt.toISOString() : null,
      recoveryCodesLeft: status.status === 'active' ? status.recoveryCodesLeft : null,
    };
  }

  /** The `mfa` block of GET /api/me. */
  async meBlock(): Promise<MeMfaView> {
    const { enabled, required, recoveryCodesLeft } = await this.status();
    return { enabled, required, recoveryCodesLeft };
  }

  /** True when the user's factor is active (caller = the transaction's own user). */
  async isEnabled(userId: string): Promise<boolean> {
    return (await this.repo.status(userId)).status === 'active';
  }

  /** POST /api/me/mfa/enroll/start: a new pending secret (replaces a pending one); 409 when already enabled. */
  async enrollStart(): Promise<MfaEnrollmentView> {
    const { userId, email } = await this.account();
    const secret = newTotpSecret();
    if (!(await this.repo.enrollStart(userId, this.cipher.encrypt(secret, userId)))) throw alreadyEnabled();
    const base32 = base32Encode(secret);
    const uri = otpauthUri(email, base32);
    const qrPng = await QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
    return { secret: base32, otpauthUri: uri, qrPng };
  }

  /** POST /api/me/mfa/enroll/confirm: activates the pending secret; the recovery codes are returned once. */
  async enrollConfirm(code: string, client: ClientInfo): Promise<RecoveryCodesView> {
    const account = await this.account();
    const own = await this.repo.ownSecret(account.userId);
    if (own?.status === 'active') throw alreadyEnabled();
    const step = await this.checkCode(account, own, code, client);
    const set = recoverySet();
    if (!(await this.repo.enrollConfirm(account.userId, step, set.hashes))) throw mfaInvalid();
    await this.audit.record({ type: 'auth.mfa_enrolled', subject: { type: 'user', id: account.userId }, data: {} });
    return { recoveryCodes: set.codes };
  }

  /** POST /api/me/mfa/recovery-codes: a new set for a current TOTP code (the old set is void). */
  async regenerate(code: string, client: ClientInfo): Promise<RecoveryCodesView> {
    const account = await this.account();
    const own = await this.repo.ownSecret(account.userId);
    if (own?.status !== 'active') throw notEnabled();
    const step = await this.checkCode(account, own, code, client);
    const set = recoverySet();
    if (!(await this.repo.replaceRecoveryCodes(account.userId, step, set.hashes))) throw mfaInvalid();
    await this.audit.record({ type: 'auth.mfa_recovery_regenerated', subject: { type: 'user', id: account.userId }, data: {} });
    return { recoveryCodes: set.codes };
  }

  /** POST /api/me/mfa/disable: 409 when the company requires MFA for the caller. */
  async disable(code: string, client: ClientInfo): Promise<void> {
    const account = await this.account();
    if (await this.requirement.isRequired({ userId: account.userId, companyId: account.companyId })) {
      throw new ProblemException(409, 'mfa-required-by-policy', 'Your company requires two-step sign-in for your access rights.');
    }
    const own = await this.repo.ownSecret(account.userId);
    if (own?.status !== 'active') throw notEnabled();
    const step = await this.checkCode(account, own, code, client);
    if (!(await this.repo.disable(account.userId, step))) throw mfaInvalid();
    await this.audit.record({ type: 'auth.mfa_disabled', subject: { type: 'user', id: account.userId }, data: {} });
  }

  /**
   * POST /api/access/users/:id/mfa/reset (visibility and access.grant are checked by the caller): removes the member's
   * factor and recovery codes, revokes their sessions, e-mails them. 404 for a non-member.
   */
  async reset(targetUserId: string): Promise<void> {
    const { userId } = this.caller();
    if (targetUserId === userId) throw new ProblemException(409, 'mfa-reset-self', 'You cannot reset your own two-step sign-in.');
    const target = await this.repo.reset(targetUserId);
    if (!target) throw new ProblemException(404, 'not-found', 'User not found');
    await this.audit.record({ type: 'auth.mfa_reset', subject: { type: 'user', id: targetUserId }, data: { hadMfa: target.hadMfa } });
    this.sendMail(target.email, { kind: 'reset', locale: target.locale, displayName: target.displayName });
  }

  /** Security mail, sent in the background (a mail failure never fails the request). */
  sendMail(to: string, input: MfaMailInput): void {
    void this.mail.send({ to, ...renderMfaMail(input) }).catch((error: unknown) => {
      this.logger.error({ err: error instanceof Error ? error.message : String(error) }, `MFA security mail (${input.kind}) could not be sent`);
    });
  }

  /** The TOTP step of a valid code for the caller's own secret; 423 when the e-mail is locked; 422 otherwise. */
  private async checkCode(
    account: { userId: string; email: string },
    own: { secretEnc: Buffer; lastUsedStep: number | null } | null,
    code: string,
    client: ClientInfo,
  ): Promise<number> {
    const failures = await this.identity.loginFailures(account.email, client.ip);
    const lockedUntil = emailLockedUntil(failures.emailFailures, failures.dbNow);
    if (lockedUntil) throw accountLocked(lockedUntil, failures.dbNow);
    const secret = own ? this.cipher.decrypt(own.secretEnc, account.userId) : null;
    const check = secret ? verifyTotp(secret, code, this.clock.nowMs(), own?.lastUsedStep ?? null) : null;
    if (!check?.ok) {
      await this.repo.recordFailureOutsideRequest(account.email, account.userId, client.ip, client.userAgent);
      throw mfaInvalid();
    }
    return check.step;
  }
}

function alreadyEnabled(): ProblemException {
  return new ProblemException(409, 'mfa-already-enabled', 'Two-step sign-in is already enabled.');
}

function notEnabled(): ProblemException {
  return new ProblemException(409, 'mfa-not-enabled', 'Two-step sign-in is not enabled.');
}
