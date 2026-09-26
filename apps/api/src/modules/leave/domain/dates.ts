/**
 * Calendar helpers on ISO dates (`YYYY-MM-DD`), computed in UTC so that no time zone or DST shift can move a day.
 * Pure: no Nest, no Kysely.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): [number, number, number] {
  const match = ISO_DATE.exec(date);
  if (!match) throw new Error(`not an ISO date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utc(date: string): number {
  const [y, m, d] = parts(date);
  return Date.UTC(y, m - 1, d);
}

/** A real calendar date written YYYY-MM-DD (2026-02-30 is not). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return fromUtc(utc(value)) === value;
}

export function addDays(date: string, days: number): string {
  return fromUtc(utc(date) + days * 86_400_000);
}

/** `to - from` in days (0 when equal). */
export function diffDays(from: string, to: string): number {
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const day = new Date(utc(date)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** First day of the month of `date`. */
export function monthStart(date: string): string {
  const [y, m] = parts(date);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** Last day of the month of `date`. */
export function monthEnd(date: string): string {
  const [y, m] = parts(date);
  return `${y}-${String(m).padStart(2, '0')}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

/** `date` (a first of month) plus `months` months. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, daysInMonth(year, month))).padStart(2, '0')}`;
}

/** Number of days of the inclusive range [from, to] (0 when to < from). */
export function inclusiveDays(from: string, to: string): number {
  return Math.max(0, diffDays(from, to) + 1);
}

/** The days of [from, to] (inclusive), in order. */
export function* eachDay(from: string, to: string): Generator<string> {
  for (let day = from; day <= to; day = addDays(day, 1)) yield day;
}

/** The later / earlier of two ISO dates. */
export const maxDate = (a: string, b: string): string => (a > b ? a : b);
export const minDate = (a: string, b: string): string => (a < b ? a : b);
