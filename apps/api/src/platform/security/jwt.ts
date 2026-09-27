import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal compact JWS (JWT) with HS256 only — the access token of docs/contracts/identity.md and the pending
 * second-step token of docs/contracts/mfa.md (cookie hrf_mfa).
 * The two are told apart by the `pur` (purpose) claim: `access` / `mfa`. Each verifier accepts ONLY its own purpose
 * (and its own claim set), so a pending MFA token can never be used as an access token, nor the reverse.
 * No dependency: node:crypto HMAC-SHA256, constant-time signature comparison, and the header's `alg` MUST be
 * exactly "HS256" (anything else — "none", "HS512", "RS256"… — is rejected before any signature work).
 */

export interface AccessClaims {
  /** user id */
  readonly sub: string;
  /** active company id */
  readonly cid: string;
  /** refresh session id */
  readonly sid: string;
  /** issued at (seconds since epoch) */
  readonly iat: number;
  /** expiry (seconds since epoch) */
  readonly exp: number;
}

export const ACCESS_PURPOSE = 'access';
export const MFA_PURPOSE = 'mfa';

/** Claims of the pending second-step token (cookie hrf_mfa, 5 minutes). */
export interface MfaPendingClaims {
  /** user id */
  readonly sub: string;
  /** company of the challenge */
  readonly cid: string;
  /** challenge id (auth.mfa_challenge.id) */
  readonly mfa: string;
  readonly iat: number;
  readonly exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function sign(secret: string, input: string): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

function parseJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function signJwt(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = `${HEADER}.${body}`;
  return `${input}.${sign(secret, input).toString('base64url')}`;
}

/** Payload of a valid HS256 token whose `pur` is `purpose` and whose times are valid at `nowSeconds`; else null. */
function verifyJwt(secret: string, token: string, purpose: string, nowSeconds: number): Record<string, unknown> | null {
  if (token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  if (!B64URL.test(h) || !B64URL.test(p) || !B64URL.test(s)) return null;
  const header = parseJson(h);
  if (typeof header !== 'object' || header === null) return null;
  if ((header as Record<string, unknown>)['alg'] !== 'HS256') return null;
  const expected = sign(secret, `${h}.${p}`);
  const actual = Buffer.from(s, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const payload = parseJson(p);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const c = payload as Record<string, unknown>;
  if (c['pur'] !== purpose) return null;
  const { iat, exp } = c;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isInteger(iat) || !Number.isInteger(exp)) return null;
  if (exp <= nowSeconds) return null;
  if (iat > nowSeconds + 60) return null; // issued in the future (clock skew tolerance: 60 s)
  return c;
}

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function signAccessToken(secret: string, claims: AccessClaims): string {
  return signJwt(secret, { ...claims, pur: ACCESS_PURPOSE });
}

/** Returns the claims of a valid, unexpired ACCESS token, or null (malformed, wrong alg/purpose, bad signature, expired…). */
export function verifyAccessToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): AccessClaims | null {
  const c = verifyJwt(secret, token, ACCESS_PURPOSE, nowSeconds);
  if (!c) return null;
  const { sub, cid, sid, iat, exp } = c;
  if (!isUuid(sub) || !isUuid(cid) || !isUuid(sid) || 'mfa' in c) return null;
  return { sub, cid, sid, iat: iat as number, exp: exp as number };
}

export function signMfaPendingToken(secret: string, claims: MfaPendingClaims): string {
  return signJwt(secret, { ...claims, pur: MFA_PURPOSE });
}

/** Returns the claims of a valid, unexpired PENDING MFA token (never an access token), or null. */
export function verifyMfaPendingToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): MfaPendingClaims | null {
  const c = verifyJwt(secret, token, MFA_PURPOSE, nowSeconds);
  if (!c) return null;
  const { sub, cid, mfa, iat, exp } = c;
  if (!isUuid(sub) || !isUuid(cid) || !isUuid(mfa) || 'sid' in c) return null;
  return { sub, cid, mfa, iat: iat as number, exp: exp as number };
}
