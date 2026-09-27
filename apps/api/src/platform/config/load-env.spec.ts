import { describe, expect, it } from 'vitest';
import { DEV_MFA_KEY, isMfaKey, migratorEnvSchema, workerEnvSchema } from './env.schema.js';
import { EnvValidationError, loadEnv, parseEnv } from './load-env.js';

const valid = {
  DATABASE_URL: 'postgres://hrforce_app:pw@localhost:5432/hrforce',
  COOKIE_SECRET: 'x'.repeat(32),
  AUTH_ACCESS_SECRET: 'a'.repeat(32),
  AUTH_XSRF_SECRET: 'b'.repeat(32),
  WEB_BASE_URL: 'https://hr.example.dz',
  SMTP_URL: 'smtp://mail.example.dz:587',
  AUTH_MFA_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const dev = { ...valid, NODE_ENV: 'development' };

describe('loadEnv', () => {
  it('AUTH_MFA_KEY: base64 of exactly 32 bytes; required in production (not the dev key); optional in development/test', () => {
    const { AUTH_MFA_KEY: _key, ...withoutKey } = valid;
    expect(() => loadEnv(withoutKey)).toThrow(/AUTH_MFA_KEY: is required when NODE_ENV is production/);
    expect(() => loadEnv({ ...valid, AUTH_MFA_KEY: DEV_MFA_KEY })).toThrow(/AUTH_MFA_KEY: must not be the public development key/);
    for (const bad of [Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), 'x'.repeat(44), `${valid.AUTH_MFA_KEY.slice(0, -1)}`]) {
      expect(() => loadEnv({ ...valid, AUTH_MFA_KEY: bad })).toThrow(/AUTH_MFA_KEY: must be the base64 encoding of exactly 32 bytes/);
    }
    expect(loadEnv(valid).AUTH_MFA_KEY).toBe(valid.AUTH_MFA_KEY);
    expect(loadEnv({ ...withoutKey, NODE_ENV: 'development' }).AUTH_MFA_KEY).toBeUndefined();
    expect(isMfaKey(DEV_MFA_KEY)).toBe(true);
  });

  it('applies defaults to a minimal valid environment', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ NODE_ENV: 'production', PORT: 3000, LOG_LEVEL: 'info', DB_POOL_MAX: 10 });
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
    expect(message).toContain('AUTH_ACCESS_SECRET: is required');
    expect(message).toContain('AUTH_XSRF_SECRET: is required');
    expect(message).toContain('WEB_BASE_URL: is required');
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
    expect(loadEnv({ ...valid, NODE_ENV: 'development', DEV_AUTH: 'true' }).DEV_AUTH).toBe(true);
    expect(loadEnv({ ...valid, DEV_AUTH: 'FALSE' }).DEV_AUTH).toBe(false);
    expect(loadEnv({ ...valid, NODE_ENV: 'test', DEV_AUTH: '1' }).DEV_AUTH).toBe(true);
    expect(() => loadEnv({ ...valid, DEV_AUTH: 'yes' })).toThrowError(/DEV_AUTH: must be true or false/);
  });

  it('refuses DEV_AUTH=true unless NODE_ENV is development or test', () => {
    expect(() => loadEnv({ ...valid, DEV_AUTH: 'true' })).toThrowError(/DEV_AUTH: may only be true/); // NODE_ENV unset → production
    expect(() => loadEnv({ ...valid, NODE_ENV: 'production', DEV_AUTH: 'true' })).toThrowError(
      /DEV_AUTH: may only be true when NODE_ENV is development or test/,
    );
    expect(loadEnv({ ...valid, NODE_ENV: 'production', DEV_AUTH: 'false' }).DEV_AUTH).toBe(false);
  });

  it('identity defaults: secure cookies, smtp transport, no dev permissions; WEB_BASE_URL loses its trailing slash', () => {
    const env = loadEnv({ ...valid, WEB_BASE_URL: 'https://hr.example.dz/app/' });
    expect(env).toMatchObject({ COOKIE_SECURE: true, MAIL_TRANSPORT: 'smtp', WEB_BASE_URL: 'https://hr.example.dz/app' });
    expect(env.DEV_PERMISSIONS).toBeUndefined();
    expect(env.MAIL_FROM).toContain('@');
  });

  it('auth secrets must be ≥ 32 characters and different', () => {
    expect(() => loadEnv({ ...valid, AUTH_ACCESS_SECRET: 'short' })).toThrowError(/AUTH_ACCESS_SECRET: must be at least 32/);
    expect(() => loadEnv({ ...valid, AUTH_XSRF_SECRET: 'short' })).toThrowError(/AUTH_XSRF_SECRET: must be at least 32/);
    expect(() => loadEnv({ ...valid, AUTH_XSRF_SECRET: valid.AUTH_ACCESS_SECRET })).toThrowError(/AUTH_XSRF_SECRET: must differ/);
  });

  it('refuses the development-only switches outside development/test', () => {
    expect(() => loadEnv({ ...valid, DEV_PERMISSIONS: 'allow_all' })).toThrowError(/DEV_PERMISSIONS: may only be set when NODE_ENV/);
    expect(() => loadEnv({ ...valid, COOKIE_SECURE: 'false' })).toThrowError(/COOKIE_SECURE: may only be false when NODE_ENV/);
    expect(() => loadEnv({ ...valid, MAIL_TRANSPORT: 'log' })).toThrowError(/MAIL_TRANSPORT: may only be log when NODE_ENV/);
    expect(() => loadEnv({ ...dev, DEV_PERMISSIONS: 'grant_everything' })).toThrowError(/DEV_PERMISSIONS/);
    expect(loadEnv({ ...dev, DEV_PERMISSIONS: 'allow_all', COOKIE_SECURE: 'false', MAIL_TRANSPORT: 'log' })).toMatchObject({
      DEV_PERMISSIONS: 'allow_all',
      COOKIE_SECURE: false,
      MAIL_TRANSPORT: 'log',
    });
  });

  it('SMTP_URL is required with MAIL_TRANSPORT=smtp and must be smtp(s)://; WEB_BASE_URL must be http(s)', () => {
    const { SMTP_URL: _omit, ...noSmtp } = valid;
    expect(() => loadEnv(noSmtp)).toThrowError(/SMTP_URL: is required when MAIL_TRANSPORT is smtp/);
    expect(loadEnv({ ...dev, SMTP_URL: '', MAIL_TRANSPORT: 'log' }).SMTP_URL).toBeUndefined();
    expect(() => loadEnv({ ...valid, SMTP_URL: 'http://x' })).toThrowError(/SMTP_URL: must be an smtp/);
    expect(() => loadEnv({ ...valid, WEB_BASE_URL: 'javascript:alert(1)' })).toThrowError(/WEB_BASE_URL/);
  });

  it('validates the migrator environment separately', () => {
    expect(() => parseEnv(migratorEnvSchema, {})).toThrowError(/MIGRATOR_DATABASE_URL: is required/);
    expect(parseEnv(migratorEnvSchema, { MIGRATOR_DATABASE_URL: 'postgresql://m@h/db' }).LOG_LEVEL).toBe('info');
  });
});

