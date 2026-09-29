import { CREATED, GRANT_ROW, GRANTED, LEAVE_APPROVED, LEAVE_CREATED, MASKED, RENAMED, TASK_DONE, WORKFLOW_APPROVE } from '../../../testing/audit-fixtures';
import { type AuditNameResolver, buildTimeline, type ChangeView, type EventView, NO_NAMES } from './timeline-view';

const NOW = new Date(2026, 8, 26, 14); // local 2026-09-26 14:00

const NAMES: Record<string, Record<string, string>> = {
  unit: { dg: 'Direction générale', 'r-ouest': 'Région Ouest' },
  roleCode: { lecture: 'Lecture' },
  role: { 'role-lecture': 'Lecture' },
};
const names: AuditNameResolver = (kind, value) => NAMES[kind]?.[value];

const LEAVE_NAMES: AuditNameResolver = (kind, value) =>
  kind === 'leaveType' && value === 't-annual' ? 'Congé annuel' : kind === 'step' && value === 'hr' ? 'RH régionales' : undefined;

describe('buildTimeline (pure view model)', () => {
  it('groups by local day, newest first, keeping API order inside a day; tags today / yesterday', () => {
    const groups = buildTimeline([RENAMED, GRANTED, GRANT_ROW, MASKED, CREATED], NO_NAMES, NOW);
    expect(groups.map((g) => [g.day, g.relative, g.entries.map((e) => e.id)])).toEqual([
      ['2026-09-26', 'today', ['c:41', 'e:7']],
      ['2026-09-25', 'yesterday', ['c:40']],
      ['2026-09-20', null, ['c:12']],
      ['2026-09-01', null, ['c:3']],
    ]);
  });

  it('update: one line per changed field (id hidden), label keys per table, ids resolved to names', () => {
    const [today] = buildTimeline([RENAMED], names, NOW);
    const change = today?.entries[0] as ChangeView;
    expect(change.lines.map((l) => l.field)).toEqual(['name', 'parent_id']);
    expect(change.lines[0]).toEqual({
      field: 'name',
      labelKey: 'audit.fields.org_unit_version.name',
      before: { kind: 'text', text: 'Région Est' },
      after: { kind: 'text', text: 'Région Est-Algérie' },
    });
    // `dept-ops` is unknown to the resolver: shown as stored.
    expect(change.lines[1]?.before).toEqual({ kind: 'text', text: 'dept-ops' });
    expect(change.lines[1]?.after).toEqual({ kind: 'text', text: 'Direction générale' });
  });

  it('insert: no "before"; hides company_id and the generated `valid`; booleans, empty, timestamps', () => {
    const change = buildTimeline([GRANT_ROW], names, NOW)[0]?.entries[0] as ChangeView;
    expect(change.op).toBe('insert');
    expect(change.lines.map((l) => l.field)).toEqual(['role_id', 'include_descendants', 'valid_from', 'valid_to', 'granted_at']);
    expect(change.lines.every((l) => l.before === null)).toBe(true);
    expect(change.lines.map((l) => l.after)).toEqual([
      { kind: 'text', text: 'Lecture' },
      { kind: 'bool', value: true },
      { kind: 'date', iso: '2026-10-01' },
      { kind: 'empty' },
      { kind: 'timestamp', iso: '2026-09-25T11:00:00Z' },
    ]);
  });

  it('masked values never leak, whatever the payload', () => {
    const change = buildTimeline([MASKED], NO_NAMES, NOW)[0]?.entries[0] as ChangeView;
    expect(change.actor).toBeNull();
    expect(change.lines[0]).toMatchObject({ before: { kind: 'masked' }, after: { kind: 'masked' } });
  });

  it('date ranges are parsed (open end = null)', () => {
    const change = buildTimeline([CREATED], NO_NAMES, NOW)[0]?.entries[0] as ChangeView;
    expect(change.lines[0]?.after).toEqual({ kind: 'range', from: '2026-01-01', to: '2027-01-01' });
  });

  it('events: sentence key from the type, data as placeholders plus resolved unit and role', () => {
    const event = buildTimeline([GRANTED], names, NOW)[0]?.entries[0] as EventView;
    expect(event.sentenceKey).toBe('audit.events.access.grant_created');
    expect(event.params).toEqual({
      grantId: 'g-1',
      roleCode: 'lecture',
      role: 'Lecture',
      unitId: 'r-ouest',
      unit: 'Région Ouest',
      validFrom: '2026-10-01',
    });
  });

  it('event dates go through the day formatter; unknown people fall back to the actors of the entries', () => {
    const event = buildTimeline([GRANTED], names, NOW, (day) => `<${day}>`)[0]?.entries[0] as EventView;
    expect(event.params['validFrom']).toBe('<2026-10-01>');
    const actorId = RENAMED.actor?.id ?? 'none';
    const row = { ...GRANT_ROW, changes: [{ field: 'granted_by', before: null, after: actorId, masked: false }] };
    const change = buildTimeline([RENAMED, row], NO_NAMES, NOW).flatMap((g) => g.entries).find((e) => e.id === GRANT_ROW.id) as ChangeView;
    expect(change.lines[0]?.after).toEqual({ kind: 'text', text: RENAMED.actor?.displayName ?? actorId });
  });

  it('leave requests: link columns hidden, leave type named, statuses and outcomes as translation keys', () => {
    const [day] = buildTimeline([LEAVE_APPROVED, TASK_DONE, WORKFLOW_APPROVE, LEAVE_CREATED], LEAVE_NAMES, NOW);
    const [approved, task, event, created] = day?.entries ?? [];

    const insert = created as ChangeView;
    expect(insert.lines.map((l) => l.field)).toEqual(['leave_type_id', 'start_date', 'days', 'status']);
    expect(insert.lines[0]).toEqual({
      field: 'leave_type_id',
      labelKey: 'audit.fields.leave_request.leave_type_id',
      before: null,
      after: { kind: 'text', text: 'Congé annuel' },
    });
    expect(insert.lines[3]?.after).toEqual({ kind: 'key', key: 'leave.status.pending', text: 'pending' });

    expect((approved as ChangeView).lines[0]).toMatchObject({
      before: { kind: 'key', key: 'leave.status.pending' },
      after: { kind: 'key', key: 'leave.status.approved' },
    });
    const taskLines = (task as ChangeView).lines;
    expect(taskLines[1]?.after).toEqual({ kind: 'key', key: 'audit.values.workflow_task.outcome.approve', text: 'approve' });
    // acted_by is a user: named from the entries' actors.
    expect(taskLines[2]?.after).toEqual({ kind: 'text', text: 'Karim Haddad' });

    expect(event as EventView).toMatchObject({ sentenceKey: 'audit.events.workflow.approve', params: { step: 'RH régionales' } });
  });

  it('documents rows: short SHA-256 fingerprints, scan_status as a key, unnamed signatory/category ids hidden', () => {
    const hex = 'ab12'.repeat(16);
    const [group] = buildTimeline(
      [
        {
          id: 'c:9',
          at: '2026-09-26T10:00:00Z',
          actor: null,
          requestId: null,
          kind: 'change',
          table: 'employee_file',
          op: 'insert',
          changes: [
            { field: 'category_id', before: null, after: 'c-diploma', masked: false },
            { field: 'sha256', before: null, after: `\\x${hex}`, masked: false },
            { field: 'scan_status', before: null, after: 'not_scanned', masked: false },
            { field: 'uploaded_by', before: null, after: 'u-x', masked: false },
          ],
        },
      ],
      (kind, value) => (kind === 'fileCategory' && value === 'c-diploma' ? 'Diplômes' : undefined),
      NOW,
    );
    const entry = group?.entries[0] as ChangeView;
    const lines = entry.lines.map((l) => [l.field, l.after]);
    expect(lines).toEqual([
      ['category_id', { kind: 'text', text: 'Diplômes' }],
      ['sha256', { kind: 'hash', hex, short: 'ab12ab12ab12' }],
      ['scan_status', { kind: 'key', key: 'audit.values.employee_file.scan_status.not_scanned', text: 'not_scanned' }],
      // A user id stays as stored when nobody names it (an admin may recognise it); a signatory/category id does not.
      ['uploaded_by', { kind: 'text', text: 'u-x' }],
    ]);

    const [unnamed] = buildTimeline(
      [{ id: 'c:10', at: '2026-09-26T10:00:00Z', actor: null, requestId: null, kind: 'change', table: 'issued_document', op: 'insert',
        changes: [{ field: 'signatory_id', before: null, after: 's-1', masked: false }] }],
      NO_NAMES,
      NOW,
    );
    const unnamedEntry = unnamed?.entries[0] as ChangeView;
    expect(unnamedEntry.lines[0]?.after).toEqual({ kind: 'unnamed' });
  });
});
