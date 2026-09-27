import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from './notification-rules.js';
import { formatDate, formatDays, renderNotificationMail, type MailLocale } from './mail-templates.js';

const data = {
  employeeName: 'Walid Mansouri',
  employeeNameAr: 'وليد منصوري',
  leaveType: 'annual',
  startDate: '2026-10-12',
  endDate: '2026-10-14',
  days: 2.5,
  actorName: 'Karim Haddad',
  reason: 'MUST NOT LEAK',
  balance: 99,
};
const link = 'https://hr.example.dz/tasks?task=0190a5d0-0000-7000-8000-000000000abc';

describe('notification mails', () => {
  it.each(NOTIFICATION_TYPES.flatMap((type) => (['fr', 'ar', 'en'] as MailLocale[]).map((locale) => [type, locale] as const)))('%s in %s: subject, greeting, link, no reason/balance', (type, locale) => {
    const mail = renderNotificationMail({ type, locale, recipientName: 'Nadia', data, leaveTypeLabel: 'Congé annuel', link });
    expect(mail.subject).toMatch(/^HRForce — /);
    expect(mail.text).toContain('Nadia');
    expect(mail.text).toContain(link);
    expect(mail.html).toContain(`href="${link.replace(/&/g, '&#38;')}"`);
    expect(`${mail.subject}${mail.text}${mail.html}`).not.toMatch(/MUST NOT LEAK|99/);
    if (locale === 'ar') expect(mail.html).toContain('dir="rtl"');
  });

  it('uses the Arabic name in Arabic, localised dates and days', () => {
    const ar = renderNotificationMail({ type: 'task.assigned', locale: 'ar', recipientName: 'كريم', data, leaveTypeLabel: 'عطلة سنوية', link });
    expect(ar.text).toContain('وليد منصوري');
    expect(ar.text).toContain('12/10/2026');
    const fr = renderNotificationMail({ type: 'leave.approved', locale: 'fr', recipientName: 'Walid', data, leaveTypeLabel: 'Congé annuel', link });
    expect(fr.text).toContain('du 12/10/2026 au 14/10/2026, 2,5 j');
    expect(fr.text).toContain('approuvée par Karim Haddad');
    const en = renderNotificationMail({ type: 'leave.approved', locale: 'en', recipientName: 'Walid', data: { ...data, actorName: null }, leaveTypeLabel: null, link });
    expect(en.text).toContain('(annual, 2026-10-12 to 2026-10-14, 2.5 days) was approved by a manager');
  });

  it('escapes HTML in names', () => {
    const mail = renderNotificationMail({ type: 'task.assigned', locale: 'fr', recipientName: '<b>x</b>', data: { ...data, employeeName: '<script>' }, leaveTypeLabel: null, link });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).not.toContain('<b>x</b>');
  });

  it('formats', () => {
    expect(formatDate('2026-01-05', 'fr')).toBe('05/01/2026');
    expect(formatDate('2026-01-05', 'en')).toBe('2026-01-05');
    expect(formatDays(3, 'fr')).toBe('3');
    expect(formatDays('1.5', 'fr')).toBe('1,5');
  });
});
