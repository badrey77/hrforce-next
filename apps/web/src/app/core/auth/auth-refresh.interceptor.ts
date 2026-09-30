/**
 * 401 → refresh → retry, per docs/contracts/identity.md › Web.
 *
 * The access cookie lives 15 minutes; the refresh cookie up to 12 h idle. When an `/api` call (other than
 * `/api/auth/*`) comes back 401, this interceptor calls `POST /api/auth/refresh` ONCE for all the requests that
 * failed at the same time, then re-sends each original request once. 409 `refresh-race` (another tab rotated the
 * token a moment earlier and this tab already has the new cookies) counts as success. Any other refresh failure
 * clears the session and navigates to `/login?returnUrl=<current page>`.
 *
 * Angular concepts:
 * - **Functional interceptor (`HttpInterceptorFn`).** `(req, next) => Observable<HttpEvent>`. `next(req)` hands
 *   the request to the rest of the chain; piping on its result lets us react to the response. The function body
 *   runs in an injection context, so `inject()` works there — but only synchronously, which is why every
 *   `inject()` sits at the top and never inside `catchError`.
 * - **Interceptor ORDER.** `withInterceptors([a, b])` makes `a` the OUTER one: a request passes a → b → server,
 *   the response comes back b → a. app.config.ts registers `[apiProblemInterceptor, authRefreshInterceptor]`:
 *   the refresh logic sits closer to the server and sees the raw `HttpErrorResponse` (status 401), and whatever
 *   it finally lets through — the retry's result or the original 401 — is converted to an `ApiProblemError` by
 *   the outer interceptor, so callers see ONE error shape whether or not a refresh happened. The other order
 *   would work too but would make this file depend on problem parsing for no gain.
 *   Angular's own XSRF interceptor is registered by `provideHttpClient()` BEFORE any `withInterceptors()`, so it
 *   is the outermost of all: it stamps `X-XSRF-TOKEN` on the ORIGINAL request only. `next(retried)` below goes
 *   downstream and does not pass it again, hence `withCurrentXsrfToken()`.
 * - **Retry once, without loops.** The retry calls `next(...)`, i.e. only the interceptors AFTER this one and the
 *   backend. This interceptor is not re-entered, so a second 401 on the retry simply reaches the caller.
 * - **Single flight with RxJS `share()`.** See `TokenRefresher`.
 */
import {
  HttpErrorResponse,
  type HttpInterceptorFn,
  type HttpRequest,
  HttpXsrfTokenExtractor,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { type Observable, catchError, finalize, map, of, share, switchMap, throwError } from 'rxjs';
import { isApiProblemError } from '../http/api-problem';
import { XSRF_HEADER_NAME } from '../http/xsrf';
import { AuthApi, SKIP_LOGIN_REDIRECT } from './auth-api';
import { Session } from './session';

/**
 * One refresh at a time, shared by every caller that asks while it is running.
 *
 * `inFlight` caches the Observable of the refresh that is currently running. The first 401 creates it; the
 * second and third 401s (arriving while the POST is pending) get the SAME Observable. `share()` is what makes
 * that one HTTP request rather than three: without it, each `subscribe()` to a cold HttpClient Observable sends
 * the request again. `finalize()` forgets it once it has completed or failed, so a 401 an hour later starts a
 * fresh refresh.
 *
 * `resetOnRefCountZero: false`: if every waiting request is cancelled (the user navigates away mid-refresh),
 * `share()` would normally unsubscribe from its source and abort the POST. Aborting a refresh is dangerous: the
 * server may already have rotated the token, the browser would drop the Set-Cookie, and the next refresh would
 * present the old token — the server's reuse detection would then revoke the whole session. So once started,
 * the refresh always runs to completion.
 *
 * (A shared Promise would give single-flight too; an Observable keeps it composable with `switchMap` below.)
 */
@Injectable({ providedIn: 'root' })
export class TokenRefresher {
  private readonly api = inject(AuthApi);
  private readonly session = inject(Session);
  private inFlight: Observable<void> | null = null;

  refresh(): Observable<void> {
    this.inFlight ??= this.api.refresh().pipe(
      map(() => undefined),
      catchError((error: unknown) => {
        if (statusOf(error) === 409) {
          // refresh-race: another tab won; the new cookies are already set. Nothing to do but retry.
          return of(undefined);
        }
        this.session.clear();
        return throwError(() => error);
      }),
      finalize(() => {
        this.inFlight = null;
      }),
      share({ resetOnRefCountZero: false }),
    );
    return this.inFlight;
  }
}

export const authRefreshInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isRefreshable(req.url)) {
    return next(req);
  }
  const refresher = inject(TokenRefresher);
  const router = inject(Router);
  const xsrf = inject(HttpXsrfTokenExtractor);

  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }
      return refresher.refresh().pipe(
        catchError(() => {
          if (!req.context.get(SKIP_LOGIN_REDIRECT)) {
            redirectToLogin(router);
          }
          // The caller sees the ORIGINAL 401 (converted to an ApiProblemError by the outer interceptor).
          return throwError(() => error);
        }),
        switchMap(() => next(withCurrentXsrfToken(req, xsrf.getToken()))),
      );
    }),
  );
};

/**
 * `/api/...` except `/api/auth/...` (a 401 from login/refresh/logout is an answer, not an expired token) and
 * `/api/kiosk/...` (docs/contracts/attendance.md › Kiosk: the entrance tablet has no user session; its 401 means
 * "not paired", and a refresh + /login redirect would pull the kiosk screen away from the pairing form).
 */
export function isRefreshable(url: string): boolean {
  return (
    (url === '/api' || url.startsWith('/api/') || url.startsWith('/api?')) &&
    !url.startsWith('/api/auth/') &&
    !url.startsWith('/api/kiosk/')
  );
}

/** Refresh re-issues `XSRF-TOKEN` (it is bound to the new session id): re-stamp a request that carried the old one. */
function withCurrentXsrfToken<T>(req: HttpRequest<T>, token: string | null): HttpRequest<T> {
  if (token === null || !req.headers.has(XSRF_HEADER_NAME)) {
    return req;
  }
  return req.clone({ headers: req.headers.set(XSRF_HEADER_NAME, token) });
}

function redirectToLogin(router: Router): void {
  const current = router.url;
  if (current === '/login' || current.startsWith('/login?')) {
    return;
  }
  void router.navigate(['/login'], { queryParams: { returnUrl: current } });
}

function statusOf(error: unknown): number | undefined {
  if (isApiProblemError(error)) return error.status;
  if (error instanceof HttpErrorResponse) return error.status;
  return undefined;
}
