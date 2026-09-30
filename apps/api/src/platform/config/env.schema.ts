import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: 'must be a postgres:// or postgresql:// connection URL',
  });

/** Boolean flag: accepts true/false/1/0 (case-insensitive). Anything else is invalid, never silently false. */
const booleanFlag = z
  .string()
  .regex(/^(true|false|1|0)$/i, 'must be true or false')
  .transform((value) => value.toLowerCase() === 'true' || value === '1');

/** NODE_ENV values in which the development-only switches (DEV_AUTH, DEV_PERMISSIONS, MAIL_TRANSPORT=log, COOKIE_SECURE=false) may be used. */
export const DEV_AUTH_ALLOWED_NODE_ENVS: readonly string[] = ['development', 'test'];

const secret32 = z.string().min(32, 'must be at least 32 characters');

/**
 * Development/test default of AUTH_MFA_KEY. INSECURE: it is public (in the repository); production refuses to start
 * without its own key.
 */
export const DEV_MFA_KEY = 'aHJmb3JjZS1kZXYtbWZhLWtleS1JTlNFQ1VSRS0wMDE=';

/**
 * Development/test default of ATTENDANCE_KEY (docs/contracts/attendance.md › Check-in). INSECURE: it is public (in the
 * repository); production refuses to start without its own key.
 */
export const DEV_ATTENDANCE_KEY = 'aHJmb3JjZS1kZXYtYXR0ZW5kYW5jZS1rZXktSU5TRUM=';

/** Standard base64 of exactly 32 bytes (the AES-256-GCM key of the TOTP secrets, the attendance HMAC key). */
export function isMfaKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  return Buffer.from(value, 'base64').length === 32;
}

const httpUrl = z
  .string()
  .min(1)
  .refine((value) => /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(value), { message: 'must be an http(s):// URL without query or fragment' })
  .transform((value) => value.replace(/\/+$/, ''));

