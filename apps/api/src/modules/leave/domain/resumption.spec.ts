import { describe, expect, it } from 'vitest';
import { resumptionOf } from './resumption.js';

const weekend = [5, 6]; // Friday + Saturday

describe('resumptionOf', () => {
  it('is the next day when it is a working day', () => {
    // 2026-10-12 is a Monday → Tuesday
    expect(resumptionOf({ endDate: '2026-10-12', halfDayEnd: false, weekendDays: weekend, holidays: [] })).toEqual({ date: '2026-10-13', afternoon: false });
  });

  it('skips the weekend (Thursday end → Sunday)', () => {
    expect(resumptionOf({ endDate: '2026-10-15', halfDayEnd: false, weekendDays: weekend, holidays: [] })).toEqual({ date: '2026-10-18', afternoon: false });
  });

  it('skips public holidays after the weekend', () => {
    // Thursday 2026-10-29 → Fri, Sat weekend → Sun 1 Nov is a holiday (Revolution Day) → Monday 2 Nov
    expect(resumptionOf({ endDate: '2026-10-29', halfDayEnd: false, weekendDays: weekend, holidays: ['2026-11-01'] })).toEqual({ date: '2026-11-02', afternoon: false });
  });

  it('a leave ending at noon resumes the same afternoon', () => {
    expect(resumptionOf({ endDate: '2026-10-15', halfDayEnd: true, weekendDays: weekend, holidays: [] })).toEqual({ date: '2026-10-15', afternoon: true });
  });
});
