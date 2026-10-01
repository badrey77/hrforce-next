import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveOidcKeys, open, seal } from './oidc-crypto.js';

describe('OIDC key material', () => {
  it('derives distinct subkeys per info, deterministically, and differing per master key', () => {
    const master = randomBytes(32);
    const a = deriveOidcKeys(master);
    const b = deriveOidcKeys(Buffer.from(master));
    expect(a.aead.equals(b.aead)).toBe(true);
    expect(a.cookies).toBe(b.cookies);
    expect(a.aead.toString('base64url')).not.toBe(a.cookies);
    expect(a.aead.equals(master)).toBe(false);
    expect(deriveOidcKeys(randomBytes(32)).aead.equals(a.aead)).toBe(false);
    expect(() => deriveOidcKeys(randomBytes(31))).toThrow(/32 bytes/);
  });

  it('AES-GCM: round trip; wrong AAD, wrong key or a tampered byte fails', () => {
    const { aead } = deriveOidcKeys(randomBytes(32));
    const sealed = seal(aead, 'the-secret', 'sso-demo');
    expect(sealed.includes(Buffer.from('the-secret'))).toBe(false);
    expect(open(aead, sealed, 'sso-demo')).toBe('the-secret');
    expect(open(aead, sealed, 'other-app')).toBeNull();
    expect(open(deriveOidcKeys(randomBytes(32)).aead, sealed, 'sso-demo')).toBeNull();
    const tampered = Buffer.from(sealed);
    tampered[14] = (tampered[14] ?? 0) ^ 1;
    expect(open(aead, tampered, 'sso-demo')).toBeNull();
    expect(open(aead, Buffer.alloc(10), 'sso-demo')).toBeNull();
    // a fresh nonce every time
    expect(seal(aead, 'the-secret', 'sso-demo').equals(sealed)).toBe(false);
  });
});
