import { describe, expect, it } from 'vitest';
import { decideAccrual, daysWorkedIn, monthIndex, parseMonth, type AccrualInput } from './accrual.js';
import {
  allocateTaken,
  availableOn,
  canCancel,
  checkRequest,
  isPeriodStart,
  isWeekendSet,
  LeaveRuleViolation,
  periodBalances,
  periodEndOf,
  periodStartOf,
  type RequestFacts,
  type TypeRules,
} from './rules.js';

function slugOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LeaveRuleViolation) return error.slug;
    throw error;
  }
  return undefined;
}

const facts = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  startDate: '2026-10-04',
  endDate: '2026-10-08',
  days: 50,
  documentRef: null,
  employment: { hireDate: '2020-01-01', endDate: null },
  overlaps: false,
  alreadyTaken: false,
  available: 300,
  ...over,
});


const input = (over: Partial<AccrualInput> = {}): AccrualInput => ({
  month: '2026-09-01',
  hireDate: '2020-01-01',
  endDate: null,
  ratePerMonth: 25,
  maxPerYear: 300,
  supplementPerYear: 0,
  referenceStartMonth: 7,
  accruedSoFar: 0,
  ...over,
});

describe('reference years (1 July start)', () => {
  it('period of a date, end, valid starts', () => {
    expect(periodStartOf('2026-09-26', 7)).toBe('2026-07-01');
    expect(periodStartOf('2026-07-01', 7)).toBe('2026-07-01');
    expect(periodStartOf('2026-06-30', 7)).toBe('2025-07-01');
    expect(periodStartOf('2026-03-10', 1)).toBe('2026-01-01');
    expect(periodEndOf('2026-07-01')).toBe('2027-06-30');
    expect(periodEndOf('2027-07-01')).toBe('2028-06-30');
    expect(isPeriodStart('2026-07-01', 7)).toBe(true);
    expect(isPeriodStart('2026-07-02', 7)).toBe(false);
    expect(isPeriodStart('2026-01-01', 7)).toBe(false);
  });
});

describe('balances and allocation', () => {
  const sums = [
    { periodStart: '2026-07-01', accrual: 75, taken: 0, adjustment: 0, reversal: 0 },
    { periodStart: '2025-07-01', accrual: 300, taken: -50, adjustment: 20, reversal: 10 },
  ];
  const periods = periodBalances(sums, true, 12);

  it('per year: oldest first, availability 12 months after the start, reversals give back', () => {
    expect(periods).toEqual([
      { periodStart: '2025-07-01', periodEnd: '2026-06-30', availableFrom: '2026-07-01', accrued: 300, taken: -40, adjusted: 20, balance: 280 },
      { periodStart: '2026-07-01', periodEnd: '2027-06-30', availableFrom: '2027-07-01', accrued: 75, taken: 0, adjusted: 0, balance: 75 },
    ]);
    // non-accrued types (recovery) are usable at once
    expect(periodBalances(sums, false, 12)[1]?.availableFrom).toBe('2026-07-01');
  });

  it('available on a date counts only the years already usable', () => {
    expect(availableOn(periods, '2026-10-01')).toBe(280);
    expect(availableOn(periods, '2027-07-01')).toBe(355);
    expect(availableOn(periods, '2026-06-30')).toBe(0);
  });

  it('taken days go to the oldest usable year with remaining days first', () => {
    const two = periodBalances(
      [
        { periodStart: '2024-07-01', accrual: 30, taken: 0, adjustment: 0, reversal: 0 },
        { periodStart: '2025-07-01', accrual: 300, taken: 0, adjustment: 0, reversal: 0 },
      ],
      true,
      12,
    );
    expect(allocateTaken(two, '2026-10-01', 50)).toEqual([
      { periodStart: '2024-07-01', days: 30 },
      { periodStart: '2025-07-01', days: 20 },
    ]);
    expect(allocateTaken(two, '2026-10-01', 330)).toHaveLength(2);
    expect(allocateTaken(two, '2026-10-01', 331)).toBeNull();
    // before 1 July 2026 the 2025-26 year is not usable yet
    expect(allocateTaken(two, '2026-06-01', 50)).toBeNull();
  });
});

