/**
 * Attendance time rules (docs/contracts/attendance.md › Time, ADR 009 §4) — pure, no Nest, no Kysely.
 * The server clock is authoritative and every day is an ALGERIAN calendar day: Africa/Algiers is UTC+1 all year (no
 * daylight saving since 1981), the same rule as the database's generated `attendance_punch.work_date`.
 */

export const ALGIERS_OFFSET_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** "HH:MM" (00:00–23:59) → minutes since midnight; null when malformed. */
export function parseHhMm(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = HH_MM.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** minutes since midnight → "HH:MM". */
export function formatHhMm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The Algerian date of an instant. */
export function algiersDate(ms: number): string {
  return new Date(ms + ALGIERS_OFFSET_MS).toISOString().slice(0, 10);
}

/** The Algerian wall-clock time of an instant, truncated to the minute: "HH:MM". */
export function algiersTime(ms: number): string {
  return new Date(ms + ALGIERS_OFFSET_MS).toISOString().slice(11, 16);
}

/** Minutes since the Algerian midnight of the instant's own day, truncated. */
export function algiersMinuteOfDay(ms: number): number {
  const local = ms + ALGIERS_OFFSET_MS;
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
}

/** The instant of Algerian midnight starting `date`. */
export function algiersMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - ALGIERS_OFFSET_MS;
}

/** The instant of an Algerian date + "HH:MM" (or minutes). */
export function algiersInstant(date: string, time: string | number): number {
  const minutes = typeof time === 'number' ? time : parseHhMm(time);
  if (minutes === null) throw new Error(`invalid time ${String(time)}`);
  return algiersMidnight(date) + minutes * 60_000;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (to − from). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** ISO weekday: 1 = Monday … 5 = Friday, 6 = Saturday, 7 = Sunday. */
export function isoWeekday(date: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (d === 0 ? 7 : d) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

/** First day of the date's month, moved by `months` (negative = earlier). */
export function monthStart(date: string, months = 0): string {
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

/** Last day of the date's month. */
export function monthEnd(date: string): string {
  return addDays(monthStart(date, 1), -1);
}

/** Every date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * The retention boundary (docs/contracts/attendance.md › Retention): punches of a work day BEFORE this date are
 * purged — the first day of today's month minus `retentionMonths` months.
 */
export function retentionCutoff(today: string, retentionMonths: number): string {
  return monthStart(today, -retentionMonths);
}

/** The earlier / later of two ISO dates (reducers). */
export function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}
