/**
 * The `HttpClient` features every client of this app shares: the double-submit XSRF names and the interceptor chain.
 *
 * Why a file of its own: the app has TWO `HttpClient`s. The main one (app.config.ts) sends requests with `fetch()`;
 * the upload client (upload-http.ts) sends them with `XMLHttpRequest`, the only browser API that reports UPLOAD
 * progress. Both must behave the same way for everything else — XSRF header, 401 → refresh → retry, problem+json
 * errors, the two-step sign-in redirect — so both build themselves from this one list instead of two copies that could
 * drift apart.
 *
 * Angular concepts:
 * - **`provideHttpClient(...features)`** takes "feature" objects (`withFetch()`, `withXhr()`, `withXsrfConfiguration()`,
 *   `withInterceptors()`…). A feature is just a bundle of providers, so it can be built once and passed to several
 *   `provideHttpClient()` calls.
 * - **Interceptor order = nesting**: the FIRST is the outermost. `apiProblemInterceptor` wraps the refresh logic, so
 *   callers always get an `ApiProblemError`, retry or not (core/auth/auth-refresh.interceptor.ts);
 *   `mfaEnrollmentInterceptor` is outside both: it sees the final error, parsed, after any refresh + retry
 *   (core/auth/mfa-enrollment.ts).
 */
import { type HttpInterceptorFn, withInterceptors, withXsrfConfiguration } from '@angular/common/http';
import { authRefreshInterceptor } from '../auth/auth-refresh.interceptor';
import { mfaEnrollmentInterceptor } from '../auth/mfa-enrollment';
import { apiProblemInterceptor } from './api-problem.interceptor';
import { XSRF_COOKIE_NAME, XSRF_HEADER_NAME } from './xsrf';

export const APP_HTTP_INTERCEPTORS: readonly HttpInterceptorFn[] = [
  mfaEnrollmentInterceptor,
  apiProblemInterceptor,
  authRefreshInterceptor,
];

/** Every feature of the app's clients except the transport (`withFetch()` / `withXhr()`), which the caller picks. */
export function appHttpFeatures() {
  return [
    withXsrfConfiguration({ cookieName: XSRF_COOKIE_NAME, headerName: XSRF_HEADER_NAME }),
    withInterceptors([...APP_HTTP_INTERCEPTORS]),
  ] as const;
}
