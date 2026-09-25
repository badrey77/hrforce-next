import { describe, expect, it } from 'vitest';
import { OrgRuleViolation } from './org-unit.js';
import { covers, isIsoDate, planNewVersion, sortVersions, toIsoDate, versionAt, type OrgUnitVersionData } from './versions.js';

const oran: OrgUnitVersionData = { validFrom: '2026-01-01', validTo: '2026-03-01', name: 'Oran', parentId: 'r1' };
const history: OrgUnitVersionData[] = [{ validFrom: '2026-03-01', validTo: null, name: 'Oran Centre', parentId: 'r2' }, oran];

describe('org unit versions', () => {
  it('ISO dates', () => {
    expect(isIsoDate('2026-01-31')).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
    expect(isIsoDate('2026-01-01T00:00:00Z')).toBe(false);
    expect(toIsoDate(new Date(2026, 8, 5, 23, 59))).toBe('2026-09-05');
  });

  it('[from, to) coverage and lookup', () => {
    expect(covers(oran, '2026-01-01')).toBe(true);
    expect(covers(oran, '2026-03-01')).toBe(false);
    expect(versionAt(history, '2025-12-31')).toBeUndefined();
    expect(versionAt(history, '2026-02-28')?.name).toBe('Oran');
    expect(versionAt(history, '2026-03-01')?.name).toBe('Oran Centre');
    expect(versionAt(history, '2099-01-01')?.name).toBe('Oran Centre');
    expect(sortVersions(history).map((v) => v.validFrom)).toEqual(['2026-01-01', '2026-03-01']);
  });

  it('a new version from validFrom closes the current one and copies unchanged values', () => {
    const plan = planNewVersion(history, { validFrom: '2026-06-01', parentId: 'r3' });
    expect(plan.current.validFrom).toBe('2026-03-01');
    expect(plan.next).toEqual({ validFrom: '2026-06-01', validTo: null, name: 'Oran Centre', parentId: 'r3' });
    expect(plan).toMatchObject({ moved: true, renamed: false });

    const rename = planNewVersion(history, { validFrom: '2026-06-01', name: 'Oran Ouest', parentId: 'r2' });
    expect(rename).toMatchObject({ moved: false, renamed: true });
  });

  it('validFrom must be strictly after the current version start (org-unit-version-overlap)', () => {
    for (const validFrom of ['2026-03-01', '2026-02-01', '2025-01-01']) {
      let error: unknown;
      try {
        planNewVersion(history, { validFrom, name: 'x' });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(OrgRuleViolation);
      expect(error).toMatchObject({ slug: 'org-unit-version-overlap', field: 'validFrom' });
    }
  });
});
