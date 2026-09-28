import ar from '../../../../public/i18n/ar.json';
import en from '../../../../public/i18n/en.json';
import fr from '../../../../public/i18n/fr.json';
import { notificationKey, notificationMessage, WORDED_BY_AUDIENCE } from './notification-message';

/** The string at a dotted key of a translation file (undefined when missing). */
function at(file: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), file);
}
import { relativeTime } from '../relative-time/relative-time.pipe';

const FORMAT = {
  leaveType: (code: string) => (code === 'annual' ? 'Congé annuel' : code),
  date: (iso: string) => `[${iso}]`,
  days: (days: number) => `${days}`.replace('.', ','),
};

describe('notificationMessage', () => {
  it('key from the type; leave type named from its code, dates and days formatted', () => {
    const message = notificationMessage(
      { type: 'task.assigned', data: { employeeName: 'BENALI Amina', leaveType: 'annual', startDate: '2026-10-05', endDate: '2026-10-09', days: 4.5 } },
      FORMAT,
    );
    expect(message.key).toBe('notifications.types.task.assigned');
    expect(message.params).toMatchObject({
      employeeName: 'BENALI Amina',
      leaveType: 'Congé annuel',
      startDate: '[2026-10-05]',
      endDate: '[2026-10-09]',
      days: '4,5',
    });
  });

  it('Arabic UI: the Arabic employee name when the server sent one', () => {
    const data = { employeeName: 'Amina BENALI', employeeNameAr: 'أمينة بن علي' };
    expect(notificationMessage({ type: 'task.assigned', data }, { ...FORMAT, arabic: true }).params['employeeName']).toBe('أمينة بن علي');
    expect(notificationMessage({ type: 'task.assigned', data }, FORMAT).params['employeeName']).toBe('Amina BENALI');
  });

  it('wording by audience: "your request" for the employee, a sentence naming the employee for anyone else', () => {
    for (const type of ['leave.approved', 'leave.rejected', 'task.escalated']) {
      expect(notificationKey({ type, audience: 'employee' })).toBe(`notifications.types.${type}`);
      expect(notificationKey({ type, audience: 'requester' })).toBe(`notifications.typesNamed.${type}`);
      expect(notificationKey({ type, audience: 'approver' })).toBe(`notifications.typesNamed.${type}`);
      expect(notificationKey({ type, audience: null })).toBe(`notifications.typesNamed.${type}`); // null = someone else
      expect(notificationKey({ type })).toBe(`notifications.typesNamed.${type}`); // older payload without the field
    }
    // Types that always name the employee (approvers) or only reach the employee keep their one sentence.
    for (const type of ['task.assigned', 'leave.cancelled', 'leave.submitted_on_behalf', 'future.type']) {
      expect(notificationKey({ type, audience: 'approver' })).toBe(`notifications.types.${type}`);
    }
    const data = { employeeName: 'Walid MANSOURI', employeeNameAr: 'وليد منصوري' };
    const named = notificationMessage({ type: 'leave.approved', audience: 'requester', data }, { ...FORMAT, arabic: true });
    expect(named.key).toBe('notifications.typesNamed.leave.approved');
    expect(named.params['employeeName']).toBe('وليد منصوري');
  });

  it('every audience-worded type has both sentences in fr, ar and en, the named one with {{employeeName}}', () => {
    for (const file of [fr, ar, en]) {
      for (const type of WORDED_BY_AUDIENCE) {
        expect(typeof at(file, `notifications.types.${type}`)).toBe('string');
        expect(at(file, `notifications.typesNamed.${type}`)).toContain('{{employeeName}}');
      }
    }
  });

  it('missing or null data shows an ellipsis, never a raw {{placeholder}}', () => {
    const message = notificationMessage({ type: 'leave.rejected', data: { actorName: null } }, FORMAT);
    expect(message.params['actorName']).toBe('…');
    expect(message.params['startDate']).toBe('…');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  it('now, minutes, hours, yesterday — in fr, ar (Latin digits) and en', () => {
    expect(relativeTime('2026-09-27T11:59:40Z', 'fr', now)).toBe('maintenant');
    expect(relativeTime('2026-09-27T11:55:00Z', 'fr', now)).toBe('il y a 5 minutes');
    expect(relativeTime('2026-09-27T09:00:00Z', 'en', now)).toBe('3 hours ago');
    expect(relativeTime('2026-09-26T12:00:00Z', 'fr', now)).toBe('hier');
    expect(relativeTime('2026-09-27T11:55:00Z', 'ar', now)).toMatch(/5/);
    expect(relativeTime('not a date', 'fr', now)).toBe('');
  });
});
