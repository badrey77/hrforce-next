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

  it('Arabic wording is gender-neutral (the user’s sex is not known): no masculine imperative', () => {
    for (const kind of ['recovery_used', 'reset'] as const) {
      const mail = renderMfaMail(kind === 'reset' ? { kind, locale: 'ar', displayName: 'أمينة' } : { kind, locale: 'ar', displayName: 'أمينة', codesLeft: 2 });
      expect(mail.text).not.toMatch(/أنشئ |أعد |فأبلغ|لم تكن/);
      expect(mail.text).toContain('إذا لم يصدر هذا الإجراء عنك، يرجى إبلاغ مسؤولك فورًا.');
    }
  });

  it('reset: escapes the name in HTML', () => {
    const mail = renderMfaMail({ kind: 'reset', locale: 'fr', displayName: '<b>X</b>' });
    expect(mail.subject).toMatch(/réinitialisée/);
    expect(mail.html).not.toContain('<b>X</b>');
  });
});
