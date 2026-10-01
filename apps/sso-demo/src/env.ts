/**
 * Environment of the SSO demo (docs/contracts/sso.md › Demo sister app › Environment), validated once at boot.
 * A missing or invalid value stops the process with a readable list of variable names (values are never printed:
 * one of them is the client secret).
 */
import { z } from 'zod';

/** The public development secret of the seeded `sso-demo` client (apps/sso-demo/.env.example). Refused in production. */
export const DEV_CLIENT_SECRET_MARKER = 'INSECURE';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const httpUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.hash && !url.search;
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL without credentials, query or fragment')
  .transform((value) => value.replace(/\/+$/, ''));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    SSO_DEMO_PORT: z.coerce.number().int().min(1).max(65535),
    SSO_DEMO_BASE_URL: httpUrl,
    SSO_DEMO_ISSUER: httpUrl,
    SSO_DEMO_CLIENT_ID: z.string().trim().regex(/^[a-z][a-z0-9-]{2,39}$/, 'must match ^[a-z][a-z0-9-]{2,39}$'),
    SSO_DEMO_CLIENT_SECRET: z.string().min(32, 'must be at least 32 characters'),
    SSO_DEMO_COOKIE_SECURE: z.enum(['true', 'false']).transform((value) => value === 'true'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.SSO_DEMO_ISSUER.startsWith('http://')) {
      ctx.addIssue({ code: 'custom', path: ['SSO_DEMO_ISSUER'], message: 'must use https:// in production' });
    }
    if (env.SSO_DEMO_BASE_URL.startsWith('http://')) {
      ctx.addIssue({ code: 'custom', path: ['SSO_DEMO_BASE_URL'], message: 'must use https:// in production' });
    }
    if (!env.SSO_DEMO_COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['SSO_DEMO_COOKIE_SECURE'], message: 'must be true in production' });
    }
    if (env.SSO_DEMO_CLIENT_SECRET.includes(DEV_CLIENT_SECRET_MARKER)) {
      ctx.addIssue({ code: 'custom', path: ['SSO_DEMO_CLIENT_SECRET'], message: 'the development secret is refused in production' });
    }
  });

export interface DemoEnv {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** without a trailing slash */
  baseUrl: string;
  /** without a trailing slash */
  issuer: string;
  clientId: string;
  clientSecret: string;
  cookieSecure: boolean;
  logLevel: (typeof LOG_LEVELS)[number];
}

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid SSO demo environment:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

/** Parses `source` (usually `process.env`). Throws an {@link EnvError} naming each bad variable, never its value. */
export function loadEnv(source: Record<string, string | undefined>): DemoEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`));
  }
  const env = result.data;
  return {
    nodeEnv: env.NODE_ENV,
    port: env.SSO_DEMO_PORT,
    baseUrl: env.SSO_DEMO_BASE_URL,
    issuer: env.SSO_DEMO_ISSUER,
    clientId: env.SSO_DEMO_CLIENT_ID,
    clientSecret: env.SSO_DEMO_CLIENT_SECRET,
    cookieSecure: env.SSO_DEMO_COOKIE_SECURE,
    logLevel: env.LOG_LEVEL,
  };
}
