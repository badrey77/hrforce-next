import { describe, expect, it } from 'vitest';
import { PENDING_TTL_MS, SESSION_IDLE_MS, SessionStore } from './session.js';

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SessionStore', () => {
  it('creates random 256-bit ids', () => {
    const store = new SessionStore();
    const a = store.create().id;
    const b = store.create().id;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('expires an entry after 8 h idle, and each use extends it', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const { id } = store.create({ lang: 'ar' });
    c.advance(SESSION_IDLE_MS - 1);
    expect(store.get(id)?.lang).toBe('ar');
    c.advance(SESSION_IDLE_MS - 1);
    expect(store.get(id)).toBeDefined();
    c.advance(SESSION_IDLE_MS + 1);
    expect(store.get(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('drops a pending sign-in older than 10 minutes', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const { id } = store.create({ pending: { codeVerifier: 'v', state: 's', nonce: 'n', createdAt: c.now() } });
    c.advance(PENDING_TTL_MS);
    expect(store.get(id)?.pending).toBeDefined();
    c.advance(1);
    expect(store.get(id)?.pending).toBeUndefined();
  });

  it('regenerate replaces the id; sweep removes idle entries; unknown ids are undefined', () => {
    const c = clock();
    const store = new SessionStore(c.now);
    const old = store.create().id;
    const fresh = store.regenerate(old, { lang: 'fr' }).id;
    expect(store.get(old)).toBeUndefined();
    expect(store.get(fresh)?.lang).toBe('fr');
    expect(store.get(undefined)).toBeUndefined();
    expect(store.get('nope')).toBeUndefined();
    store.create();
    c.advance(SESSION_IDLE_MS + 1);
    expect(store.sweep()).toBe(2);
  });
});
