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

/** NODE_ENV values in which the development identity (DEV_AUTH) may be enabled. */
export const DEV_AUTH_ALLOWED_NODE_ENVS: readonly string[] = ['development', 'test'];

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
})
  .superRefine((env, ctx) => {
    if (env.DEV_AUTH && !DEV_AUTH_ALLOWED_NODE_ENVS.includes(env.NODE_ENV)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEV_AUTH'],
        message: `may only be true when NODE_ENV is ${DEV_AUTH_ALLOWED_NODE_ENVS.join(' or ')}`,
      });
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
