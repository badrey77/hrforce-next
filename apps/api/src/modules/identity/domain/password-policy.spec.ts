import { describe, expect, it } from 'vitest';
import { COMMON_PASSWORDS } from './common-passwords.js';
import { checkPasswordPolicy } from './password-policy.js';

const codes = (password: string, email = 'amina.benali@demo.dz') => checkPasswordPolicy(password, email).map((v) => v.code);

describe('password policy', () => {
  it('accepts 12–128 characters without composition rules', () => {
    expect(codes('correct pony battery')).toEqual([]);
    expect(codes('aaaaaaaaaaab')).toEqual([]);
    expect(codes('x'.repeat(128))).toEqual([]);
  });

  it('too_short / too_long, counting code points (emoji = 1)', () => {
    expect(codes('short-pass1')).toEqual(['too_short']);
    expect(codes('x'.repeat(129))).toEqual(['too_long']);
    expect(codes('🔒'.repeat(12))).toEqual([]);
    expect(codes('🔒'.repeat(11))).toEqual(['too_short']);
  });

  it('contains_email: the local part, case-insensitive (local parts < 3 chars are not checked)', () => {
    expect(codes('my-AMINA.BENALI-secret')).toEqual(['contains_email']);
    expect(codes('abc-long-enough-pass', 'ab@demo.dz')).toEqual([]);
    expect(codes('xyz-long-enough-pass', 'xyz@demo.dz')).toEqual(['contains_email']);
  });

  it('common: bundled list (~1000 entries), case-insensitive; reports every violated rule', () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(900);
    expect(codes('Password1234')).toEqual(['common']);
    expect(codes('MotDePasse2026')).toEqual(['common']);
    expect(codes('azerty')).toEqual(['too_short', 'common']);
    for (const p of COMMON_PASSWORDS) expect(p).toBe(p.toLowerCase());
  });
});
