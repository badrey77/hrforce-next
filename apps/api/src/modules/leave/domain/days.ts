/**
 * Leave days calculator (docs/contracts/leave.md › Leave): how many days a request takes, from the type's counting
 * mode, the company's weekend and public holidays, and half days. Pure domain code (no Nest, no Kysely).
 *
 * Rules
 *  - `calendar` mode (annual leave, Law 90-11): every day of [start, end] counts, weekends and holidays included
 *    (they are reported in the breakdown for information only).
 *  - `working` mode: a day counts unless it is a weekend day (policy `weekend_days`, ISO numbers) or a public holiday.
 *  - Half days: `halfDayStart` = the first day counts half (leave starts at noon), `halfDayEnd` = the last day counts
 *    half (leave ends at noon). On a one-day request either flag makes it a half day; both flags on one day are
 *    refused (`leave-dates`). A half flag on a day that does not count (weekend / holiday in working mode) changes
 *    nothing.
 *  - Results are exact multiples of 0.5 (computed in half-day units).
 *  - end < start → `leave-dates`; a request that counts 0 days (e.g. only a weekend in working mode) → `leave-dates`.
 */
import { eachDay, inclusiveDays, isoWeekday } from './dates.js';
import { LeaveRuleViolation } from './rules.js';

export type CountMode = 'calendar' | 'working';

export interface Holiday {
  date: string;
  name: string;
}

export interface DaysInput {
  startDate: string;
  endDate: string;
  halfDayStart: boolean;
  halfDayEnd: boolean;
  countMode: CountMode;
  /** ISO weekday numbers (1 = Monday … 7 = Sunday), e.g. [5, 6] = Friday + Saturday */
  weekendDays: readonly number[];
  holidays: readonly Holiday[];
}

export interface DaysBreakdown {
  /** days of [start, end] */
  calendarDays: number;
  /** weekend days inside the range */
  weekendDays: number;
  /** public holidays inside the range (all of them, whatever the mode; in working mode those on a weekend day do not count twice) */
  holidays: Holiday[];
  /** half days deducted (0–2) */
  halfDays: number;
}

export interface DaysResult {
  days: number;
  breakdown: DaysBreakdown;
}

export function computeLeaveDays(input: DaysInput): DaysResult {
  const { startDate, endDate, halfDayStart, halfDayEnd, countMode } = input;
  if (endDate < startDate) throw new LeaveRuleViolation('leave-dates', 'The end date is before the start date.', 'endDate');
  if (startDate === endDate && halfDayStart && halfDayEnd) {
    throw new LeaveRuleViolation('leave-dates', 'A one-day request cannot start and end at noon.', 'halfDayEnd');
  }
  const weekend = new Set(input.weekendDays);
  const holidayByDate = new Map(input.holidays.map((h) => [h.date, h]));
  const counts = (day: string) => countMode === 'calendar' || (!weekend.has(isoWeekday(day)) && !holidayByDate.has(day));

  let units = 0;
  let weekendDays = 0;
  const holidays: Holiday[] = [];
  for (const day of eachDay(startDate, endDate)) {
    if (weekend.has(isoWeekday(day))) weekendDays += 1;
    const holiday = holidayByDate.get(day);
    if (holiday) holidays.push({ date: holiday.date, name: holiday.name });
    if (counts(day)) units += 2;
  }
  let halfDays = 0;
  if (startDate === endDate) {
    if ((halfDayStart || halfDayEnd) && counts(startDate)) {
      units -= 1;
      halfDays = 1;
    }
  } else {
    if (halfDayStart && counts(startDate)) {
      units -= 1;
      halfDays += 1;
    }
    if (halfDayEnd && counts(endDate)) {
      units -= 1;
      halfDays += 1;
    }
  }
  const result: DaysResult = {
    days: units / 2,
    breakdown: { calendarDays: inclusiveDays(startDate, endDate), weekendDays, holidays, halfDays },
  };
  if (result.days <= 0) throw new LeaveRuleViolation('leave-dates', 'The request does not cover any counted day.', 'startDate');
  return result;
}