const smtpUrl = z
  .string()
  .min(1)
  .refine((value) => /^smtps?:\/\//.test(value), { message: 'must be an smtp:// or smtps:// URL' });

/** Environment consumed by the HTTP API process. */
export const apiEnvSchema = z
  .object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Connection URL for the `hrforce_app` role (DML only, subject to RLS). */
  DATABASE_URL: postgresUrl,
  /** Connection URL for the `hrforce_migrator` role. Only required by `npm run migrate`. */
  MIGRATOR_DATABASE_URL: postgresUrl.optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** Secret used to sign cookies. */
  COOKIE_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /** Express "trust proxy" setting: number of hops in front of the API (0 = none). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /**
   * Development identity (until the Identity module exists): X-Dev-User-Id / X-Dev-Company-Id headers are the
   * caller and every permission is granted. Refused unless NODE_ENV is development or test.
   */
  DEV_AUTH: booleanFlag.default(false),
  /**
   * `allow_all`: every AUTHENTICATED caller holds every permission (until the Authorization module exists).
   * Refused unless NODE_ENV is development or test. Unset = deny all (protected routes 403).
   */
  DEV_PERMISSIONS: z.enum(['allow_all']).optional(),
  /** HS256 key of the access token (cookie hrf_at). */
  AUTH_ACCESS_SECRET: secret32,
  /** HMAC key of the signed double-submit XSRF token (cookie XSRF-TOKEN). Must differ from AUTH_ACCESS_SECRET. */
  AUTH_XSRF_SECRET: secret32,
  /**
   * AES-256-GCM key encrypting the users' TOTP secrets (docs/contracts/mfa.md): base64 of exactly 32 bytes
   * (`openssl rand -base64 32`). Required in production; development/test fall back to {@link DEV_MFA_KEY} (insecure).
   */
  AUTH_MFA_KEY: z.string().refine(isMfaKey, { message: 'must be the base64 encoding of exactly 32 bytes (openssl rand -base64 32)' }).optional(),
  /**
   * HMAC key of the attendance check-in (docs/contracts/attendance.md › Check-in, ADR 009): the QR tokens, the scan
   * receipts and the per-browser device references are keyed by subkeys of it. Base64 of exactly 32 bytes
   * (`openssl rand -base64 32`). Required in production; development/test fall back to {@link DEV_ATTENDANCE_KEY}
   * (insecure). Rotating it only invalidates the live codes (≤ 2 min) and receipts (≤ 5 min).
   */
  ATTENDANCE_KEY: z.string().refine(isMfaKey, { message: 'must be the base64 encoding of exactly 32 bytes (openssl rand -base64 32)' }).optional(),
  /** `Secure` flag on every cookie. false is only accepted when NODE_ENV is development or test. */
  COOKIE_SECURE: booleanFlag.default(true),
  /** Public base URL of the web app, used in mailed links (`${WEB_BASE_URL}/password/setup?token=…`). */
  WEB_BASE_URL: httpUrl,
  /** smtp (nodemailer → SMTP_URL) or log (writes mails to the logger; development/test only). */
  MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),
  /** Required when MAIL_TRANSPORT=smtp, e.g. smtp://localhost:1025 (Mailpit). */
  SMTP_URL: smtpUrl.optional(),
  /** From header of outgoing mail. */
  MAIL_FROM: z.string().min(3).default('HRForce <no-reply@hrforce.invalid>'),
  /** PDF rendering (ADR 008): a render taking longer is killed and answered 503 `document-render-failed`. */
  PDF_RENDER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  /** Renderer threads per API process (each holds its own Typst compiler and fonts, ~50 MB). */
  PDF_RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /** Directory holding `fonts/` and `templates/` (default: apps/api/assets/pdf, resolved from the package root). */
  PDF_ASSETS_DIR: z.string().min(1).optional(),
  /**
   * Largest employee-file upload in bytes (docs/contracts/documents.md › Phase B): default 10 MB, at most 20 MB (the
   * database's limit). The multipart reader stops at this size; the reverse proxy allows 25 MB on the upload route.
   */
  EMPLOYEE_FILE_MAX_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(10 * 1024 * 1024),
})
  .superRefine((env, ctx) => {
    const devOnly = (path: string, message: string) => {
      if (!DEV_AUTH_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
        ctx.addIssue({ code: 'custom', path: [path], message: `${message} when NODE_ENV is ${DEV_AUTH_ALLOWED_NODE_ENVS.join(' or ')}` });
      }
    };
    if (env.DEV_AUTH) devOnly('DEV_AUTH', 'may only be true');
    if (env.DEV_PERMISSIONS !== undefined) devOnly('DEV_PERMISSIONS', 'may only be set');
    if (!env.COOKIE_SECURE) devOnly('COOKIE_SECURE', 'may only be false');
    if (env.MAIL_TRANSPORT === 'log') devOnly('MAIL_TRANSPORT', 'may only be log');
    if (env.MAIL_TRANSPORT === 'smtp' && env.SMTP_URL === undefined) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'is required when MAIL_TRANSPORT is smtp' });
    }
    if (env.AUTH_MFA_KEY === undefined && !DEV_AUTH_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MFA_KEY'], message: 'is required when NODE_ENV is production' });
    }
    if (env.AUTH_MFA_KEY !== undefined && env.AUTH_MFA_KEY === DEV_MFA_KEY && !DEV_AUTH_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_MFA_KEY'], message: 'must not be the public development key' });
    }
    if (env.ATTENDANCE_KEY === undefined && !DEV_AUTH_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
      ctx.addIssue({ code: 'custom', path: ['ATTENDANCE_KEY'], message: 'is required when NODE_ENV is production' });
    }
    if (env.ATTENDANCE_KEY !== undefined && env.ATTENDANCE_KEY === DEV_ATTENDANCE_KEY && !DEV_AUTH_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
      ctx.addIssue({ code: 'custom', path: ['ATTENDANCE_KEY'], message: 'must not be the public development key' });
    }
    if (env.AUTH_ACCESS_SECRET === env.AUTH_XSRF_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_XSRF_SECRET'], message: 'must differ from AUTH_ACCESS_SECRET' });
    }
  });

export type Env = z.infer<typeof apiEnvSchema>;

/**
 * Environment consumed by the background worker (`node dist/worker.js`, docs/contracts/notifications.md › Worker).
 * It reuses the API's mail settings and WEB_BASE_URL (links in notification e-mails).
 */
export const workerEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** Connection URL for the `hrforce_worker` role (subject to RLS; each job sets app.company_id). */
    WORKER_DATABASE_URL: postgresUrl,
    /** Jobs run at the same time. */
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
    /** File touched after each successful database check (container health: dist/worker-health.js). */
    WORKER_HEARTBEAT_FILE: z.string().min(1).default('/tmp/hrforce-worker.alive'),
    WEB_BASE_URL: httpUrl,
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('smtp'),
    SMTP_URL: smtpUrl.optional(),
    MAIL_FROM: z.string().min(3).default('HRForce <no-reply@hrforce.invalid>'),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_TRANSPORT === 'log' && !DEV_AUTH_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: `may only be log when NODE_ENV is ${DEV_AUTH_ALLOWED_NODE_ENVS.join(' or ')}` });
    }
    if (env.MAIL_TRANSPORT === 'smtp' && env.SMTP_URL === undefined) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'is required when MAIL_TRANSPORT is smtp' });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Environment consumed by the migration runner. */
export const migratorEnvSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  MIGRATOR_DATABASE_URL: postgresUrl,
  /** Optional override of the migrations directory (defaults to apps/api/migrations). */
  MIGRATIONS_DIR: z.string().min(1).optional(),
});

export type MigratorEnv = z.infer<typeof migratorEnvSchema>;
