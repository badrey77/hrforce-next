/** Pino redaction paths (CONVENTIONS.md › Security). Extend, never shrink. */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-xsrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.secret',
];

export const REDACT_CENSOR = '[REDACTED]';
