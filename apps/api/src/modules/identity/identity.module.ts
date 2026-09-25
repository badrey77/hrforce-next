import { Module } from '@nestjs/common';
import { ENV } from '../../platform/config/config.module.js';
import type { Env } from '../../platform/config/env.schema.js';
import { AuthXsrfGuard } from './api/auth-xsrf.guard.js';
import { AuthController } from './api/auth.controller.js';
import { MeController } from './api/me.controller.js';
import { AuthService } from './application/auth.service.js';
import { MailSender } from './application/mail-sender.js';
import { MeService } from './application/me.service.js';
import { PasswordService } from './application/password.service.js';
import { AuthCookies } from './infra/auth-cookies.js';
import { IdentityRepository } from './infra/identity.repository.js';
import { createMailSender } from './infra/mail-senders.js';
import { PasswordHasher } from './infra/password-hasher.js';

/**
 * Identity (docs/contracts/identity.md, ADR 004): login with argon2id, access JWT + rotating refresh token in
 * httpOnly cookies, signed XSRF token, Postgres throttling, login history, password setup/reset links, GET /api/me.
 * The request identity itself (cookie → user/company) is resolved by the platform's CookieIdentityResolver.
 */
@Module({
  controllers: [AuthController, MeController],
  providers: [
    AuthService,
    PasswordService,
    MeService,
    IdentityRepository,
    PasswordHasher,
    AuthCookies,
    AuthXsrfGuard,
    { provide: MailSender, inject: [ENV], useFactory: (env: Env) => createMailSender(env) },
  ],
  exports: [MailSender],
})
export class IdentityModule {}
