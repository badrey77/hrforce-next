import { describe, expect, it } from 'vitest';
import {
  AccessRuleViolation,
  addedPermissions,
  assertEndDate,
  assertNewGrantDates,
  assertNotSelf,
  isCurrentOrFuture,
  isEffective,
} from './access-rules.js';
import { PERMISSION_CODES, ROLE_CODE_PATTERN, SYSTEM_ROLES } from './catalogue.js';

function slugOf(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof AccessRuleViolation ? `${error.slug}:${error.field ?? ''}` : 'other';
  }
}

describe('separation of duties / dates', () => {
  it('grant-self', () => {
    expect(slugOf(() => assertNotSelf('a', 'a', 'grant'))).toBe('grant-self:userId');
    expect(slugOf(() => assertNotSelf('a', 'a', 'end'))).toBe('grant-self:userId');
    expect(slugOf(() => assertNotSelf('a', 'b', 'grant'))).toBeUndefined();
  });

  it('new grants: validTo must be after validFrom (open end allowed)', () => {
    expect(slugOf(() => assertNewGrantDates('2026-10-01', null))).toBeUndefined();
    expect(slugOf(() => assertNewGrantDates('2026-10-01', '2026-10-02'))).toBeUndefined();
    expect(slugOf(() => assertNewGrantDates('2026-10-01', '2026-10-01'))).toBe('grant-dates:validTo');
    expect(slugOf(() => assertNewGrantDates('2026-10-01', '2026-09-30'))).toBe('grant-dates:validTo');
  });

  it('ending: validFrom ≤ validTo ≤ current end', () => {
    const open = { validFrom: '2026-01-01', validTo: null };
    const closed = { validFrom: '2026-01-01', validTo: '2026-12-31' };
    expect(slugOf(() => assertEndDate(open, '2026-01-01'))).toBeUndefined();
    expect(slugOf(() => assertEndDate(open, '2099-01-01'))).toBeUndefined();
    expect(slugOf(() => assertEndDate(open, '2025-12-31'))).toBe('grant-dates:validTo');
    expect(slugOf(() => assertEndDate(closed, '2026-12-31'))).toBeUndefined();
    expect(slugOf(() => assertEndDate(closed, '2027-01-01'))).toBe('grant-dates:validTo');
  });

  it('effective / current-or-future on [from, to)', () => {
    expect(isEffective({ validFrom: '2026-01-01', validTo: null }, '2026-01-01')).toBe(true);
    expect(isEffective({ validFrom: '2026-01-02', validTo: null }, '2026-01-01')).toBe(false);
    expect(isEffective({ validFrom: '2026-01-01', validTo: '2026-02-01' }, '2026-01-31')).toBe(true);
    expect(isEffective({ validFrom: '2026-01-01', validTo: '2026-02-01' }, '2026-02-01')).toBe(false);
    expect(isCurrentOrFuture({ validTo: '2026-02-01' }, '2026-02-01')).toBe(false);
    expect(isCurrentOrFuture({ validTo: null }, '2026-02-01')).toBe(true);
  });

  it('addedPermissions', () => {
    expect(addedPermissions(['a', 'b'], ['b', 'c', 'c'])).toEqual(['c']);
    expect(addedPermissions(['a'], [])).toEqual([]);
  });
});

describe('system roles', () => {
  const byCode = new Map(SYSTEM_ROLES.map((r) => [r.code, r]));

  it('admin_rh_central holds everything except employee.medical.read; nobody holds medical', () => {
    expect(byCode.get('admin_rh_central')?.permissions).toEqual(PERMISSION_CODES.filter((c) => c !== 'employee.medical.read'));
    expect(SYSTEM_ROLES.some((r) => r.permissions.includes('employee.medical.read'))).toBe(false);
  });

  it('match the contract table', () => {
    expect(byCode.get('rh_regional')?.permissions).toEqual([
      'org_unit.read', 'site.read', 'employee.read', 'employee.create', 'employee.update',
      'leave.read', 'leave.request', 'leave.approve_hr', 'leave.adjust',
      'document.read', 'document.issue',
    ]);
    expect(byCode.get('employe')?.permissions).toEqual(['leave.request_self', 'document.request_self']);
    expect(byCode.get('lecture')?.permissions).toEqual(['org_unit.read', 'site.read', 'employee.read']);
    expect(byCode.get('admin_acces')?.permissions).toEqual(['org_unit.read', 'site.read', 'access.read', 'access.grant', 'access.manage_roles', 'audit.read']);
    for (const role of SYSTEM_ROLES) {
      expect(role.code).toMatch(ROLE_CODE_PATTERN);
      expect(role.names.ar).toMatch(/[؀-ۿ]/);
    }
  });
});
