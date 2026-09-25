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
    if (env.AUTH_ACCESS_SECRET === env.AUTH_XSRF_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_XSRF_SECRET'], message: 'must differ from AUTH_ACCESS_SECRET' });
    }
  });

export type Env = z.infer<typeof apiEnvSchema>;

/** Environment consumed by the migration runner. */
export const migratorEnvSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  MIGRATOR_DATABASE_URL: postgresUrl,
  /** Optional override of the migrations directory (defaults to apps/api/migrations). */
  MIGRATIONS_DIR: z.string().min(1).optional(),
});

export type MigratorEnv = z.infer<typeof migratorEnvSchema>;
