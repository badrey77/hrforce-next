import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const postgresUrl = z
  .string()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), {
    message: 'must be a postgres:// or postgresql:// connection URL',
  });

/** Environment consumed by the HTTP API process. */
export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
