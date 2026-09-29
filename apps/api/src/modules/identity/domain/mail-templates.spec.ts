import { describe, expect, it } from 'vitest';
import { renderPasswordMail } from './mail-templates.js';

describe('password mails', () => {
  const link = 'http://web.test/password/setup?token=abc_DEF-123';

  it.each(['fr', 'ar', 'en'] as const)('%s: subject, text and html carry the link', (locale) => {
    const mail = renderPasswordMail({ purpose: 'setup', locale, displayName: 'Amina <b>', link, validHours: 72 });
    expect(mail.subject).toContain('HRForce');
    expect(mail.text).toContain(link);
    expect(mail.text).toContain('72');
    expect(mail.html).toContain(`href="http://web.test/password/setup?token=abc_DEF-123"`);
    expect(mail.html).toContain('Amina &#60;b&#62;');
    expect(mail.html).toContain(locale === 'ar' ? 'dir="rtl"' : 'dir="ltr"');
  });

  it('Arabic wording is gender-neutral (the user’s sex is not known): no masculine imperative', () => {
    for (const purpose of ['setup', 'reset'] as const) {
      const mail = renderPasswordMail({ purpose, locale: 'ar', displayName: 'أمينة', link, validHours: 72 });
      expect(`${mail.subject}\n${mail.text}`).not.toMatch(/أنشئ |اختر |لم تكن/);
      expect(mail.text).toContain('يرجى اختيار');
      expect(mail.text).toContain('إذا لم يصدر هذا الطلب عنك، يمكنك تجاهل هذه الرسالة.');
    }
  });

  it('setup and reset wordings differ', () => {
    const setup = renderPasswordMail({ purpose: 'setup', locale: 'fr', displayName: 'A', link, validHours: 72 });
    const reset = renderPasswordMail({ purpose: 'reset', locale: 'fr', displayName: 'A', link, validHours: 1 });
    expect(setup.subject).not.toBe(reset.subject);
    expect(reset.text).toContain('1 heure ');
  });
});
