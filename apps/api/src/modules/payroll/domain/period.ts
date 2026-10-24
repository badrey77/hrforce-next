/**
 * Payroll months (docs/contracts/payroll-variables.md › Data, Endpoints): a month is stored as its first day
 * (`YYYY-MM-01`) and written `YYYY-MM` in URLs. Calendar arithmetic in UTC on ISO dates. Pure: no Nest, no Kysely.
 */

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;

/** `YYYY-MM` → `YYYY-MM-01`; null when malformed. */
export function parseMonth(value: string): string | null {
  return MONTH.test(value) ? `${value}-01` : null;
}

/** `YYYY-MM-01` → `YYYY-MM`. */
export function monthKey(month: string): string {
  return month.slice(0, 7);
}

/** The first day of the month of `date`, moved by `months`. */
export function monthOf(date: string, months = 0): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The last day of the month of `date`. */
export function lastDayOf(date: string): string {
  return addDays(monthOf(date, 1), -1);
}

/** Days of [from, to] inclusive (0 when to < from). */
export function inclusiveDays(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1);
}

/** Every date of [from, to] inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const maxDate = (a: string, b: string): string => (a > b ? a : b);
export const minDate = (a: string, b: string): string => (a < b ? a : b);

/** The date from which month `month` may be closed: its `cutoffDay` (1–28). */
export function cutoffDate(month: string, cutoffDay: number): string {
  return `${month.slice(0, 8)}${String(cutoffDay).padStart(2, '0')}`;
}

/** Two decimals, as numeric(12,2) stores them (half away from zero; −0 → 0). */
export function round2(value: number): number {
  const r = Math.sign(value) * Math.round(Math.abs(value) * 100 + Number.EPSILON) / 100;
  return r === 0 ? 0 : r;
}

export interface PeriodState {
  /** first day */
  month: string;
  status: 'open' | 'closed';
  /** the month has had at least one closing (a reopened month that stays open has one) */
  hasClosings: boolean;
}

export type CloseRefusal = 'payroll-before-cutoff' | 'payroll-period-closed' | 'payroll-previous-open';

/**
 * Whether month `month` may be closed today (POST …/close): not before its cut-off date, not already closed, and no
 * earlier month left open the wrong way — a month reopened and not closed again, or the previous month open while an
 * older month is closed. `periods`: the company's period rows (months without a row are open and never closed).
 */
export function closeRefusal(month: string, today: string, cutoffDay: number, periods: readonly PeriodState[]): CloseRefusal | null {
  const own = periods.find((p) => p.month === month);
  if (own?.status === 'closed') return 'payroll-period-closed';
  if (today < cutoffDate(month, cutoffDay)) return 'payroll-before-cutoff';
  const earlier = periods.filter((p) => p.month < month);
  if (earlier.some((p) => p.status === 'open' && p.hasClosings)) return 'payroll-previous-open';
  const previous = monthOf(month, -1);
  const previousClosed = earlier.some((p) => p.month === previous && p.status === 'closed');
  if (!previousClosed && earlier.some((p) => p.status === 'closed')) return 'payroll-previous-open';
  return null;
}

/** Whether `month` is the latest closed month (only that one may be reopened). */
export function isLatestClosed(month: string, periods: readonly PeriodState[]): boolean {
  return periods.some((p) => p.month === month && p.status === 'closed') && !periods.some((p) => p.month > month && p.status === 'closed');
}

/**
 * The closed months whose régularisations come into open month `month` (assumption 12): the closed months P with
 * `month - regularizationMonths <= P < month`, oldest first.
 */
export function regularizationOrigins(month: string, regularizationMonths: number, closedMonths: readonly string[]): string[] {
  const from = monthOf(month, -regularizationMonths);
  return [...new Set(closedMonths)].filter((p) => p >= from && p < month).toSorted();
}
