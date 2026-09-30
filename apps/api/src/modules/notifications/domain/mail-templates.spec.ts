import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from './notification-rules.js';
import { arabicDays, formatDate, formatDays, renderNotificationMail, type MailLocale } from './mail-templates.js';

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
const approvedSubject = (audience: string) =>
  renderNotificationMail({ type: 'leave.approved', locale: 'fr', recipientName: 'Nadia', data: { ...data, audience }, leaveTypeLabel: null, link }).subject;

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

  describe('own request vs someone else’s (audience)', () => {
    const cases: [type: 'leave.approved' | 'leave.rejected' | 'task.escalated', locale: MailLocale, own: RegExp, other: RegExp][] = [
      ['leave.approved', 'fr', /^Votre demande de congé \(Congé annuel, du 12\/10\/2026 au 14\/10\/2026, 2,5 j\) a été approuvée par Karim Haddad\.$/m, /^La demande de congé de Walid Mansouri \(/m],
      ['leave.rejected', 'fr', /^Votre demande de congé \(.*\) a été refusée par Karim Haddad\./m, /^La demande de congé de Walid Mansouri \(.*\) a été refusée/m],
      ['task.escalated', 'fr', /pour votre demande \(/, /pour la demande de Walid Mansouri \(/],
      ['leave.approved', 'en', /^Your leave request \(/m, /^The leave request of Walid Mansouri \(/m],
      ['leave.rejected', 'en', /^Your leave request \(/m, /^The leave request of Walid Mansouri \(/m],
      ['task.escalated', 'en', /for your request \(/, /for the request of Walid Mansouri \(/],
      ['leave.approved', 'ar', /تمت الموافقة على طلب عطلتك \(/, /تمت الموافقة على طلب عطلة وليد منصوري \(/],
      ['leave.rejected', 'ar', /تم رفض طلب عطلتك \(/, /تم رفض طلب عطلة وليد منصوري \(/],
      ['task.escalated', 'ar', /المباشر لطلبك \(/, /المباشر لطلب وليد منصوري \(/],
    ];
    it.each(cases)('%s in %s', (type, locale, own, other) => {
      const render = (audience: string | undefined) =>
        renderNotificationMail({ type, locale, recipientName: 'Nadia', data: { ...data, audience }, leaveTypeLabel: locale === 'ar' ? 'عطلة سنوية' : 'Congé annuel', link });
      const mine = render('employee');
      expect(mine.text).toMatch(own);
      expect(`${mine.subject}${mine.text}`).not.toMatch(/Walid Mansouri|وليد منصوري/);
      for (const audience of ['requester', 'approver', undefined]) {
        const theirs = render(audience);
        expect(theirs.text).toMatch(other);
        expect(theirs.subject).toContain(locale === 'ar' ? 'وليد منصوري' : 'Walid Mansouri');
        expect(theirs.subject).not.toMatch(/votre|your|عطلتك/i);
      }
    });

    it('the subject says whose request it is', () => {
      expect(approvedSubject('employee')).toBe('HRForce — votre demande de congé est approuvée');
      expect(approvedSubject('requester')).toBe('HRForce — demande de congé de Walid Mansouri approuvée');
    });
  });

  it('Arabic wording is gender-neutral: actors through the passive, no masculine imperative or verb', () => {
    const masculine = /ألغى|قدّم|وافق |أنشئ|اختر |أعد |فأبلغ|لم تكن|الخاص بـ/;
    for (const type of NOTIFICATION_TYPES) {
      for (const audience of ['employee', 'requester']) {
        for (const subjectType of ['leave_request', 'document_request']) {
          const mail = renderNotificationMail({
            type,
            locale: 'ar',
            recipientName: 'نادية',
            data: { ...data, audience, subjectType, number: 'ATT-2026-00001' },
            leaveTypeLabel: 'عطلة سنوية',
            documentTypeLabel: 'شهادة عمل',
            link,
          });
          expect(`${mail.subject}\n${mail.text}`, `${type}/${audience}/${subjectType}`).not.toMatch(masculine);
        }
      }
    }
    const task = renderNotificationMail({ type: 'task.assigned', locale: 'ar', recipientName: 'نادية', data: { ...data, subjectType: 'document_request' }, leaveTypeLabel: null, documentTypeLabel: 'شهادة عمل', link });
    expect(task.text).toContain('طلب شهادة عمل من وليد منصوري في انتظار قرارك.');
    const cancelled = renderNotificationMail({ type: 'leave.cancelled', locale: 'ar', recipientName: 'نادية', data, leaveTypeLabel: 'عطلة سنوية', link });
    expect(cancelled.text).toContain('تم إلغاء طلب عطلة وليد منصوري (عطلة سنوية، من 12/10/2026 إلى 14/10/2026) من طرف Karim Haddad.');
  });

  it.each([
    ['1', 'يوم واحد'],
    ['2', 'يومان'],
    ['3', '3 أيام'],
    ['10', '10 أيام'],
    ['11', '11 يومًا'],
    ['99', '99 يومًا'],
    ['100', '100 يوم'],
    ['102', '102 يوم'],
    ['103', '103 أيام'],
    ['111', '111 يومًا'],
    ['0.5', 'نصف يوم'],
    ['2.5', '2.5 يوم'],
  ])('Arabic day count %s → %s', (days, text) => {
    expect(arabicDays(days)).toBe(text);
  });

  it('Arabic mails use the day-count agreement', () => {
    const mail = renderNotificationMail({ type: 'leave.approved', locale: 'ar', recipientName: 'نادية', data: { ...data, days: 3 }, leaveTypeLabel: 'عطلة سنوية', link });
    expect(mail.text).toContain('من 12/10/2026 إلى 14/10/2026، 3 أيام)');
  });

  it('punch corrections (attendance.md › Phase B): task, escalation, outcomes — the day, never the reason or times; neutral Arabic', () => {
    const c = { correctionId: 'x', employeeName: 'Walid Mansouri', employeeNameAr: 'وليد منصوري', date: '2026-09-28', changes: 2, actorName: 'Karim Haddad', reason: 'MUST NOT LEAK', time: '08:05' };
    const task = (locale: MailLocale) => renderNotificationMail({ type: 'task.assigned', locale, recipientName: 'N', data: { ...c, subjectType: 'attendance_correction' }, leaveTypeLabel: null, link });
    expect(task('fr').subject).toBe('HRForce — correction de pointage à traiter : Walid Mansouri (28/09/2026)');
    expect(task('ar').subject).toBe('HRForce — طلب تصحيح تسجيل الحضور للمعالجة: وليد منصوري (28/09/2026)');
    expect(task('en').subject).toBe('HRForce — attendance correction awaiting your decision: Walid Mansouri (2026-09-28)');
    const outcome = (type: 'attendance.correction_approved' | 'attendance.correction_rejected', locale: MailLocale) =>
      renderNotificationMail({ type, locale, recipientName: 'N', data: { ...c, audience: 'employee' }, leaveTypeLabel: null, subjectType: 'attendance_correction', link });
    expect(outcome('attendance.correction_approved', 'fr').subject).toBe('HRForce — votre correction de pointage du 28/09/2026 a été acceptée');
    expect(outcome('attendance.correction_rejected', 'ar').subject).toBe('HRForce — تم رفض طلب تصحيح تسجيل الحضور ليوم 28/09/2026');
    expect(outcome('attendance.correction_approved', 'ar').text).toContain('تم قبول طلب تصحيح تسجيل الحضور ليوم 28/09/2026 من طرف Karim Haddad.');
    const escalated = renderNotificationMail({ type: 'task.escalated', locale: 'fr', recipientName: 'N', data: { ...c, audience: 'employee' }, leaveTypeLabel: null, subjectType: 'attendance_correction', link });
    expect(escalated.subject).toBe('HRForce — votre correction de pointage est transmise aux RH');
    expect(escalated.text).toContain('votre correction de pointage du 28/09/2026');
    for (const locale of ['fr', 'ar', 'en'] as MailLocale[]) {
      for (const mail of [task(locale), outcome('attendance.correction_approved', locale), outcome('attendance.correction_rejected', locale)]) {
        expect(`${mail.subject}${mail.text}`).not.toMatch(/MUST NOT LEAK|08:05|congé|عطلة|leave/i);
      }
    }
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
