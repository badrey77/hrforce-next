import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed double-submit XSRF token (docs/contracts/identity.md › Tokens and cookies):
 *   value = `<random>.<hmac>` where hmac = base64url(HMAC-SHA256(AUTH_XSRF_SECRET, random + '.' + binding))
 * and binding = the caller's refresh session id (`sid`), or 'anon' without a session.
 */
export const ANON_BINDING = 'anon';

const PART = /^[A-Za-z0-9_-]{16,128}$/;

function mac(secret: string, random: string, binding: string): Buffer {
  return createHmac('sha256', secret).update(`${random}.${binding}`).digest();
}

export function issueXsrfToken(secret: string, binding: string): string {
  const random = randomBytes(32).toString('base64url');
  return `${random}.${mac(secret, random, binding).toString('base64url')}`;
}

/** True iff `token` is well-formed and signed for `binding`. Constant-time on the signature. */
export function verifyXsrfToken(secret: string, token: string, binding: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [random, signature] = parts as [string, string];
  if (!PART.test(random) || !PART.test(signature)) return false;
  const expected = mac(secret, random, binding);
  const actual = Buffer.from(signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True iff the token verifies for at least one of the bindings. */
export function verifyXsrfTokenForAny(secret: string, token: string, bindings: readonly string[]): boolean {
  return bindings.some((binding) => verifyXsrfToken(secret, token, binding));
}
