import { Module } from '@nestjs/common';
import { ENV } from '../../platform/config/config.module.js';
import type { Env } from '../../platform/config/env.schema.js';
import { BrandingModule } from '../branding/index.js';
import { AuthXsrfGuard } from './api/auth-xsrf.guard.js';
import { AuthController } from './api/auth.controller.js';
import { MeController } from './api/me.controller.js';
import { MfaController } from './api/mfa.controller.js';
import { AuthService } from './application/auth.service.js';
import { IdentitySessions } from './application/identity-sessions.js';
import { MailSender } from './application/mail-sender.js';
import { MeService } from './application/me.service.js';
import { MfaClock } from './application/mfa-clock.js';
import { MfaService } from './application/mfa.service.js';
import { PasswordService } from './application/password.service.js';
import { AuthCookies } from './infra/auth-cookies.js';
import { IdentityRepository } from './infra/identity.repository.js';
import { MfaCipher } from './infra/mfa-cipher.js';
import { MfaRepository } from './infra/mfa.repository.js';
import { createMailSender } from './infra/mail-senders.js';
import { PasswordHasher } from './infra/password-hasher.js';

/**
 * Identity (docs/contracts/identity.md, ADR 004): login with argon2id, access JWT + rotating refresh token in
 * httpOnly cookies, signed XSRF token, Postgres throttling, login history, password setup/reset links, GET /api/me.
 * Two-step sign-in (docs/contracts/mfa.md): TOTP + recovery codes, /api/auth/mfa/verify, /api/me/mfa*; MfaService
 * is exported for the Authorization module (admin reset, the MfaRequirement seam).
 * The request identity itself (cookie → user/company) is resolved by the platform's CookieIdentityResolver.
 */
@Module({
  // GET /api/me carries the company's branding (docs/contracts/branding.md); Branding imports only platform/**
  imports: [BrandingModule],
  controllers: [AuthController, MeController, MfaController],
  providers: [
    AuthService,
    PasswordService,
    MeService,
    IdentityRepository,
    PasswordHasher,
    AuthCookies,
    AuthXsrfGuard,
    MfaService,
    MfaRepository,
    MfaCipher,
    MfaClock,
    IdentitySessions,
    { provide: MailSender, inject: [ENV], useFactory: (env: Env) => createMailSender(env) },
  ],
  exports: [MailSender, MfaService, IdentitySessions],
})
export class IdentityModule {}
