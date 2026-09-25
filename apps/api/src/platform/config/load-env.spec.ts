import { describe, expect, it } from 'vitest';
import { migratorEnvSchema } from './env.schema.js';
import { EnvValidationError, loadEnv, parseEnv } from './load-env.js';

const valid = {
  DATABASE_URL: 'postgres://hrforce_app:pw@localhost:5432/hrforce',
  COOKIE_SECRET: 'x'.repeat(32),
};

describe('loadEnv', () => {
  it('applies defaults to a minimal valid environment', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'info', DB_POOL_MAX: 10 });
  });

  it('coerces numeric values', () => {
    expect(loadEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails fast listing every missing or invalid variable', () => {
    let error: unknown;
    try {
      loadEnv({ PORT: 'abc', NODE_ENV: 'staging' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const message = (error as EnvValidationError).message;
    expect(message).toContain('DATABASE_URL: is required');
    expect(message).toContain('COOKIE_SECRET: is required');
    expect(message).toContain('PORT:');
    expect(message).toContain('NODE_ENV:');
  });

  it('rejects a short COOKIE_SECRET without echoing its value', () => {
    expect(() => loadEnv({ ...valid, COOKIE_SECRET: 'tooshort-secret-value' })).toThrowError(
      /COOKIE_SECRET: must be at least 32 characters/,
    );
    try {
      loadEnv({ ...valid, COOKIE_SECRET: 'tooshort-secret-value' });
    } catch (e) {
      expect((e as Error).message).not.toContain('tooshort-secret-value');
    }
  });

  it('rejects non-postgres database URLs', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: 'mysql://x' })).toThrowError(/DATABASE_URL: must be a postgres/);
  });

  it('treats empty strings as unset', () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: '' })).toThrowError(/DATABASE_URL: is required/);
    expect(loadEnv({ ...valid, PORT: '' }).PORT).toBe(3000);
  });

  it('DEV_AUTH defaults to false and parses true/false strictly', () => {
    expect(loadEnv(valid).DEV_AUTH).toBe(false);
    expect(loadEnv({ ...valid, DEV_AUTH: 'true' }).DEV_AUTH).toBe(true);
    expect(loadEnv({ ...valid, DEV_AUTH: 'FALSE' }).DEV_AUTH).toBe(false);
    expect(loadEnv({ ...valid, NODE_ENV: 'test', DEV_AUTH: '1' }).DEV_AUTH).toBe(true);
    expect(() => loadEnv({ ...valid, DEV_AUTH: 'yes' })).toThrowError(/DEV_AUTH: must be true or false/);
  });

  it('refuses DEV_AUTH=true unless NODE_ENV is development or test', () => {
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', DEV_AUTH: 'true' })).toThrowError(
      /DEV_AUTH: may only be true when NODE_ENV is development or test/,
    );
    expect(loadEnv({ ...valid, NODE_ENV: 'production', DEV_AUTH: 'false' }).DEV_AUTH).toBe(false);
  });

  it('validates the migrator environment separately', () => {
    expect(() => parseEnv(migratorEnvSchema, {})).toThrowError(/MIGRATOR_DATABASE_URL: is required/);
    expect(parseEnv(migratorEnvSchema, { MIGRATOR_DATABASE_URL: 'postgresql://m@h/db' }).LOG_LEVEL).toBe('info');
  });
});
