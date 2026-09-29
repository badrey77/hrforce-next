import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertRehireDate,
  employeeActions,
  EmploymentRuleViolation,
  hasOpenEmployment,
  isPositiveMoney,
  planAssignment,
  planEnd,
  planSalary,
  referenceDate,
  scopeAssignment,
  statusOf,
} from './employee.js';

const a1 = { id: 'a1', validFrom: '2020-01-01', validTo: '2026-04-01' };
const a2 = { id: 'a2', validFrom: '2026-04-01', validTo: null };

function slugOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof EmploymentRuleViolation) return error.slug;
    throw error;
  }
  return undefined;
}

describe('employment rules', () => {
  it('date arithmetic across months, leap years and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('status as of a date', () => {
    expect(statusOf('2026-10-01', null, '2026-09-26')).toBe('future');
    expect(statusOf('2020-01-01', '2026-09-26', '2026-09-26')).toBe('active'); // end date is inclusive
    expect(statusOf('2020-01-01', '2026-09-25', '2026-09-26')).toBe('ended');
  });

  it('scope assignment: valid on the date, else the last one started before, else the first', () => {
    expect(scopeAssignment([a2, a1], '2026-03-31')?.id).toBe('a1');
    expect(scopeAssignment([a1, a2], '2026-04-01')?.id).toBe('a2');
    const ended = [{ id: 'x', validFrom: '2020-01-01', validTo: '2021-01-01' }, { id: 'y', validFrom: '2021-01-01', validTo: '2022-01-01' }];
    expect(scopeAssignment(ended, '2026-01-01')?.id).toBe('y');
    expect(scopeAssignment([{ id: 'f', validFrom: '2027-01-01', validTo: null }], '2026-01-01')?.id).toBe('f');
    expect(scopeAssignment([], '2026-01-01')).toBeUndefined();
  });

  it('reference date: clamped into [validFrom, validTo - 1]', () => {
    expect(referenceDate(a1, '2026-09-26')).toBe('2026-03-31');
    expect(referenceDate(a2, '2026-01-01')).toBe('2026-04-01');
    expect(referenceDate(a2, '2026-09-26')).toBe('2026-09-26');
  });

  it('new assignment: after the current start, within the employment', () => {
    expect(planAssignment([a1, a2], '2020-01-01', '2026-05-01').close?.id).toBe('a2');
    expect(slugOf(() => planAssignment([a1, a2], '2020-01-01', '2026-04-01'))).toBe('assignment-date');
    expect(slugOf(() => planAssignment([], '2020-01-01', '2019-12-31'))).toBe('assignment-date');
  });

  it('new salary: not before hire, after the current start', () => {
    const s = [{ id: 's1', validFrom: '2020-01-01', validTo: null }];
    expect(planSalary(s, '2020-01-01', '2026-01-01').close?.id).toBe('s1');
    expect(slugOf(() => planSalary(s, '2020-01-01', '2020-01-01'))).toBe('salary-date');
    expect(slugOf(() => planSalary([], '2020-01-01', '2019-01-01'))).toBe('salary-date');
    expect(planSalary([], '2020-01-01', '2020-01-01').close).toBeUndefined();
  });

  it('end: inclusive end date → ranges closed at endDate + 1; not before the current assignment / salary', () => {
    const plan = planEnd([a1, a2], [{ id: 's', validFrom: '2026-01-01', validTo: null }], '2020-01-01', '2026-06-30');
    expect(plan).toMatchObject({ validTo: '2026-07-01', closeAssignment: { id: 'a2' }, closeSalary: { id: 's' } });
    expect(slugOf(() => planEnd([a1, a2], [], '2020-01-01', '2026-03-31'))).toBe('end-date');
    expect(slugOf(() => planEnd([a1], [{ id: 's', validFrom: '2026-06-01', validTo: null }], '2020-01-01', '2026-03-01'))).toBe('end-date');
    // the end day may be the start day of the current assignment
    expect(planEnd([a1, a2], [], '2020-01-01', '2026-04-01').validTo).toBe('2026-04-02');
  });

  it('rehire after the previous end', () => {
    expect(slugOf(() => assertRehireDate('2026-06-30', '2026-06-30'))).toBe('hire-date');
    expect(slugOf(() => assertRehireDate('2026-06-30', '2026-07-01'))).toBeUndefined();
    expect(slugOf(() => assertRehireDate(null, '2000-01-01'))).toBeUndefined();
  });

  it('open employment: no end date, or an end date on or after today', () => {
    const today = '2026-09-29';
    expect(hasOpenEmployment([{ endDate: '2026-03-31' }, { endDate: null }], today)).toBe(true);
    expect(hasOpenEmployment([{ endDate: '2026-09-29' }], today)).toBe(true);
    expect(hasOpenEmployment([{ endDate: '2026-12-31' }], today)).toBe(true);
    expect(hasOpenEmployment([{ endDate: '2026-09-28' }, { endDate: '2020-01-31' }], today)).toBe(false);
    expect(hasOpenEmployment([], today)).toBe(false);
  });

  it('money: positive decimal strings, ≤ 10 integer digits, ≤ 2 decimals', () => {
    for (const ok of ['1', '85000', '85000.5', '85000.00', '9999999999.99']) expect(isPositiveMoney(ok), ok).toBe(true);
    for (const bad of ['0', '0.00', '-1', '1.234', '12345678901', '1e5', '', ' 1']) expect(isPositiveMoney(bad), bad).toBe(false);
  });

  it('actions: none once ended; per permission otherwise', () => {
    const all = { update: true, salaryUpdate: true, bankUpdate: true, nssUpdate: true };
    expect(employeeActions(false, all)).toEqual([]);
    expect(employeeActions(true, all)).toEqual(['update', 'assign', 'end', 'update_salary', 'update_bank', 'update_nss']);
    expect(employeeActions(true, { ...all, update: false, bankUpdate: false })).toEqual(['update_salary', 'update_nss']);
  });
});
