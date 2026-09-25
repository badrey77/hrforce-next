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
 * No token is ever read here: the cookies are httpOnly (ADR 004); the browser attaches them to same-origin calls.
 */
import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { LoginCredentials, Me, PasswordSetup } from './auth.models';

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

  /** `POST /api/auth/login` → 204 + session cookies. Errors: 401, 423, 429 (Retry-After), 403 account-disabled. */
  login(credentials: LoginCredentials): Observable<void> {
    return this.http.post<void>(`${AUTH_API_BASE}/login`, credentials);
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
