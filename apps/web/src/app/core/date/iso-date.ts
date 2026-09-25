/**
 * Calendar dates as the API speaks them: ISO `YYYY-MM-DD` strings (no time, no time zone).
 * Plain TypeScript, no Angular here. `<input type="date">` also reads and writes this format,
 * so the strings flow from form controls to the API unchanged.
 */

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Today in the browser's local time zone, as `YYYY-MM-DD` (not UTC: `toISOString()` could give yesterday). */
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** True for a real calendar date in `YYYY-MM-DD` form (rejects `2025-02-30`). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return date.getUTCDate() === day && date.getUTCMonth() === (month ?? 1) - 1;
}
