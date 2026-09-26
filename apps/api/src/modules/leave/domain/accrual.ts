/**
 * Monthly accrual of leave entitlement (docs/contracts/leave.md › Balance; Law 90-11 art. 41–42). Pure domain code.
 *
 *  - A calendar month COUNTS when the employee worked at least {@link MIN_DAYS_WORKED} days of it, i.e. at least
 *    15 days of the month fall inside the employment [hire date, end date]. (Absences are not tracked yet: a month of
 *    employment is a month of work. Unpaid leave / long sickness deductions come with the M2 worker.)
 *  - A counted month earns the type's `accrual_days_per_month` (2.5 for annual leave), in the reference year that
 *    contains the month (policy `reference_start_month`, 1 July by default).
 *  - Southern supplement (site `south_supplement_days` = S per year): spread over the 12 months of the reference year
 *    with cumulative rounding to 0.1 day, so a full year earns exactly S — month k (1…12) earns
 *    round(S·k/12) − round(S·(k−1)/12).
 *  - Cap: the year's accruals never exceed `max_days_per_year` (+ S). With 2.5 × 12 = 30 the cap only matters when
 *    the rate or the maximum is edited.
 *  - Idempotency is the database's (one accrual row per employment / type / month); this function only decides.
 */
import { addMonths, inclusiveDays, maxDate, minDate, monthEnd } from './dates.js';
import { periodStartOf } from './rules.js';

export const MIN_DAYS_WORKED = 15;

export interface AccrualInput {
  /** first day of the month accrued, YYYY-MM-01 */
  month: string;
  hireDate: string;
  endDate: string | null;
  /** tenths of a day per counted month */
  ratePerMonth: number;
  /** tenths per reference year, or null (no cap) */
  maxPerYear: number | null;
  /** whole days per reference year (site supplement), 0 = none */
  supplementPerYear: number;
  referenceStartMonth: number;
  /** tenths already accrued in the same reference year (months before this one) */
  accruedSoFar: number;
}

export interface AccrualDecision {
  daysWorked: number;
  counts: boolean;
  periodStart: string;
  /** tenths to accrue (0 = nothing to write) */
  days: number;
}

/** Days of `month` inside the employment. */
export function daysWorkedIn(month: string, hireDate: string, endDate: string | null): number {
  const from = maxDate(month, hireDate);
  const to = minDate(monthEnd(month), endDate ?? monthEnd(month));
  return inclusiveDays(from, to);
}

/** 1 … 12: position of `month` in the reference year starting on `periodStart`. */
export function monthIndex(periodStart: string, month: string): number {
  for (let k = 0; k < 12; k++) if (addMonths(periodStart, k) === month) return k + 1;
  throw new Error(`${month} is not in the reference year starting ${periodStart}`);
}

export function decideAccrual(input: AccrualInput): AccrualDecision {
  const periodStart = periodStartOf(input.month, input.referenceStartMonth);
  const daysWorked = daysWorkedIn(input.month, input.hireDate, input.endDate);
  const counts = daysWorked >= MIN_DAYS_WORKED;
  if (!counts) return { daysWorked, counts, periodStart, days: 0 };
  const k = monthIndex(periodStart, input.month);
  const supplementTenths = input.supplementPerYear * 10;
  const supplement = Math.round((supplementTenths * k) / 12) - Math.round((supplementTenths * (k - 1)) / 12);
  let days = input.ratePerMonth + supplement;
  if (input.maxPerYear !== null) days = Math.min(days, Math.max(0, input.maxPerYear + supplementTenths - input.accruedSoFar));
  return { daysWorked, counts, periodStart, days };
}

/** `YYYY-MM` → the first day of that month (null when malformed). */
export function parseMonth(value: string): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return match ? `${match[1]}-${match[2]}-01` : null;
}
