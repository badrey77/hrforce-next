import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { translocoTesting } from '../../../testing/transloco-testing';
import { NOTIFICATION_TYPES } from '../../core/notifications/notifications.models';
import { notificationKey } from './notification-message';

const TYPES = ['profile.change_approved', 'profile.change_rejected', 'profile.bank_changed'] as const;

describe('notification messages › profile changes', () => {
  it('lists the three types and words a profile task as such', () => {
    for (const type of TYPES) expect(NOTIFICATION_TYPES).toContain(type);
    expect(notificationKey({ type: 'profile.change_rejected', data: {} })).toBe('notifications.types.profile.change_rejected');
    expect(notificationKey({ type: 'task.assigned', data: { subjectType: 'profile_change_request', employeeName: 'HADDAD Samir' } })).toBe(
      'notifications.types.task.assigned_profile',
    );
  });

  it('every sentence and preference label exists in fr, ar and en', () => {
    TestBed.configureTestingModule({ imports: [translocoTesting()] });
    const t = TestBed.inject(TranslocoService);
    const keys = [...TYPES.flatMap((type) => [`notifications.types.${type}`, `notifications.typeLabels.${type}`]), 'notifications.types.task.assigned_profile'];
    for (const lang of ['fr', 'ar', 'en']) {
      for (const key of keys) expect(t.translate(key, { employeeName: 'X' }, lang)).not.toBe(key);
    }
  });
});
