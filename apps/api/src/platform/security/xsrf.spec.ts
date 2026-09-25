import { describe, expect, it } from 'vitest';
import { serializeCookie } from './cookies.js';
import { ANON_BINDING, issueXsrfToken, verifyXsrfToken, verifyXsrfTokenForAny } from './xsrf.js';

const SECRET = 's'.repeat(32);
const SID = '0190a5d0-0000-7000-8000-00000000c001';

describe('XSRF signer', () => {
  it('issues <random>.<hmac> tokens bound to a sid or anon', () => {
    const token = issueXsrfToken(SECRET, SID);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyXsrfToken(SECRET, token, SID)).toBe(true);
    expect(verifyXsrfToken(SECRET, token, ANON_BINDING)).toBe(false);
    expect(verifyXsrfToken(SECRET, token, '0190a5d0-0000-7000-8000-00000000c002')).toBe(false);
    expect(verifyXsrfToken('t'.repeat(32), token, SID)).toBe(false);
    expect(issueXsrfToken(SECRET, SID)).not.toBe(token);
  });

  it('rejects tampered or malformed tokens', () => {
    const token = issueXsrfToken(SECRET, ANON_BINDING);
    const [random, mac] = token.split('.') as [string, string];
    expect(verifyXsrfToken(SECRET, `${random.slice(0, -1)}A.${mac}`, ANON_BINDING)).toBe(random.endsWith('A'));
    expect(verifyXsrfToken(SECRET, `${random}.${mac}.x`, ANON_BINDING)).toBe(false);
    expect(verifyXsrfToken(SECRET, random, ANON_BINDING)).toBe(false);
    expect(verifyXsrfToken(SECRET, '', ANON_BINDING)).toBe(false);
    expect(verifyXsrfToken(SECRET, `${random}.${mac.slice(0, 20)}`, ANON_BINDING)).toBe(false);
  });

  it('verifyXsrfTokenForAny accepts any listed binding', () => {
    const token = issueXsrfToken(SECRET, SID);
    expect(verifyXsrfTokenForAny(SECRET, token, [ANON_BINDING, SID])).toBe(true);
    expect(verifyXsrfTokenForAny(SECRET, token, [ANON_BINDING])).toBe(false);
  });
});

describe('serializeCookie', () => {
  it('writes exactly the given attributes, in a stable order', () => {
    expect(serializeCookie({ name: 'hrf_at', value: 'a.b-c_d', path: '/api', maxAge: 900, httpOnly: true, secure: true })).toBe(
      'hrf_at=a.b-c_d; Max-Age=900; Path=/api; HttpOnly; Secure; SameSite=Strict',
    );
    expect(serializeCookie({ name: 'XSRF-TOKEN', value: 'x.y', path: '/', httpOnly: false, secure: false })).toBe(
      'XSRF-TOKEN=x.y; Path=/; SameSite=Strict',
    );
    expect(() => serializeCookie({ name: 'a', value: 'x; Domain=evil', path: '/', httpOnly: true, secure: true })).toThrow();
  });
});
