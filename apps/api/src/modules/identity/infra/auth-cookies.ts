import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import {
  ACCESS_COOKIE,
  ACCESS_COOKIE_PATH,
  appendCookie,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  XSRF_COOKIE,
  XSRF_COOKIE_PATH,
} from '../../../platform/security/cookies.js';
import { ANON_BINDING, issueXsrfToken } from '../../../platform/security/xsrf.js';
import { ACCESS_TOKEN_TTL_SECONDS } from '../domain/account.js';

/**
 * Writes the three cookies exactly as docs/contracts/identity.md › Tokens and cookies:
 *   hrf_at      HttpOnly; SameSite=Strict; Path=/api;      Max-Age=900
 *   hrf_rt      HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=<remaining absolute lifetime>
 *   XSRF-TOKEN  (readable by JS) SameSite=Strict; Path=/   (session cookie)
 * plus `Secure` on every cookie when COOKIE_SECURE=true.
 */
@Injectable()
export class AuthCookies {
  constructor(@Inject(ENV) private readonly env: Env) {}

  setSession(res: Response, session: { access: string; refresh: string; refreshMaxAgeSeconds: number; sid: string }): void {
    const secure = this.env.COOKIE_SECURE;
    appendCookie(res, { name: ACCESS_COOKIE, value: session.access, path: ACCESS_COOKIE_PATH, maxAge: ACCESS_TOKEN_TTL_SECONDS, httpOnly: true, secure });
    appendCookie(res, {
      name: REFRESH_COOKIE,
      value: session.refresh,
      path: REFRESH_COOKIE_PATH,
      maxAge: session.refreshMaxAgeSeconds,
      httpOnly: true,
      secure,
    });
    this.setXsrf(res, session.sid);
  }

  /** Deletes hrf_at / hrf_rt and issues a fresh anon XSRF token. */
  clearSession(res: Response): void {
    const secure = this.env.COOKIE_SECURE;
    appendCookie(res, { name: ACCESS_COOKIE, value: '', path: ACCESS_COOKIE_PATH, maxAge: 0, httpOnly: true, secure });
    appendCookie(res, { name: REFRESH_COOKIE, value: '', path: REFRESH_COOKIE_PATH, maxAge: 0, httpOnly: true, secure });
    this.setXsrf(res, null);
  }

  /** New XSRF-TOKEN signed for `sid` (null = anon). */
  setXsrf(res: Response, sid: string | null): void {
    const value = issueXsrfToken(this.env.AUTH_XSRF_SECRET, sid ?? ANON_BINDING);
    appendCookie(res, { name: XSRF_COOKIE, value, path: XSRF_COOKIE_PATH, httpOnly: false, secure: this.env.COOKIE_SECURE });
  }
}
