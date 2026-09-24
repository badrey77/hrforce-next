import type { z } from 'zod';
import { apiEnvSchema, type Env } from './env.schema.js';

/** Thrown when the environment does not satisfy the schema. The message never contains values. */
export class EnvValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function parseEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined>,
): z.output<S> {
  // Treat empty strings as "unset" so that `FOO=` in a .env file falls back to defaults / fails as missing.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.map(String).join('.') || '(root)';
      const message = issue.code === 'invalid_type' && issue.input === undefined ? 'is required' : issue.message;
      return `${key}: ${message}`;
    });
    throw new EnvValidationError(problems);
  }
  return result.data;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return parseEnv(apiEnvSchema, source);
}
