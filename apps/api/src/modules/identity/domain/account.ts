/** Identity domain types (docs/contracts/identity.md › Data). */
export type AccountStatus = 'invited' | 'active' | 'disabled';
export type Locale = 'fr' | 'ar' | 'en';
export const LOCALES: readonly Locale[] = ['fr', 'ar', 'en'];
export type PasswordTokenPurpose = 'setup' | 'reset';
export type LoginOutcome = 'success' | 'bad_credentials' | 'locked' | 'disabled' | 'throttled_ip' | 'mfa_failed';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/** E-mails are stored and compared lower-case, trimmed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Lifetimes (the SQL functions in migration 0007 hold the same numbers for sessions and reset tokens). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const SETUP_TOKEN_TTL_HOURS = 72;
export const RESET_TOKEN_TTL_HOURS = 1;
