import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { normalizeEmail, RESET_TOKEN_TTL_HOURS, SETUP_TOKEN_TTL_HOURS, type Locale, type PasswordTokenPurpose } from '../domain/account.js';
import { renderPasswordMail } from '../domain/mail-templates.js';
import { checkPasswordPolicy } from '../domain/password-policy.js';
import { IdentityRepository } from '../infra/identity.repository.js';
import { PasswordHasher } from '../infra/password-hasher.js';
import { hashOpaqueToken, newOpaqueToken, sha256 } from '../infra/secure-token.js';
import { MailSender } from './mail-sender.js';

const tokenInvalid = () => new ProblemException(410, 'token-invalid', 'This link is invalid, expired or already used.');

/** `${WEB_BASE_URL}/password/setup?token=…` — one page for setup and reset (docs/contracts/identity.md › Links). */
export function passwordLink(webBaseUrl: string, token: string): string {
  return `${webBaseUrl}/password/setup?token=${encodeURIComponent(token)}`;
}

export function passwordMail(input: { purpose: PasswordTokenPurpose; locale: Locale; displayName: string; to: string; link: string }) {
  const validHours = input.purpose === 'setup' ? SETUP_TOKEN_TTL_HOURS : RESET_TOKEN_TTL_HOURS;
  return { to: input.to, ...renderPasswordMail({ ...input, validHours }) };
}

/** Password setup / reset links. */
@Injectable()
export class PasswordService {
  private readonly logger = new Logger('PasswordService');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly repo: IdentityRepository,
    private readonly hasher: PasswordHasher,
    private readonly mail: MailSender,
  ) {}

  /**
   * 410 for an unknown/expired/used token, 422 for policy violations (errors on field `password`), otherwise the
   * token is consumed atomically (password set, invited → active, every session of the user revoked).
   */
  async setup(token: string, password: string): Promise<void> {
    const tokenHash = hashOpaqueToken(token);
    if (!tokenHash) throw tokenInvalid();
    const target = await this.repo.passwordTokenTarget(tokenHash);
    if (!target) throw tokenInvalid();
    const violations = checkPasswordPolicy(password, target.email);
    if (violations.length) {
      throw new ValidationProblemException(violations.map((v) => ({ field: 'password', code: v.code, message: v.message })));
    }
    const userId = await this.repo.consumePasswordToken(tokenHash, await this.hasher.hash(password));
    if (!userId) throw tokenInvalid(); // consumed concurrently / expired meanwhile
  }

  /**
   * Always resolves (the controller answers 202): a reset link is stored and mailed only for an ACTIVE account under
   * its quota (3 per hour). The mail is sent in the background so that the response time does not reveal whether
   * the account exists.
   */
  async forgot(email: string): Promise<void> {
    const token = newOpaqueToken();
    const target = await this.repo.requestPasswordReset(normalizeEmail(email), sha256(token));
    if (!target) return;
    const message = passwordMail({
      purpose: 'reset',
      locale: target.locale,
      displayName: target.displayName,
      to: target.email,
      link: passwordLink(this.env.WEB_BASE_URL, token),
    });
    void this.mail.send(message).catch((error: unknown) => {
      this.logger.error({ err: error, userId: target.userId }, 'password reset mail could not be sent');
    });
  }
}
