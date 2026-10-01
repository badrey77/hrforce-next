/**
 * Response headers of every demo response (docs/contracts/sso.md › Demo sister app › Response headers).
 * No script may run (`default-src 'none'`, no `script-src`). `form-action` also allows the issuer origin, because the
 * sign-out form's POST is answered by a redirect to HRForce and Chrome checks `form-action` on redirects.
 */
import type { NextFunction, Request, Response } from 'express';

export function contentSecurityPolicy(issuer: string): string {
  const issuerOrigin = new URL(issuer).origin;
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    `form-action 'self' ${issuerOrigin}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export function securityHeaders(issuer: string) {
  const csp = contentSecurityPolicy(issuer);
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

/** Parses the Cookie header (no dependency needed for two cookies). Malformed pairs are ignored. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      if (!cookies.has(name)) cookies.set(name, decodeURIComponent(value));
    } catch {
      // not URI-encoded as expected: ignore the cookie
    }
  }
  return cookies;
}
