import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env.js';

const dev = {
  NODE_ENV: 'development',
  SSO_DEMO_PORT: '4300',
  SSO_DEMO_BASE_URL: 'http://localhost:4300/',
  SSO_DEMO_ISSUER: 'http://localhost:4200/oidc',
  SSO_DEMO_CLIENT_ID: 'sso-demo',
  SSO_DEMO_CLIENT_SECRET: 'sso-demo-dev-secret-INSECURE-2026-0123456789',
  SSO_DEMO_COOKIE_SECURE: 'false',
  LOG_LEVEL: 'info',
};
const prod = {
  ...dev,
  NODE_ENV: 'production',
  SSO_DEMO_BASE_URL: 'https://demo.example.dz',
  SSO_DEMO_ISSUER: 'https://rh.example.dz/oidc',
  SSO_DEMO_CLIENT_SECRET: 'a'.repeat(43),
  SSO_DEMO_COOKIE_SECURE: 'true',
};

function problems(source: Record<string, string | undefined>): string[] {
  try {
    loadEnv(source);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).problems;
  }
}

describe('env', () => {
  it('accepts the .env.example values and strips the trailing slash', () => {
    expect(loadEnv(dev)).toMatchObject({ port: 4300, baseUrl: 'http://localhost:4300', issuer: 'http://localhost:4200/oidc', cookieSecure: false });
  });

  it('accepts a production configuration', () => {
    expect(loadEnv(prod).cookieSecure).toBe(true);
  });

  it('names each missing variable', () => {
    const found = problems({ NODE_ENV: 'development' });
    for (const name of ['SSO_DEMO_PORT', 'SSO_DEMO_BASE_URL', 'SSO_DEMO_ISSUER', 'SSO_DEMO_CLIENT_ID', 'SSO_DEMO_CLIENT_SECRET', 'SSO_DEMO_COOKIE_SECURE']) {
      expect(found.some((p) => p.startsWith(`${name}:`))).toBe(true);
    }
  });

  it('refuses a short secret and never prints a value', () => {
    const found = problems({ ...dev, SSO_DEMO_CLIENT_SECRET: 'short-secret-value' });
    expect(found).toEqual(['SSO_DEMO_CLIENT_SECRET: must be at least 32 characters']);
    expect(found.join()).not.toContain('short-secret-value');
  });

  it('refuses http://, a non-secure cookie and the development secret in production', () => {
    const found = problems({
      ...prod,
      SSO_DEMO_ISSUER: 'http://rh.example.dz/oidc',
      SSO_DEMO_COOKIE_SECURE: 'false',
      SSO_DEMO_CLIENT_SECRET: dev.SSO_DEMO_CLIENT_SECRET,
    });
    expect(found.map((p) => p.split(':')[0]).toSorted()).toEqual(['SSO_DEMO_CLIENT_SECRET', 'SSO_DEMO_COOKIE_SECURE', 'SSO_DEMO_ISSUER']);
  });

  it('refuses URLs with a query, fragment or credentials, and a bad client id', () => {
    expect(problems({ ...dev, SSO_DEMO_ISSUER: 'http://u:p@localhost/oidc' })).toHaveLength(1);
    expect(problems({ ...dev, SSO_DEMO_BASE_URL: 'http://localhost:4300/#x' })).toHaveLength(1);
    expect(problems({ ...dev, SSO_DEMO_ISSUER: 'ftp://localhost/oidc' })).toHaveLength(1);
    expect(problems({ ...dev, SSO_DEMO_CLIENT_ID: 'Bad Id' })).toHaveLength(1);
  });
});
