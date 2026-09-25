import type { Request, Response } from 'express';

/** Cookie names and paths (docs/contracts/identity.md › Tokens and cookies). */
export const ACCESS_COOKIE = 'hrf_at';
export const REFRESH_COOKIE = 'hrf_rt';
export const XSRF_COOKIE = 'XSRF-TOKEN';
export const XSRF_HEADER = 'x-xsrf-token';

export const ACCESS_COOKIE_PATH = '/api';
export const REFRESH_COOKIE_PATH = '/api/auth';
export const XSRF_COOKIE_PATH = '/';

export interface CookieSpec {
  name: string;
  value: string;
  path: string;
  /** seconds; 0 deletes the cookie */
  maxAge?: number;
  httpOnly: boolean;
  secure: boolean;
}

/**
 * Serialises a Set-Cookie value with exactly the contract's attributes (Express' res.cookie() would add `Expires`
 * and URL-encode). Values are base64url / JWT characters only, so no encoding is needed; anything else is refused.
 */
export function serializeCookie(spec: CookieSpec): string {
  if (!/^[A-Za-z0-9._-]*$/.test(spec.value)) throw new Error(`cookie ${spec.name}: unsafe value`);
  const parts = [`${spec.name}=${spec.value}`];
  if (spec.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(spec.maxAge))}`);
  parts.push(`Path=${spec.path}`);
  if (spec.httpOnly) parts.push('HttpOnly');
  if (spec.secure) parts.push('Secure');
  parts.push('SameSite=Strict');
  return parts.join('; ');
}

export function appendCookie(res: Response, spec: CookieSpec): void {
  res.append('Set-Cookie', serializeCookie(spec));
}

/** A cookie value from cookie-parser's `req.cookies` (undefined without cookie-parser / when absent / not a string). */
export function readCookie(req: Request, name: string): string | undefined {
  const cookies = (req as { cookies?: Record<string, unknown> }).cookies;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
