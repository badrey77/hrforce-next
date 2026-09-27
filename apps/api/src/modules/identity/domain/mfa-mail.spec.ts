import { describe, expect, it } from 'vitest';
import { renderMfaMail } from './mfa-mail.js';

describe('MFA security mails', () => {
  it('recovery code used: says how many are left, in each locale; Arabic is rtl', () => {
    expect(renderMfaMail({ kind: 'recovery_used', locale: 'fr', displayName: 'Amina', codesLeft: 9 }).text).toContain('Il vous reste 9 codes');
    expect(renderMfaMail({ kind: 'recovery_used', locale: 'en', displayName: 'Amina', codesLeft: 1 }).text).toContain('1 code left');
    const ar = renderMfaMail({ kind: 'recovery_used', locale: 'ar', displayName: 'كريم', codesLeft: 3 });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain('3');
  });

  it('reset: escapes the name in HTML', () => {
    const mail = renderMfaMail({ kind: 'reset', locale: 'fr', displayName: '<b>X</b>' });
    expect(mail.subject).toMatch(/réinitialisée/);
    expect(mail.html).not.toContain('<b>X</b>');
  });
});
