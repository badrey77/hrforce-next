import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal compact JWS (JWT) with HS256 only — the access token of docs/contracts/identity.md.
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

export function signAccessToken(secret: string, claims: AccessClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${HEADER}.${payload}`;
  return `${input}.${sign(secret, input).toString('base64url')}`;
}

/** Returns the claims of a valid, unexpired token, or null (malformed, wrong alg, bad signature, expired…). */
export function verifyAccessToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): AccessClaims | null {
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
  if (typeof payload !== 'object' || payload === null) return null;
  const c = payload as Record<string, unknown>;
  const { sub, cid, sid, iat, exp } = c;
  if (typeof sub !== 'string' || typeof cid !== 'string' || typeof sid !== 'string') return null;
  if (!UUID.test(sub) || !UUID.test(cid) || !UUID.test(sid)) return null;
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isInteger(iat) || !Number.isInteger(exp)) return null;
  if (exp <= nowSeconds) return null;
  if (iat > nowSeconds + 60) return null; // issued in the future (clock skew tolerance: 60 s)
  return { sub, cid, sid, iat, exp };
}
