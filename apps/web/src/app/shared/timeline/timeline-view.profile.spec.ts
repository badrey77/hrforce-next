import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { TimelineEntry } from '../../core/audit/audit.models';
import { type ChangeView, eventSentenceKey, NO_NAMES, toEntryView } from './timeline-view';

const change = (table: string, changes: TimelineEntry['changes']): TimelineEntry => ({
  id: 'c:1',
  at: '2026-10-20T08:30:00Z',
  actor: { id: 'u-1', displayName: 'Samir Haddad' },
  requestId: null,
  kind: 'change',
  table,
  op: 'update',
  changes,
});

describe('timeline › personal details and profile changes', () => {
  it('words profile events by their section', () => {
    expect(eventSentenceKey('profile.applied', { section: 'contact' })).toBe('audit.events.profile.applied.contact');
    expect(eventSentenceKey('profile.requested', { section: 'family' })).toBe('audit.events.profile.requested.family');
    expect(eventSentenceKey('profile.cancelled', {})).toBe('audit.events.profile.cancelled.unknown');
  });

  it('masks personal values, names enums and hides link columns', () => {
    const contact = toEntryView(
      change('person_contact', [
        { field: 'person_id', before: 'p-1', after: 'p-1', masked: false },
        { field: 'mobile_phone', before: '***', after: '***', masked: true },
        { field: 'updated_at', before: null, after: '2026-10-20T08:30:00Z', masked: false },
      ]),
      NO_NAMES,
    ) as ChangeView;
    expect(contact.lines.map((l) => [l.field, l.after?.kind])).toEqual([['mobile_phone', 'masked']]);

    const request = toEntryView(
      change('profile_change_request', [
        { field: 'status', before: 'pending', after: 'approved', masked: false },
        { field: 'workflow_instance_id', before: null, after: 'wf-1', masked: false },
      ]),
      NO_NAMES,
    ) as ChangeView;
    expect(request.lines).toHaveLength(1);
    expect(request.lines[0]?.after).toEqual({ kind: 'key', key: 'profile.status.approved', text: 'approved' });
  });

  it('has labels for the tables, fields and events in fr, ar and en', () => {
    TestBed.configureTestingModule({ imports: [translocoTesting()] });
    const t = TestBed.inject(TranslocoService);
    const keys = [
      'audit.tables.person_contact',
      'audit.tables.profile_change_request',
      'audit.fields.person_contact.mobile_phone',
      'audit.fields.person_family.marital_status',
      'audit.fields.person_child.birth_date',
      'audit.fields.profile_policy.file_retention_days',
      'audit.events.profile.applied.family',
      'audit.events.profile.requested.bank',
      'audit.events.profile.cancelled.contact',
      'audit.events.profile.file_downloaded',
      'audit.events.profile.files_purged',
      'profile.maritalStatus.widowed',
    ];
    for (const lang of ['fr', 'ar', 'en']) for (const key of keys) expect(t.translate(key, {}, lang)).not.toBe(key);
  });
});
