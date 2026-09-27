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

/**
 * Where a permission applies (docs/contracts/authorization.md › `GET /me`): one entry per effective grant whose role
 * holds the permission — the grant's unit, plus its sub-units when `includeDescendants`.
 */
export interface PermissionScope {
  readonly unitId: string;
  readonly includeDescendants: boolean;
}

/** `scopes` of `GET /api/me`: permission code → where it applies. */
export type PermissionScopes = Readonly<Record<string, readonly PermissionScope[]>>;

/** `GET /api/me` response body (Identity + the Authorization additions). */
export interface Me {
  readonly user: SessionUser;
  readonly company: SessionCompany;
  readonly companies: readonly SessionCompany[];
  /** Permission codes held ANYWHERE in the company (sorted), e.g. `['access.read', 'org_unit.read']`. */
  readonly permissions: readonly string[];
  readonly scopes: PermissionScopes;
  /**
   * Two-step sign-in state (docs/contracts/mfa.md › Enforcement). Optional so a `/me` from before the MFA step still
   * parses: absent = not enabled, not required.
   */
  readonly mfa?: MeMfa;
}

/** `GET /api/me` → `mfa`. */
export interface MeMfa {
  readonly enabled: boolean;
  /** The company policy requires this user to use two-step sign-in (enforced + holds a listed permission). */
  readonly required: boolean;
  /** Unused recovery codes; `null` when MFA is off. */
  readonly recoveryCodesLeft: number | null;
}

/** `POST /api/auth/login` body. */
export interface LoginCredentials {
  readonly email: string;
  readonly password: string;
}

/**
 * What `POST /api/auth/login` meant (docs/contracts/mfa.md › Login flow): `'signed-in'` = 204 + session cookies;
 * `'mfa-required'` = 200 `{mfaRequired: true}`, the password was right and a code is needed next.
 */
export type LoginOutcome = 'signed-in' | 'mfa-required';

/** `POST /api/auth/mfa/verify` body: an authenticator code OR a recovery code, never both. */
export type MfaVerification = { readonly code: string } | { readonly recoveryCode: string };

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
  // docs/contracts/mfa.md
  mfaInvalid: 'urn:hrforce:problem:mfa-invalid',
  mfaChallengeExpired: 'urn:hrforce:problem:mfa-challenge-expired',
  mfaEnrollmentRequired: 'urn:hrforce:problem:mfa-enrollment-required',
  mfaAlreadyEnabled: 'urn:hrforce:problem:mfa-already-enabled',
  mfaRequiredByPolicy: 'urn:hrforce:problem:mfa-required-by-policy',
  mfaResetSelf: 'urn:hrforce:problem:mfa-reset-self',
} as const;

/** A TOTP code as typed: exactly 6 digits (spaces are stripped before checking). */
export const TOTP_CODE_PATTERN = /^\d{6}$/;
/** A recovery code: 10 characters from the contract's alphabet, shown as `XXXXX-XXXXX` (dash optional, any case). */
export const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/;

/** Password length rule shared with the server (12–128 chars, NIST 800-63B: no composition rules). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
