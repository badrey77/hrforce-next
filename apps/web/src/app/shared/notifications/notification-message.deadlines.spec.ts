import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { translocoTesting } from '../../../testing/transloco-testing';
import { NOTIFICATION_TYPES } from '../../core/notifications/notifications.models';
import { notificationKey, notificationMessage } from './notification-message';

const FORMAT = { leaveType: (c: string) => c, date: (iso: string) => iso, days: (d: number) => String(d) };

describe('notification messages › contracts & deadlines', () => {
  it('the daily digest has its own sentence with its counts', () => {
    expect(NOTIFICATION_TYPES).toContain('deadline.digest');
    const message = notificationMessage({ type: 'deadline.digest', data: { newCount: 3, overdueCount: 1, criticalCount: 1 } }, FORMAT);
    expect(message.key).toBe('notifications.types.deadline.digest');
    expect(message.params).toMatchObject({ newCount: '3', overdueCount: '1', criticalCount: '1' });
  });

  it('a contract-decision task reads as such, not as a leave request', () => {
    expect(notificationKey({ type: 'task.assigned', data: { subjectType: 'contract_decision', employeeName: 'BENALI Amine' } })).toBe(
      'notifications.types.task.assigned_contract',
    );
  });

  it('both sentences exist in fr, ar and en', () => {
    TestBed.configureTestingModule({ imports: [translocoTesting()] });
    const t = TestBed.inject(TranslocoService);
    for (const lang of ['fr', 'ar', 'en']) {
      for (const key of ['notifications.types.deadline.digest', 'notifications.types.task.assigned_contract', 'notifications.typeLabels.deadline.digest']) {
        expect(t.translate(key, { newCount: 2, employeeName: 'X' }, lang)).not.toBe(key);
      }
    }
  });
});
