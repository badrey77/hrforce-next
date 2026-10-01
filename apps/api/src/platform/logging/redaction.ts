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
  // two-step sign-in (docs/contracts/mfa.md): codes and recovery codes in request bodies, the TOTP secret and its
  // otpauth URI / QR image in responses, the pending cookie. (`code` is redacted in bodies only: elsewhere it names
  // error or unit codes the logs need.)
  'req.body.code',
  'req.body.recoveryCode',
  '*.body.code',
  '*.body.recoveryCode',
  '*.recoveryCode',
  '*.recoveryCodes',
  '*.otpauthUri',
  '*.qrPng',
  '*.hrf_mfa',
  // attendance check-in (docs/contracts/attendance.md): the kiosk credential, the scan receipt, the browser id, and
  // the pairing code of POST /api/kiosk/pair (req.body.code above) — each one is a credential or a personal signal
  '*.hrf_kiosk',
  '*.hrf_scan',
  '*.hrf_dev',
  // SSO (docs/contracts/sso.md › Log redaction): a connected app's secret (create / rotate responses), the OAuth
  // parameters and tokens if a body is ever logged, and the Location of a resume redirect (it carries the code)
  '*.clientSecret',
  '*.client_secret',
  '*.code_verifier',
  '*.id_token',
  '*.id_token_hint',
  '*.access_token',
  'res.headers.location',
  '*.hrf_op_session',
  '*.hrf_op_interaction',
  '*.hrf_op_resume',
  'clientSecret',
  'code',
  'recoveryCode',
  'recoveryCodes',
  'otpauthUri',
  'qrPng',
  'secret',
];

export const REDACT_CENSOR = '[REDACTED]';

/**
 * Query strings can carry personal data (e.g. `GET /api/employees?q=<NIN>` searches by national id number), so the
 * request log keeps the path and the parameter NAMES only: `/api/employees?q=[REDACTED]`.
 */
export function redactQueryString(url: string | undefined): string | undefined {
  if (!url) return url;
  const i = url.indexOf('?');
  if (i < 0) return url;
  const names = url
    .slice(i + 1)
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => `${decodeURIComponentSafe(part.split('=')[0] ?? '')}=${REDACT_CENSOR}`);
  return `${url.slice(0, i)}?${names.join('&')}`;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** pino-http `serializers.req`: receives the already-serialized request and strips query values. */
export function serializeRequestForLog<T extends { url?: string; query?: unknown }>(req: T): T {
  return { ...req, url: redactQueryString(req.url), query: undefined };
}
