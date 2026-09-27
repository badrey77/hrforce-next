import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  hotp,
  newRecoveryCodes,
  normalizeRecoveryCode,
  otpauthUri,
  RECOVERY_ALPHABET,
  totp,
  totpStep,
  verifyTotp,
} from './mfa.js';

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII string "12345678901234567890"; 8-digit values.
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [seconds: number, code: string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it.each(RFC_VECTORS)('T=%i → %s (SHA-1, 8 digits)', (seconds, code) => {
    expect(totp(RFC_SEED, seconds * 1000, 8)).toBe(code);
  });

  it('RFC 4226 Appendix D HOTP values (6 digits)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, i) => hotp(RFC_SEED, i))).toEqual(expected);
  });

  it('accepts the current step ±1, not ±2', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    for (const delta of [-1, 0, 1]) expect(verifyTotp(RFC_SEED, hotp(RFC_SEED, step + delta), now, null)).toEqual({ ok: true, step: step + delta });
    for (const delta of [-2, 2]) expect(verifyTotp(RFC_SEED, hotp(RFC_SEED, step + delta), now, null)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuses a replay (step ≤ last used), wrong codes and malformed input', () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    const code = hotp(RFC_SEED, step);
    expect(verifyTotp(RFC_SEED, code, now, step)).toEqual({ ok: false, reason: 'replay' });
    expect(verifyTotp(RFC_SEED, code, now, step + 1)).toEqual({ ok: false, reason: 'replay' });
    expect(verifyTotp(RFC_SEED, code, now, step - 1)).toEqual({ ok: true, step });
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    expect(verifyTotp(RFC_SEED, wrong, now, null).ok).toBe(false);
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 123456']) expect(verifyTotp(RFC_SEED, bad, now, null)).toEqual({ ok: false, reason: 'format' });
  });
});

describe('base32 (RFC 4648)', () => {
  it('encodes the RFC test vectors without padding and round-trips', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain))).toBe(encoded);
      expect(base32Decode(encoded)?.toString()).toBe(plain);
    }
    expect(base32Encode(RFC_SEED)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')?.equals(RFC_SEED)).toBe(true);
    expect(base32Decode('ABC1')).toBeNull();
  });
});

describe('otpauth URI', () => {
  it('issuer HRForce, label HRForce:<email>', () => {
    expect(otpauthUri('rh.admin@demo.dz', 'ABC')).toBe('otpauth://totp/HRForce:rh.admin%40demo.dz?secret=ABC&issuer=HRForce&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('10 distinct codes XXXXX-XXXXX from the 32-character alphabet', () => {
    expect(RECOVERY_ALPHABET).toHaveLength(32);
    expect(RECOVERY_ALPHABET).not.toMatch(/[IO01]/);
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });

  it('normalizes case, hyphens and spaces; refuses other characters and lengths', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ab-cd-ef-gh-jk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDEFGHJK')).toBe('ABCDEFGHJK');
    for (const bad of ['ABCDE-FGHJ', 'ABCDE-FGHJKL', 'ABCDE-FGHI1', 'ABCDE_FGHJK', '']) expect(normalizeRecoveryCode(bad)).toBeNull();
    expect(hashRecoveryCode('ABCDEFGHJK')).toHaveLength(32);
  });
});
