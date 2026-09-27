/**
 * AuthApi — the Identity endpoints under `/api/auth` plus `GET /api/me` (docs/contracts/identity.md).
 *
 * Angular concepts:
 * - **A root service wrapping `HttpClient`.** `@Injectable({ providedIn: 'root' })` registers one app-wide
 *   instance; `inject(HttpClient)` asks the dependency-injection system for the `HttpClient` configured in
 *   app.config.ts (fetch transport, XSRF, interceptors). Every call below therefore gets the `X-XSRF-TOKEN`
 *   header on POSTs and the problem+json error mapping, without this file knowing about either.
 * - **Cold Observables.** Each method returns an Observable that sends NOTHING until someone subscribes (and
 *   sends again for each new subscriber). Callers decide when: the login page subscribes on submit, the refresh
 *   interceptor wraps `refresh()` in a shared single-flight Observable (auth-refresh.interceptor.ts).
 * - **`HttpContext`.** A per-request bag of typed flags that interceptors can read but the server never sees.
 *   `me()` uses it to tell the refresh interceptor "do not redirect to /login if this fails" (see
 *   `SKIP_LOGIN_REDIRECT`), because the startup session check must be allowed to fail quietly.
 *
 * - **`observe: 'response'`** (on `login()`). By default `HttpClient` hands you only the parsed BODY. The login
 *   answer means different things by STATUS (204 = signed in, 200 `{mfaRequired: true}` = a code is needed next,
 *   docs/contracts/mfa.md), so `login()` asks for the whole `HttpResponse` and maps it to a small union
 *   (`LoginOutcome`) with RxJS `map`. Callers never see HTTP details, and a missing/odd body falls back to
 *   "signed in" only when the status is 204.
 *
 * No token is ever read here: the cookies are httpOnly (ADR 004); the browser attaches them to same-origin calls.
 */
import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type Observable, map } from 'rxjs';
import type { LoginCredentials, LoginOutcome, Me, MfaVerification, PasswordSetup } from './auth.models';

export const AUTH_API_BASE = '/api/auth';
export const ME_URL = '/api/me';

/**
 * `HttpContextToken`: a typed key with a default value (`false` here). A request that does not set it reads the
 * default. Set to `true` when a failed refresh should just fail the request instead of sending the user to /login.
 */
export const SKIP_LOGIN_REDIRECT = new HttpContextToken<boolean>(() => false);

@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/auth/csrf` → 204; makes sure the `XSRF-TOKEN` cookie exists before the first POST. */
  csrf(): Observable<void> {
    return this.http.get<void>(`${AUTH_API_BASE}/csrf`);
  }

  /**
   * `POST /api/auth/login` → 204 + session cookies (`'signed-in'`), or 200 `{mfaRequired: true}` + the short-lived
   * `hrf_mfa` cookie (`'mfa-required'`: call `verifyMfa()` next). Errors: 401, 423, 429 (Retry-After), 403.
   */
  login(credentials: LoginCredentials): Observable<LoginOutcome> {
    return this.http
      .post<{ mfaRequired?: boolean } | null>(`${AUTH_API_BASE}/login`, credentials, { observe: 'response' })
      .pipe(map((response) => (response.status === 200 && response.body?.mfaRequired === true ? 'mfa-required' : 'signed-in')));
  }

  /**
   * `POST /api/auth/mfa/verify` `{code}` or `{recoveryCode}` → 204 + session cookies. The browser sends the `hrf_mfa`
   * cookie by itself (it is scoped to `Path=/api/auth/mfa`). 401 `mfa-invalid` (try again) or
   * `mfa-challenge-expired` (start over at the password); 423/429 lockout like login.
   */
  verifyMfa(body: MfaVerification): Observable<void> {
    return this.http.post<void>(`${AUTH_API_BASE}/mfa/verify`, body);
  }

  /** `POST /api/auth/logout` → 204; revokes the session family and clears the cookies. */
  logout(): Observable<void> {
    return this.http.post<void>(`${AUTH_API_BASE}/logout`, null);
  }

  /** `POST /api/auth/refresh` → 204 rotated cookies; 401 session-expired; 409 refresh-race. */
  refresh(): Observable<void> {
    return this.http.post<void>(`${AUTH_API_BASE}/refresh`, null);
  }

  /** `POST /api/auth/password/forgot` → 202 whatever the address (no account enumeration). */
  forgotPassword(email: string): Observable<void> {
    return this.http.post<void>(`${AUTH_API_BASE}/password/forgot`, { email });
  }

  /** `POST /api/auth/password/setup` → 204; 410 token-invalid; 422 `errors[{field:'password', code}]`. */
  setupPassword(body: PasswordSetup): Observable<void> {
    return this.http.post<void>(`${AUTH_API_BASE}/password/setup`, body);
  }

  /**
   * `GET /api/me` → the signed-in user and company. 401 when signed out. The refresh interceptor still tries a
   * refresh first (an expired 15-minute access token is the normal case after a break), but never redirects.
   */
  me(): Observable<Me> {
    return this.http.get<Me>(ME_URL, { context: new HttpContext().set(SKIP_LOGIN_REDIRECT, true) });
  }
}
