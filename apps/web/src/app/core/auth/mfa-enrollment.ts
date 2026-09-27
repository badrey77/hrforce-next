/**
 * Two-step sign-in ENFORCEMENT in the web (docs/contracts/mfa.md › Enforcement / Web): when the company policy
 * requires two-step sign-in and the user has not set it up, every page except `/me/security` sends them to the
 * enrollment wizard, and so does any API call answered 403 `mfa-enrollment-required`.
 *
 * Two doors, one destination (`enrollmentUrlTree()`):
 *
 * 1. **`mfaEnrollmentGuard` — a `canMatch` guard**, listed right after `authGuard` on every signed-in route of
 *    app.routes.ts (the `signedIn` array) and NOT on `/me/security`. It reads `Session.mfaEnrollmentRequired()`, the
 *    `/api/me` answer already in memory, so it costs nothing and runs before any lazy chunk is downloaded (the same
 *    reason `authGuard` is a `canMatch`, see auth.guards.ts). It returns a `UrlTree` — a redirect as ONE navigation —
 *    carrying `?enroll=1&returnUrl=<what they asked for>`, so the wizard can explain why they are there and the page
 *    can continue to that URL once they are enrolled.
 *
 * 2. **`mfaEnrollmentInterceptor` — for what the guard cannot know.** The session is read at sign-in; the policy can
 *    change afterwards (an admin turns enforcement on, or grants a sensitive role). The server then answers 403
 *    `mfa-enrollment-required` to the next call. The interceptor notices that problem on ANY request, reloads the
 *    session (`GET /me` now says `required: true`, so the guard agrees from then on) and navigates to the wizard.
 *    It re-throws the error unchanged: the caller still fails and shows its usual message for the split second before
 *    the navigation replaces the page.
 *
 * Why an interceptor of its own rather than a branch inside `apiProblemInterceptor`: that interceptor has one job
 * (turn every error into an `ApiProblemError`) and no dependencies; navigation needs `Router` and `Session`, and
 * "what the app does about a problem" is a different job from "what shape errors have". Keeping them apart also keeps
 * the problem interceptor trivially testable.
 *
 * Order (app.config.ts): `[mfaEnrollmentInterceptor, apiProblemInterceptor, authRefreshInterceptor]` — this one is the
 * OUTERMOST. Responses travel inside-out, so it sees each error LAST:
 * - after the refresh interceptor: a 401 → refresh → retry that comes back 403 `mfa-enrollment-required` reaches it
 *   (if it sat inside the refresh interceptor it would only ever see the first answer, the 401);
 * - after the problem interceptor: the error is already an `ApiProblemError` with a parsed `type`. (It still accepts a
 *   raw `HttpErrorResponse`, so moving it later in the list cannot silently disable it.)
 * The refresh interceptor never touches a 403, so the two never compete for the same response.
 *
 * Angular concepts: functional guard and interceptor running in an injection context (every `inject()` is synchronous,
 * at the top); a root service (`MfaEnforcement`) holding the "already redirecting" flag, because an interceptor
 * function has no state of its own and five parallel 403s must cause ONE navigation.
 */
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type CanMatchFn, Router, type UrlSegment, type UrlTree } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { isApiProblemError } from '../http/api-problem';
import { AUTH_PROBLEM } from './auth.models';
import { safeReturnUrl } from './return-url';
import { Session } from './session';

/** The page that hosts status, enrollment wizard, recovery codes. */
export const SECURITY_PATH = '/me/security';

function isSecurityUrl(url: string): boolean {
  return url === SECURITY_PATH || url.startsWith(`${SECURITY_PATH}?`) || url.startsWith(`${SECURITY_PATH}#`);
}

/** `/me/security?enroll=1&returnUrl=…` — `returnUrl` only when it is a safe internal path and not the page itself. */
export function enrollmentUrlTree(router: Router, returnUrl?: string): UrlTree {
  const queryParams: Record<string, string> = { enroll: '1' };
  const safe = safeReturnUrl(returnUrl, '');
  if (safe && !isSecurityUrl(safe)) queryParams['returnUrl'] = safe;
  return router.createUrlTree([SECURITY_PATH], { queryParams });
}

/** Signed-in routes: through when enrollment is not required, else to the wizard (see the file header). */
export const mfaEnrollmentGuard: CanMatchFn = (_route, segments: UrlSegment[]) => {
  if (!inject(Session).mfaEnrollmentRequired()) {
    return true;
  }
  const router = inject(Router);
  const attempted = router.currentNavigation()?.extractedUrl;
  const returnUrl = attempted ? router.serializeUrl(attempted) : `/${segments.map((s) => s.path).join('/')}`;
  return enrollmentUrlTree(router, returnUrl);
};

/** Reacts to 403 `mfa-enrollment-required`: one session reload + one navigation, however many calls failed. */
@Injectable({ providedIn: 'root' })
export class MfaEnforcement {
  private readonly router = inject(Router);
  private readonly session = inject(Session);
  private redirecting = false;

  async enrollmentRequired(): Promise<void> {
    const current = this.router.url;
    // When the session ALREADY says "must enroll", the guard is in charge: it redirects every navigation, including
    // the one in flight right now. The shell's own calls (bell, task count…) fail with this 403 during that first
    // navigation, while `router.url` is still the page being left ('/' or '/login'); navigating from here would
    // replace the guard's correct `returnUrl` with that stale one.
    if (this.redirecting || this.session.mfaEnrollmentRequired() || isSecurityUrl(current)) {
      return;
    }
    this.redirecting = true;
    try {
      await this.session.load();
      await this.router.navigateByUrl(enrollmentUrlTree(this.router, current));
    } finally {
      this.redirecting = false;
    }
  }
}

/** Does this error say "set up two-step sign-in first"? Accepts the parsed and the raw form. */
export function isEnrollmentRequired(error: unknown): boolean {
  if (isApiProblemError(error)) {
    return error.status === 403 && error.problem.type === AUTH_PROBLEM.mfaEnrollmentRequired;
  }
  if (error instanceof HttpErrorResponse && error.status === 403) {
    const body: unknown = error.error;
    return typeof body === 'object' && body !== null && 'type' in body && body.type === AUTH_PROBLEM.mfaEnrollmentRequired;
  }
  return false;
}

export const mfaEnrollmentInterceptor: HttpInterceptorFn = (req, next) => {
  const enforcement = inject(MfaEnforcement);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (isEnrollmentRequired(error)) {
        void enforcement.enrollmentRequired();
      }
      return throwError(() => error);
    }),
  );
};
