import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, parseCookies } from './security.js';

describe('security headers', () => {
  it('builds the contract CSP with the issuer origin in form-action and no script source', () => {
    expect(contentSecurityPolicy('http://localhost:4200/oidc')).toBe(
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' http://localhost:4200; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(contentSecurityPolicy('https://rh.example.dz/oidc')).not.toContain('script-src');
  });

  it('parses cookies, keeping the first of duplicates and ignoring malformed ones', () => {
    const c = parseCookies('a=1; b="x%20y"; a=2; =bad; c=%E0%A4%A');
    expect(c.get('a')).toBe('1');
    expect(c.get('b')).toBe('x y');
    expect(c.has('c')).toBe(false);
    expect(parseCookies(undefined).size).toBe(0);
  });
});
