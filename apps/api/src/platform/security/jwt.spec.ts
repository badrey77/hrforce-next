import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAccessToken, signMfaPendingToken, verifyAccessToken, verifyMfaPendingToken, type AccessClaims, type MfaPendingClaims } from './jwt.js';

const SECRET = 'k'.repeat(32);
const NOW = 1_800_000_000;
const claims: AccessClaims = {
  sub: '0190a5d0-0000-7000-8000-0000000000aa',
  cid: '0190a5d0-0000-7000-8000-000000000001',
  sid: '0190a5d0-0000-7000-8000-00000000c001',
  iat: NOW,
  exp: NOW + 900,
};
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const hs256 = (secret: string, input: string) => createHmac('sha256', secret).update(input).digest('base64url');

describe('access token (HS256 JWT)', () => {
  it('round-trips and has a standard header', () => {
    const token = signAccessToken(SECRET, claims);
    expect(verifyAccessToken(SECRET, token, NOW + 1)).toEqual(claims);
    expect(JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('rejects expiry (exp <= now) and future iat', () => {
    const token = signAccessToken(SECRET, claims);
    expect(verifyAccessToken(SECRET, token, NOW + 899)).not.toBeNull();
    expect(verifyAccessToken(SECRET, token, NOW + 900)).toBeNull();
    expect(verifyAccessToken(SECRET, signAccessToken(SECRET, { ...claims, iat: NOW + 120, exp: NOW + 1000 }), NOW)).toBeNull();
  });

  it('rejects a wrong secret and any tampering (payload, signature)', () => {
    const token = signAccessToken(SECRET, claims);
    expect(verifyAccessToken('x'.repeat(32), token, NOW)).toBeNull();
    const [h, , s] = token.split('.');
    const forgedPayload = b64({ ...claims, sub: '0190a5d0-0000-7000-8000-0000000000ab' });
    expect(verifyAccessToken(SECRET, `${h}.${forgedPayload}.${s}`, NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, `${token.slice(0, -2)}AA`, NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, `${token}.x`, NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, 'not-a-jwt', NOW)).toBeNull();
  });

  it('rejects alg "none" and any alg other than HS256, even when correctly signed', () => {
    const payload = b64(claims);
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${payload}.`;
    expect(verifyAccessToken(SECRET, none, NOW)).toBeNull();
    const noneSigned = `${b64({ alg: 'none' })}.${payload}.${hs256(SECRET, `${b64({ alg: 'none' })}.${payload}`)}`;
    expect(verifyAccessToken(SECRET, noneSigned, NOW)).toBeNull();
    for (const alg of ['HS512', 'hs256', 'RS256', undefined]) {
      const header = b64(alg === undefined ? { typ: 'JWT' } : { alg, typ: 'JWT' });
      expect(verifyAccessToken(SECRET, `${header}.${payload}.${hs256(SECRET, `${header}.${payload}`)}`, NOW)).toBeNull();
    }
  });

  it('rejects malformed claims', () => {
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    for (const bad of [{ ...claims, sub: 'admin' }, { ...claims, exp: String(NOW + 900) }, { ...claims, sid: undefined }, [1, 2]]) {
      const payload = b64(bad);
      expect(verifyAccessToken(SECRET, `${header}.${payload}.${hs256(SECRET, `${header}.${payload}`)}`, NOW)).toBeNull();
    }
  });
});

describe('pending MFA token vs access token (purpose claim)', () => {
  const pending: MfaPendingClaims = { sub: claims.sub, cid: claims.cid, mfa: '0190a5d0-0000-7000-8000-00000000f001', iat: NOW, exp: NOW + 300 };
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const signed = (payload: unknown) => `${header}.${b64(payload)}.${hs256(SECRET, `${header}.${b64(payload)}`)}`;

  it('round-trips a pending token; it expires after 5 minutes', () => {
    const token = signMfaPendingToken(SECRET, pending);
    expect(verifyMfaPendingToken(SECRET, token, NOW + 1)).toEqual(pending);
    expect(verifyMfaPendingToken(SECRET, token, NOW + 300)).toBeNull();
  });

  it('a pending token is never an access token, and an access token is never a pending token', () => {
    expect(verifyAccessToken(SECRET, signMfaPendingToken(SECRET, pending), NOW)).toBeNull();
    expect(verifyMfaPendingToken(SECRET, signAccessToken(SECRET, claims), NOW)).toBeNull();
  });

  it('the purpose claim is required and must match its claim set', () => {
    expect(verifyAccessToken(SECRET, signed(claims), NOW)).toBeNull(); // no pur
    expect(verifyAccessToken(SECRET, signed({ ...claims, pur: 'mfa' }), NOW)).toBeNull();
    expect(verifyAccessToken(SECRET, signed({ ...claims, pur: 'access', mfa: pending.mfa }), NOW)).toBeNull();
    expect(verifyMfaPendingToken(SECRET, signed({ ...pending, pur: 'access' }), NOW)).toBeNull();
    expect(verifyMfaPendingToken(SECRET, signed({ ...pending, pur: 'mfa', sid: claims.sid }), NOW)).toBeNull();
    expect(verifyMfaPendingToken(SECRET, signed({ ...pending, pur: 'mfa' }), NOW)).toEqual(pending);
  });
});
