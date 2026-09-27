import { notificationMessage } from './notification-message';
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
