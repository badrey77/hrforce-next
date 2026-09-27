import { describe, expect, it } from 'vitest';
import type { Env } from '../../../platform/config/env.schema.js';
import { MfaCipher } from './mfa-cipher.js';

const USER = '0190a5d0-0000-7000-8000-0000000000aa';
const cipherWith = (key?: string) => new MfaCipher({ AUTH_MFA_KEY: key } as Env);

describe('MfaCipher (AES-256-GCM)', () => {
  it('round-trips a 20-byte secret into 48 bytes (nonce ‖ ciphertext ‖ tag), with a fresh nonce each time', () => {
    const cipher = cipherWith(Buffer.alloc(32, 1).toString('base64'));
    const secret = Buffer.alloc(20, 9);
    const a = cipher.encrypt(secret, USER);
    expect(a).toHaveLength(48);
    expect(cipher.encrypt(secret, USER).equals(a)).toBe(false);
    expect(cipher.decrypt(a, USER)?.equals(secret)).toBe(true);
  });

  it('refuses another user (AAD), another key and any tampering', () => {
    const cipher = cipherWith(Buffer.alloc(32, 1).toString('base64'));
    const value = cipher.encrypt(Buffer.alloc(20, 9), USER);
    expect(cipher.decrypt(value, '0190a5d0-0000-7000-8000-0000000000ab')).toBeNull();
    expect(cipherWith(Buffer.alloc(32, 2).toString('base64')).decrypt(value, USER)).toBeNull();
    const tampered = Buffer.from(value);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(cipher.decrypt(tampered, USER)).toBeNull();
    expect(cipher.decrypt(Buffer.alloc(10), USER)).toBeNull();
  });

  it('falls back to the development key when AUTH_MFA_KEY is unset', () => {
    const value = cipherWith().encrypt(Buffer.alloc(20, 3), USER);
    expect(cipherWith().decrypt(value, USER)?.equals(Buffer.alloc(20, 3))).toBe(true);
  });
});
