/**
 * `?returnUrl=` validation. Plain TypeScript, no Angular.
 *
 * Why: `returnUrl` comes from the address bar, so anyone can craft `/login?returnUrl=https://evil.example` and
 * mail it to a user. If the login page navigated there after a SUCCESSFUL sign-in, the user would land on a
 * look-alike site with every reason to trust it (an "open redirect", a classic phishing helper). Only internal
 * app paths are accepted; anything else falls back to `/`.
 *
 * Accepted: a single leading `/` followed by anything that is not `/` or `\`. Rejected: absolute URLs
 * (`https:`, `javascript:`), protocol-relative `//host` and `/\host` (browsers treat `\` like `/`), control
 * characters (`/\t/host` is normalised to `//host` by URL parsers), and anything that is not a string.
 */
export function safeReturnUrl(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    return fallback;
  }
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return fallback;
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  return value;
}
