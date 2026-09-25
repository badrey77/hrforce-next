/**
 * The double-submit XSRF names from ADR 004 / docs/contracts/identity.md, used by `withXsrfConfiguration()` in
 * app.config.ts and by the refresh interceptor when it re-sends a request after the cookie was re-issued.
 */
export const XSRF_COOKIE_NAME = 'XSRF-TOKEN';
export const XSRF_HEADER_NAME = 'X-XSRF-TOKEN';
