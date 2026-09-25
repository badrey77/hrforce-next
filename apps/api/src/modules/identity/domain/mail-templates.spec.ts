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

  it('setup and reset wordings differ', () => {
    const setup = renderPasswordMail({ purpose: 'setup', locale: 'fr', displayName: 'A', link, validHours: 72 });
    const reset = renderPasswordMail({ purpose: 'reset', locale: 'fr', displayName: 'A', link, validHours: 1 });
    expect(setup.subject).not.toBe(reset.subject);
    expect(reset.text).toContain('1 heure ');
  });
});
