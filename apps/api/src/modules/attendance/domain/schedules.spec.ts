import { describe, expect, it } from 'vitest';
import { AssignmentIndex, dayRuleOf, type AssignmentFact, type OverrideFact, type VersionFact } from './schedules.js';
import { STANDARD_WEEK, type Week } from './week.js';

const a = (id: string, targetKind: AssignmentFact['targetKind'], targetId: string | null, from = '2026-01-01', to: string | null = null): AssignmentFact => ({
  id,
  scheduleId: `s-${id}`,
  targetKind,
  targetId,
  from,
  to,
});

const placement = { employmentId: 'e1', unitId: 'u-agency', unitChain: ['u-agency', 'u-region', 'u-root'], siteId: 'site-1' };

describe('schedule resolution: employment > unit > ancestor unit > site > company', () => {
  const all = [a('company', 'company', null, '2000-01-01'), a('site', 'site', 'site-1'), a('region', 'unit', 'u-region'), a('agency', 'unit', 'u-agency'), a('emp', 'employment', 'e1')];

  it('picks each level in order as the more specific ones are removed', () => {
    const order: string[] = [];
    let list = [...all];
    for (let i = 0; i < 5; i++) {
      const r = new AssignmentIndex(list).resolve(placement, '2026-09-27');
      if (!r) break;
      order.push(`${r.source}:${r.assignment.id}`);
      list = list.filter((x) => x.id !== r.assignment.id);
    }
    expect(order).toEqual(['employment:emp', 'unit:agency', 'unit:region', 'site:site', 'company:company']);
  });

  it('honours the validity ranges ([from, to))', () => {
    const idx = new AssignmentIndex([a('company', 'company', null, '2000-01-01'), a('emp', 'employment', 'e1', '2026-09-01', '2026-09-27')]);
    expect(idx.resolve(placement, '2026-09-26')?.source).toBe('employment');
    expect(idx.resolve(placement, '2026-09-27')?.source).toBe('company');
    expect(idx.resolve(placement, '2026-08-31')?.source).toBe('company');
  });

  it('no site → skips the site level; nothing → null', () => {
    expect(new AssignmentIndex([a('site', 'site', 'site-1')]).resolve({ ...placement, siteId: null }, '2026-09-27')).toBeNull();
  });
});

describe('day rule: schedule override > company-wide override > version', () => {
  const ramadan: Week = [1, 2, 3, 4, 5, 6, 7].map((d) =>
    d === 5 || d === 6 ? { day: d as 5 | 6, rest: true as const } : { day: d as 1, start: '09:00', end: '16:00', breakStart: null, breakEnd: null },
  );
  const versions: VersionFact[] = [
    { id: 'v1', scheduleId: 'std', from: '2000-01-01', to: '2026-10-01', week: STANDARD_WEEK, toleranceMinutes: 10 },
    { id: 'v2', scheduleId: 'std', from: '2026-10-01', to: null, week: STANDARD_WEEK, toleranceMinutes: 5 },
  ];
  const override = (id: string, scheduleId: string | null, from: string, toExclusive: string, tolerance = 0): OverrideFact => ({
    id,
    scheduleId,
    labels: { fr: id, ar: id, en: id },
    from,
    toExclusive,
    week: ramadan,
    toleranceMinutes: tolerance,
    approximate: true,
  });

  it('versions by date', () => {
    expect(dayRuleOf('std', '2026-09-27', versions, [])).toMatchObject({ toleranceMinutes: 10, override: null, version: { id: 'v1' } });
    expect(dayRuleOf('std', '2026-10-04', versions, [])?.toleranceMinutes).toBe(5);
    expect(dayRuleOf('std', '2026-10-02', versions, [])?.entry).toEqual({ day: 5, rest: true });
  });

  it('an override inside a version wins for its dates only; a schedule override beats a company-wide one', () => {
    const overrides = [override('all', null, '2026-09-20', '2026-09-30', 15), override('mine', 'std', '2026-09-27', '2026-09-28', 20)];
    expect(dayRuleOf('std', '2026-09-27', versions, overrides)).toMatchObject({ toleranceMinutes: 20, override: { id: 'mine' } });
    expect(dayRuleOf('std', '2026-09-28', versions, overrides)).toMatchObject({ toleranceMinutes: 15, override: { id: 'all' } });
    expect(dayRuleOf('other', '2026-09-27', [{ ...versions[0], scheduleId: 'other' } as VersionFact], overrides)?.override?.id).toBe('all');
    expect(dayRuleOf('std', '2026-09-30', versions, overrides)?.override).toBeNull();
  });

  it('no version covering the date → null', () => {
    expect(dayRuleOf('std', '1999-12-31', versions, [])).toBeNull();
  });
});
