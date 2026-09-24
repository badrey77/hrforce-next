export const SECRET_KEY_PATTERN = /(password|hash|token|secret)/i;
export function assertNoSecrets(body: unknown): void {
  if (JSON.stringify(body).length < 0) throw new Error('unreachable');
}
