import { describe, expect, it } from 'vitest';
import type { AdapterPayload } from 'oidc-provider';
import { hashId, restoreIds, stripIds } from './oidc-adapter.js';

describe('OIDC adapter: no bearer value at rest', () => {
  it('drops every top-level field equal to the id and restores it on find', () => {
    const id = 'Zx9-code-value-abcdefghijklmnopqrstuvwxyz';
    const payload = { jti: id, kind: 'AuthorizationCode', grantId: 'g1', accountId: 'u1', exp: 123 } as AdapterPayload;
    const stored = stripIds('AuthorizationCode', id, payload);
    expect(JSON.stringify(stored)).not.toContain(id);
    expect(stored['__idFields']).toEqual(['jti']);
    expect(restoreIds(id, stored, null)).toEqual(payload);
  });

  it('an Interaction loses its uid (= id) and the copied session cookie (the provider session id)', () => {
    const id = 'interaction-uid-0123456789ab';
    const payload = { jti: id, uid: id, kind: 'Interaction', session: { accountId: 'u1', uid: 'session-uid', cookie: 'session-jti-SECRET' } } as unknown as AdapterPayload;
    const stored = stripIds('Interaction', id, payload);
    const text = JSON.stringify(stored);
    expect(text).not.toContain(id);
    expect(text).not.toContain('session-jti-SECRET');
    expect(stored['__idFields']).toEqual(['jti', 'uid']);
    expect(restoreIds(id, stored, null)).toEqual({ jti: id, uid: id, kind: 'Interaction', session: { accountId: 'u1', uid: 'session-uid' } });
  });

  it('keeps the cookie of other models; findByUid restores nothing (the id is unknown); consumed from consumed_at', () => {
    const stored = stripIds('Session', 'sid-1', { jti: 'sid-1', uid: 'u-1', session: { cookie: 'x' } } as unknown as AdapterPayload);
    expect(stored['session']).toEqual({ cookie: 'x' });
    expect(restoreIds(null, stored, null)).toEqual({ uid: 'u-1', session: { cookie: 'x' } });
    expect(restoreIds('sid-1', stored, new Date('2026-09-30T10:00:00.900Z'))).toMatchObject({ jti: 'sid-1', consumed: 1790762400 });
  });

  it('hashes ids with sha-256 (32 bytes)', () => {
    expect(hashId('abc')).toHaveLength(32);
    expect(hashId('abc').equals(hashId('abc'))).toBe(true);
    expect(hashId('abc').equals(hashId('abd'))).toBe(false);
  });
});
