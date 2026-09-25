/** Pino redaction paths (CONVENTIONS.md › Security). Extend, never shrink. */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-xsrf-token"]',
  // Every API call made from the web's /password/setup?token=… page would otherwise log the live single-use
  // setup/reset token through the Referer (the web also sends no Referer: index.html referrer policy).
  'req.headers.referer',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.refreshToken',
  '*.secret',
  // request bodies (login / password setup) and parsed cookies (hrf_at, hrf_rt, XSRF-TOKEN), if ever logged
  'req.body.password',
  'req.body.token',
  '*.body.password',
  '*.body.token',
  'req.cookies',
  '*.cookies',
  '*.hrf_at',
  '*.hrf_rt',
  '*["XSRF-TOKEN"]',
];

export const REDACT_CENSOR = '[REDACTED]';
