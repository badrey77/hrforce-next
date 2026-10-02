/**
 * SSO — pure rules (docs/contracts/sso.md › Validation, › Sign-in flow). No Nest, no Kysely.
 */

export const SSO_PERMISSIONS = {
  read: 'sso.read',
  manageApps: 'sso.manage_apps',
  assign: 'sso.assign',
} as const;

/** Scopes the provider offers and a first-party client may ask for (no offline_access: no refresh tokens). */
export const SSO_SCOPES = ['openid', 'profile', 'email', 'hrforce'] as const;
export const SSO_SCOPE_STRING = SSO_SCOPES.join(' ');

export const CLIENT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post'] as const;
export type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number];

/** Client ids chosen by the admin, unique across the group. */
export const CLIENT_ID_PATTERN = /^[a-z][a-z0-9-]{2,39}$/;
/** App role codes (they travel in the ID token's `roles`). */
export const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
/** The provider's interaction uids (nanoid, 21 characters by default). */
export const INTERACTION_UID_PATTERN = /^[A-Za-z0-9_-]{21,64}$/;

export const NAME_MAX = 80;
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const URI_MAX = 2000;
export const URIS_MAX = 10;

export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * One redirect / post-logout URI (assumption 9): absolute http(s), no fragment, no user-info, no `*`, ≤ 2000
 * characters (`invalid_uri`); `http://` only for a loopback host, any port (`insecure_uri`). URIs are compared exactly
 * as given (no normalisation), so the value is checked, never rewritten.
 */
export function uriIssue(value: string): 'invalid_uri' | 'insecure_uri' | null {
  if (value.length === 0 || value.length > URI_MAX || value.includes('*') || value.includes('#') || /\s/.test(value)) return 'invalid_uri';
  if (!/^https?:\/\//.test(value)) return 'invalid_uri';
  // user-info (`https://user@host/`, even an empty `https://@host/`) is refused: the authority must not hold an `@`
  const authority = value.replace(/^https?:\/\//, '').split(/[/?]/)[0] ?? '';
  if (authority.includes('@') || authority === '') return 'invalid_uri';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid_uri';
  }
  if (url.hostname === '') return 'invalid_uri';
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return 'insecure_uri';
  return null;
}

/** A list of URIs: `required` (when `required` and empty), `too_many`, then per item `invalid_uri` / `insecure_uri` / `duplicate`. */
export function uriListIssues(field: string, values: readonly unknown[], { required }: { required: boolean }): FieldIssue[] {
  const issues: FieldIssue[] = [];
  if (required && values.length === 0) issues.push({ field, code: 'required', message: 'At least one URI is required.' });
  if (values.length > URIS_MAX) issues.push({ field, code: 'too_many', message: `At most ${URIS_MAX} URIs.` });
  const seen = new Set<string>();
  values.forEach((raw, i) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const issue = typeof raw === 'string' ? uriIssue(value) : 'invalid_uri';
    if (issue === 'invalid_uri') {
      issues.push({ field: `${field}.${i}`, code: issue, message: 'An absolute http(s) URI without fragment, user-info or wildcard (at most 2000 characters).' });
    } else if (issue === 'insecure_uri') {
      issues.push({ field: `${field}.${i}`, code: issue, message: 'http:// is only allowed for localhost, 127.0.0.1 or [::1]; use https://.' });
    } else if (seen.has(value)) {
      issues.push({ field: `${field}.${i}`, code: 'duplicate', message: 'This URI is already listed.' });
    }
    seen.add(value);
  });
  return issues;
}

/** Algiers calendar date (YYYY-MM-DD) of an instant: the `employee` claim is computed for today in Algiers. */
export function algiersDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

export interface FreshLoginInput {
  /** the authorization request's `prompt` (space-separated) */
  prompt: string | undefined;
  /** the authorization request's `max_age` (seconds) */
  maxAge: number | undefined;
  /** the HRForce login instant of the caller's session */
  authTime: Date;
  /** creation of the interaction (epoch seconds) */
  interactionCreatedAt: number;
  now: Date;
}

/**
 * The app asks for a NEW sign-in (docs/contracts/sso.md › complete, step 5): `prompt` contains `login` and the
 * HRForce login happened before the interaction was created, or `max_age` is set and the login is older than it.
 */
export function freshLoginRequired(input: FreshLoginInput): boolean {
  const prompts = new Set((input.prompt ?? '').split(' ').filter((p) => p.length > 0));
  const authSeconds = Math.floor(input.authTime.getTime() / 1000);
  if (prompts.has('login') && authSeconds < input.interactionCreatedAt) return true;
  if (input.maxAge !== undefined && Number.isFinite(input.maxAge) && (input.now.getTime() - input.authTime.getTime()) / 1000 > input.maxAge) return true;
  return false;
}

/** `max_age` of the stored authorization parameters (a string or a number), undefined when absent or malformed. */
/** The UI languages HRForce speaks, as an app may name them in `ui_locales`. */
export const UI_LANGUAGES = ['fr', 'ar', 'en'] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/**
 * The app's `ui_locales` (OIDC: space-separated BCP 47 tags, preferred first) reduced to the languages HRForce speaks,
 * in order, without duplicates: `"ar-DZ fr"` → `['ar', 'fr']`. Anything else (absent, malformed) → `[]`.
 */
export function parseUiLocales(value: unknown): UiLanguage[] {
  if (typeof value !== 'string' || value.length > 200) return [];
  const languages: UiLanguage[] = [];
  for (const tag of value.split(' ')) {
    const primary = tag.split('-')[0]?.toLowerCase();
    const known = UI_LANGUAGES.find((l) => l === primary);
    if (known && !languages.includes(known)) languages.push(known);
  }
  return languages;
}

export function parseMaxAge(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{1,10}$/.test(value)) return Number(value);
  return undefined;
}
