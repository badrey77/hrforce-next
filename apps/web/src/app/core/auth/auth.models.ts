/**
 * Identity contract types (docs/contracts/identity.md › Endpoints). Plain TypeScript, no Angular.
 * Field names match the contract text exactly: the API builds against the same document.
 */

/** `GET /api/me` → `user`. */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  /** `fr` / `ar` / `en` (the account's preferred language). */
  readonly locale: string;
}

/** A company the user belongs to (`company` and `companies[]` in `GET /api/me`). */
export interface SessionCompany {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** `GET /api/me` response body. Authorization will add `permissions` and `scopes` later. */
export interface Me {
  readonly user: SessionUser;
  readonly company: SessionCompany;
  readonly companies: readonly SessionCompany[];
}

/** `POST /api/auth/login` body. */
export interface LoginCredentials {
  readonly email: string;
  readonly password: string;
}

/** `POST /api/auth/password/setup` body. */
export interface PasswordSetup {
  readonly token: string;
  readonly password: string;
}

/** Problem `type` values the web reacts to (`urn:hrforce:problem:<slug>`). */
export const AUTH_PROBLEM = {
  invalidCredentials: 'urn:hrforce:problem:invalid-credentials',
  accountLocked: 'urn:hrforce:problem:account-locked',
  tooManyAttempts: 'urn:hrforce:problem:too-many-attempts',
  accountDisabled: 'urn:hrforce:problem:account-disabled',
  sessionExpired: 'urn:hrforce:problem:session-expired',
  refreshRace: 'urn:hrforce:problem:refresh-race',
  tokenInvalid: 'urn:hrforce:problem:token-invalid',
  xsrf: 'urn:hrforce:problem:xsrf',
} as const;

/** Password length rule shared with the server (12–128 chars, NIST 800-63B: no composition rules). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
