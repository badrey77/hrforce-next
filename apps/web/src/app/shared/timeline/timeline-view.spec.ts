import { CREATED, GRANT_ROW, GRANTED, MASKED, RENAMED } from '../../../testing/audit-fixtures';
import { type AuditNameResolver, buildTimeline, type ChangeView, type EventView, NO_NAMES } from './timeline-view';

const NOW = new Date(2026, 8, 26, 14); // local 2026-09-26 14:00

const NAMES: Record<string, Record<string, string>> = {
  unit: { dg: 'Direction générale', 'r-ouest': 'Région Ouest' },
  roleCode: { lecture: 'Lecture' },
  role: { 'role-lecture': 'Lecture' },
};
const names: AuditNameResolver = (kind, value) => NAMES[kind]?.[value];

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
      { kind: 'text', text: '2026-10-01' },
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
});
