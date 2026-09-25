import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

/**
 * Real XSRF token for tests that use header identities (DEV_AUTH X-Dev-*, X-Test-*): those have no session, so the
 * API expects an `anon` token, obtained exactly like the web does — GET /api/auth/csrf.
 */
export interface XsrfPair {
  token: string;
  /** value for a `Cookie` request header */
  cookie: string;
}

export function setCookieHeaders(res: { headers: Record<string, unknown> }): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
}

export async function fetchXsrf(app: NestExpressApplication): Promise<XsrfPair> {
  const res = await request(app.getHttpServer()).get('/api/auth/csrf').expect(204);
  const header = setCookieHeaders(res).find((c) => c.startsWith('XSRF-TOKEN='));
  const token = header?.split(';')[0]?.slice('XSRF-TOKEN='.length);
  if (!token) throw new Error('GET /api/auth/csrf did not set XSRF-TOKEN');
  return { token, cookie: `XSRF-TOKEN=${token}` };
}

/** Adds the XSRF cookie + header to an unsafe request. */
export function withXsrf(test: request.Test, xsrf: XsrfPair): request.Test {
  return test.set('Cookie', xsrf.cookie).set('X-XSRF-TOKEN', xsrf.token);
}