describe('checkRequest', () => {
  const annual: TypeRules = { active: true, hasBalance: true, maxDaysPerRequest: null, oncePerCareer: false, requiresDocument: false };
  it('passes a valid request', () => {
    expect(slugOf(() => checkRequest(annual, facts()))).toBeUndefined();
  });

  it('dates: before the hire date or after the end of the employment', () => {
    expect(slugOf(() => checkRequest(annual, facts({ employment: { hireDate: '2026-10-05', endDate: null } })))).toBe('leave-dates');
    expect(slugOf(() => checkRequest(annual, facts({ employment: { hireDate: '2020-01-01', endDate: '2026-10-07' } })))).toBe('leave-dates');
    expect(slugOf(() => checkRequest(annual, facts({ startDate: '2026-10-09' })))).toBe('leave-dates');
  });

  it('document, max per request, once per career, overlap, balance (incl. pending), inactive', () => {
    expect(slugOf(() => checkRequest({ ...annual, requiresDocument: true }, facts()))).toBe('leave-document-required');
    expect(slugOf(() => checkRequest({ ...annual, requiresDocument: true }, facts({ documentRef: 'CM-1' })))).toBeUndefined();
    expect(slugOf(() => checkRequest({ ...annual, maxDaysPerRequest: 30 }, facts({ days: 35 })))).toBe('leave-max-request');
    expect(slugOf(() => checkRequest({ ...annual, maxDaysPerRequest: 30 }, facts({ days: 30 })))).toBeUndefined();
    expect(slugOf(() => checkRequest({ ...annual, oncePerCareer: true }, facts({ alreadyTaken: true })))).toBe('leave-once-per-career');
    expect(slugOf(() => checkRequest(annual, facts({ overlaps: true })))).toBe('leave-overlap');
    expect(slugOf(() => checkRequest(annual, facts({ available: 49 })))).toBe('leave-balance');
    expect(slugOf(() => checkRequest(annual, facts({ available: 50 })))).toBeUndefined();
    expect(slugOf(() => checkRequest({ ...annual, hasBalance: false }, facts({ available: 0 })))).toBeUndefined();
    expect(slugOf(() => checkRequest({ ...annual, active: false }, facts()))).toBe('leave-type-inactive');
  });
});

describe('cancellation and policy', () => {
  it('pending always; approved only before it starts', () => {
    expect(canCancel('pending', '2026-01-01', '2026-09-26')).toBe(true);
    expect(canCancel('approved', '2026-09-27', '2026-09-26')).toBe(true);
    expect(canCancel('approved', '2026-09-26', '2026-09-26')).toBe(false);
    expect(canCancel('rejected', '2027-01-01', '2026-09-26')).toBe(false);
    expect(canCancel('cancelled', '2027-01-01', '2026-09-26')).toBe(false);
  });

  it('weekend sets', () => {
    expect(isWeekendSet([5, 6])).toBe(true);
    expect(isWeekendSet([])).toBe(true);
    expect(isWeekendSet([5, 5])).toBe(false);
    expect(isWeekendSet([0])).toBe(false);
    expect(isWeekendSet([1, 2, 3, 4])).toBe(false);
  });
});

describe('accrual', () => {
  it('a full month earns 2.5 days in the reference year of the month', () => {
    expect(decideAccrual(input())).toEqual({ daysWorked: 30, counts: true, periodStart: '2026-07-01', days: 25 });
    expect(decideAccrual(input({ month: '2026-03-01' }))).toMatchObject({ periodStart: '2025-07-01', days: 25 });
  });

  it('≥ 15 days worked counts the month; 14 does not (hire or end inside the month)', () => {
    expect(daysWorkedIn('2026-09-01', '2026-09-16', null)).toBe(15);
    expect(decideAccrual(input({ hireDate: '2026-09-16' })).days).toBe(25);
    expect(decideAccrual(input({ hireDate: '2026-09-17' }))).toMatchObject({ daysWorked: 14, counts: false, days: 0 });
    expect(decideAccrual(input({ endDate: '2026-09-15' })).days).toBe(25);
    expect(decideAccrual(input({ endDate: '2026-09-14' })).days).toBe(0);
    // February of a leap year: 29 days; hired on the 15th → 15 days
    expect(daysWorkedIn('2028-02-01', '2028-02-15', null)).toBe(15);
    expect(decideAccrual(input({ month: '2026-09-01', hireDate: '2026-10-01' })).days).toBe(0);
  });

  it('the year is capped at max_days_per_year', () => {
    expect(decideAccrual(input({ accruedSoFar: 290 })).days).toBe(10);
    expect(decideAccrual(input({ accruedSoFar: 300 })).days).toBe(0);
    expect(decideAccrual(input({ maxPerYear: null, accruedSoFar: 300 })).days).toBe(25);
  });

  it('southern supplement: spread with cumulative rounding, a full year earns exactly S', () => {
    let total = 0;
    for (let k = 0; k < 12; k++) {
      const month = `${k < 6 ? 2026 : 2027}-${String(((6 + k) % 12) + 1).padStart(2, '0')}-01`;
      const d = decideAccrual(input({ month, supplementPerYear: 10, accruedSoFar: total }));
      total += d.days;
    }
    expect(total).toBe(400); // 30 + 10 days
    expect(monthIndex('2026-07-01', '2027-06-01')).toBe(12);
  });

  it('parses YYYY-MM', () => {
    expect(parseMonth('2026-09')).toBe('2026-09-01');
    expect(parseMonth('2026-13')).toBeNull();
    expect(parseMonth('2026-9')).toBeNull();
  });
});