describe('workerEnvSchema', () => {
  const worker = { WORKER_DATABASE_URL: 'postgres://hrforce_worker:pw@localhost:5432/hrforce', WEB_BASE_URL: 'https://hr.example.dz', SMTP_URL: 'smtp://mail.example.dz:587' };

  it('applies the defaults (concurrency 4, heartbeat file) and validates WORKER_CONCURRENCY', () => {
    expect(parseEnv(workerEnvSchema, worker)).toMatchObject({ WORKER_CONCURRENCY: 4, WORKER_HEARTBEAT_FILE: '/tmp/hrforce-worker.alive', NODE_ENV: 'production' });
    expect(parseEnv(workerEnvSchema, { ...worker, WORKER_CONCURRENCY: '8' }).WORKER_CONCURRENCY).toBe(8);
    expect(() => parseEnv(workerEnvSchema, { ...worker, WORKER_CONCURRENCY: '0' })).toThrow(/WORKER_CONCURRENCY/);
    expect(() => parseEnv(workerEnvSchema, { ...worker, WORKER_CONCURRENCY: '100' })).toThrow(/WORKER_CONCURRENCY/);
  });

  it('requires WORKER_DATABASE_URL (a postgres URL) and refuses the log transport in production', () => {
    expect(() => parseEnv(workerEnvSchema, { ...worker, WORKER_DATABASE_URL: undefined })).toThrow(/WORKER_DATABASE_URL: is required/);
    expect(() => parseEnv(workerEnvSchema, { ...worker, WORKER_DATABASE_URL: 'mysql://x' })).toThrow(/WORKER_DATABASE_URL/);
    expect(() => parseEnv(workerEnvSchema, { ...worker, MAIL_TRANSPORT: 'log' })).toThrow(/MAIL_TRANSPORT/);
    expect(parseEnv(workerEnvSchema, { ...worker, MAIL_TRANSPORT: 'log', NODE_ENV: 'development' }).MAIL_TRANSPORT).toBe('log');
    expect(() => parseEnv(workerEnvSchema, { ...worker, SMTP_URL: undefined })).toThrow(/SMTP_URL/);
  });
});
