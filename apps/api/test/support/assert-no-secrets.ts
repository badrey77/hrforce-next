/** Keys that must never appear in an API response payload (CONVENTIONS.md › Security). */
export const SECRET_KEY_PATTERN = /(password|hash|token|secret)/i;

/** Returns the JSON paths of every key matching {@link SECRET_KEY_PATTERN}. */
export function findSecretKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => findSecretKeys(item, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(SECRET_KEY_PATTERN.test(key) ? [`${path}.${key}`] : []),
    ...findSecretKeys(child, `${path}.${key}`),
  ]);
}

/**
 * Throws if a response body contains a secret-looking key anywhere (objects, arrays, nested). `allowed` lists exact
 * JSON paths a contract mandates (e.g. `$.secret` of POST /api/me/mfa/enroll/start — tools/guardrails/secret-fields-allow.json).
 */
export function assertNoSecrets(body: unknown, allowed: readonly string[] = []): void {
  const found = findSecretKeys(body).filter((p) => !allowed.includes(p));
  if (found.length > 0) throw new Error(`Response contains secret-looking keys: ${found.join(', ')}`);
}
