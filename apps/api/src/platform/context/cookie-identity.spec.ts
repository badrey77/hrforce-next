import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '../security/jwt.js';
import { CookieIdentityResolver, FirstMatchIdentityResolver } from './cookie-identity.js';
import { DevHeaderIdentityResolver } from './dev-identity.js';

const SECRET = 'a'.repeat(32);
const USER = '0190a5d0-0000-7000-8000-0000000000aa';
const COMPANY = '0190a5d0-0000-7000-8000-000000000001';
const SID = '0190a5d0-0000-7000-8000-00000000c001';
const now = () => Math.floor(Date.now() / 1000);
const token = (exp = now() + 900) => signAccessToken(SECRET, { sub: USER, cid: COMPANY, sid: SID, iat: now(), exp });
const req = (cookies: Record<string, string>, headers: Record<string, string> = {}) => ({ cookies, headers }) as unknown as Request;

describe('CookieIdentityResolver', () => {
  const resolver = new CookieIdentityResolver(SECRET);

  it('valid hrf_at → user, company, session and the token expiry (closes the SSE stream)', async () => {
    const exp = now() + 900;
    await expect(resolver.resolve(req({ hrf_at: token(exp) }))).resolves.toEqual({ userId: USER, companyId: COMPANY, sessionId: SID, expiresAt: exp });
  });

  it('missing, expired or foreign-signed token → anonymous', async () => {
    await expect(resolver.resolve(req({}))).resolves.toEqual({ userId: null, companyId: null });
    await expect(resolver.resolve(req({ hrf_at: token(now() - 1) }))).resolves.toEqual({ userId: null, companyId: null });
    await expect(new CookieIdentityResolver('b'.repeat(32)).resolve(req({ hrf_at: token() }))).resolves.toMatchObject({ userId: null });
  });

  it('the cookie wins over DEV_AUTH headers when both are present; headers are the fallback', async () => {
    const both = new FirstMatchIdentityResolver([resolver, new DevHeaderIdentityResolver()]);
    const other = '0190a5d0-0000-7000-8000-0000000000bb';
    const headers = { 'x-dev-user-id': other, 'x-dev-company-id': COMPANY };
    await expect(both.resolve(req({ hrf_at: token() }, headers))).resolves.toMatchObject({ userId: USER, sessionId: SID });
    await expect(both.resolve(req({ hrf_at: 'garbage' }, headers))).resolves.toEqual({ userId: other, companyId: COMPANY });
  });
});
