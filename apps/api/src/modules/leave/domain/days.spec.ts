import { describe, expect, it } from 'vitest';
import { addDays, addMonths, diffDays, isIsoDate, isoWeekday, monthEnd } from './dates.js';
import { computeLeaveDays, type DaysInput } from './days.js';
import { LeaveRuleViolation } from './rules.js';

const FRI_SAT = [5, 6];
const base = (over: Partial<DaysInput>): DaysInput => ({
  startDate: '2026-10-04',
  endDate: '2026-10-04',
  halfDayStart: false,
  halfDayEnd: false,
  countMode: 'working',
  weekendDays: FRI_SAT,
  holidays: [],
  ...over,
});

function slugOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof LeaveRuleViolation) return error.slug;
    throw error;
  }
  return undefined;
}

describe('dates', () => {
  it('ISO weekdays (2026-09-26 is a Saturday, 2026-10-04 a Sunday)', () => {
    expect(isoWeekday('2026-09-26')).toBe(6);
    expect(isoWeekday('2026-09-25')).toBe(5);
    expect(isoWeekday('2026-10-04')).toBe(7);
    expect(isoWeekday('2026-10-05')).toBe(1);
  });

  it('leap years, month ends and month arithmetic', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
    expect(monthEnd('2027-02-10')).toBe('2027-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-01-01', '2027-01-01')).toBe(365);
    expect(addMonths('2026-07-01', 12)).toBe('2027-07-01');
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01');
    expect(addMonths('2026-03-01', -3)).toBe('2025-12-01');
  });
});

describe('computeLeaveDays — working mode (Fri + Sat weekend)', () => {
  it('a Sunday → Thursday week is 5 days, no weekend', () => {
    const r = computeLeaveDays(base({ startDate: '2026-10-04', endDate: '2026-10-08' }));
    expect(r).toEqual({ days: 5, breakdown: { calendarDays: 5, weekendDays: 0, holidays: [], halfDays: 0 } });
  });

  it('skips the Friday + Saturday weekend (Sun 4 → Sat 17 Oct = 10 working days)', () => {
    const r = computeLeaveDays(base({ startDate: '2026-10-04', endDate: '2026-10-17' }));
    expect(r.days).toBe(10);
    expect(r.breakdown).toMatchObject({ calendarDays: 14, weekendDays: 4 });
  });

  it('a public holiday inside the range is not counted and is listed', () => {
    // 1 Nov 2026 is a Sunday (a working day in Algeria)
    const r = computeLeaveDays(
      base({ startDate: '2026-11-01', endDate: '2026-11-05', holidays: [{ date: '2026-11-01', name: 'Fête de la Révolution' }, { date: '2026-12-25', name: 'x' }] }),
    );
    expect(r.days).toBe(4);
    expect(r.breakdown.holidays).toEqual([{ date: '2026-11-01', name: 'Fête de la Révolution' }]);
  });

  it('a holiday on a weekend day does not count twice', () => {
    // 2 Oct 2026 is a Friday
    const r = computeLeaveDays(base({ startDate: '2026-09-27', endDate: '2026-10-03', holidays: [{ date: '2026-10-02', name: 'H' }] }));
    expect(r.days).toBe(5);
    expect(r.breakdown).toMatchObject({ weekendDays: 2, holidays: [{ date: '2026-10-02', name: 'H' }] });
  });

  it('half days at the start and at the end', () => {
    expect(computeLeaveDays(base({ startDate: '2026-10-04', endDate: '2026-10-08', halfDayStart: true })).days).toBe(4.5);
    expect(computeLeaveDays(base({ startDate: '2026-10-04', endDate: '2026-10-08', halfDayEnd: true })).days).toBe(4.5);
    const both = computeLeaveDays(base({ startDate: '2026-10-04', endDate: '2026-10-08', halfDayStart: true, halfDayEnd: true }));
    expect(both.days).toBe(4);
    expect(both.breakdown.halfDays).toBe(2);
  });

  it('a one-day request with a half flag is half a day; both flags on one day are refused', () => {
    expect(computeLeaveDays(base({ halfDayStart: true })).days).toBe(0.5);
    expect(computeLeaveDays(base({ halfDayEnd: true })).days).toBe(0.5);
    expect(slugOf(() => computeLeaveDays(base({ halfDayStart: true, halfDayEnd: true })))).toBe('leave-dates');
  });

  it('a half flag on a non-working end day changes nothing', () => {
    // ends on Friday 9 Oct: the Friday does not count, the half flag neither
    expect(computeLeaveDays(base({ startDate: '2026-10-04', endDate: '2026-10-09', halfDayEnd: true })).days).toBe(5);
  });

  it('a request covering only non-working days, or ending before it starts → leave-dates', () => {
    expect(slugOf(() => computeLeaveDays(base({ startDate: '2026-10-02', endDate: '2026-10-03' })))).toBe('leave-dates');
    expect(slugOf(() => computeLeaveDays(base({ startDate: '2026-10-05', endDate: '2026-10-04' })))).toBe('leave-dates');
    expect(slugOf(() => computeLeaveDays(base({ startDate: '2026-11-01', endDate: '2026-11-01', holidays: [{ date: '2026-11-01', name: 'H' }] })))).toBe('leave-dates');
  });

  it('another weekend (Sat + Sun) is data, not code', () => {
    expect(computeLeaveDays(base({ startDate: '2026-10-04', endDate: '2026-10-10', weekendDays: [6, 7] })).days).toBe(5);
  });
});

describe('computeLeaveDays — calendar mode', () => {
  it('counts every day, weekends and holidays included (reported in the breakdown)', () => {
    const r = computeLeaveDays(
      base({ countMode: 'calendar', startDate: '2026-10-30', endDate: '2026-11-03', holidays: [{ date: '2026-11-01', name: 'Révolution' }] }),
    );
    expect(r).toEqual({
      days: 5,
      breakdown: { calendarDays: 5, weekendDays: 2, holidays: [{ date: '2026-11-01', name: 'Révolution' }], halfDays: 0 },
    });
  });

  it('across a month end and a year end', () => {
    expect(computeLeaveDays(base({ countMode: 'calendar', startDate: '2026-09-28', endDate: '2026-10-02' })).days).toBe(5);
    expect(computeLeaveDays(base({ countMode: 'calendar', startDate: '2026-12-30', endDate: '2027-01-02' })).days).toBe(4);
  });

  it('leap year: 28 Feb → 1 Mar is 3 days in 2028, 2 days in 2027', () => {
    expect(computeLeaveDays(base({ countMode: 'calendar', startDate: '2028-02-28', endDate: '2028-03-01' })).days).toBe(3);
    expect(computeLeaveDays(base({ countMode: 'calendar', startDate: '2027-02-28', endDate: '2027-03-01' })).days).toBe(2);
  });

  it('30 calendar days of annual leave; half days still apply', () => {
    expect(computeLeaveDays(base({ countMode: 'calendar', startDate: '2026-07-01', endDate: '2026-07-30' })).days).toBe(30);
    expect(computeLeaveDays(base({ countMode: 'calendar', startDate: '2026-10-02', endDate: '2026-10-03', halfDayStart: true })).days).toBe(1.5);
    expect(computeLeaveDays(base({ countMode: 'calendar', startDate: '2026-10-02', endDate: '2026-10-02', halfDayEnd: true })).days).toBe(0.5);
  });
});
