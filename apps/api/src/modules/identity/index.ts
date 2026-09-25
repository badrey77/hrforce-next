/** Public surface of the Identity module (the only file other modules may import). */
export { IdentityModule } from './identity.module.js';
export { MailSender, type MailMessage } from './application/mail-sender.js';
export type { CompanyView, MeView } from './application/identity-views.js';
export { passwordLink, passwordMail } from './application/password.service.js';
export { checkPasswordPolicy, type PasswordPolicyCode, type PasswordPolicyViolation } from './domain/password-policy.js';
export { isLocale, normalizeEmail, SETUP_TOKEN_TTL_HOURS, type Locale } from './domain/account.js';
export { createMailSender, LogMailSender, SmtpMailSender } from './infra/mail-senders.js';
export { ARGON2_OPTIONS, PasswordHasher } from './infra/password-hasher.js';
export { newOpaqueToken, sha256 } from './infra/secure-token.js';
export { DEMO_PASSWORD, DEMO_USERS, inviteUser, seedIdentity, type DemoUser, type InviteResult } from './infra/identity-seed.js';
