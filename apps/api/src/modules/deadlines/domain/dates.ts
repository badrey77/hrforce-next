/** Calendar arithmetic on ISO dates (`YYYY-MM-DD`), in UTC so no time zone shifts a day. Pure. */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(iso: string): Date {
  const m = ISO.exec(iso);
  if (!m) throw new Error(`not an ISO date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** `b − a` in days. */
export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/**
 * The same day `months` months later (negative: earlier); a day that does not exist in the target month becomes its
 * last day (31 March − 1 month → 28/29 February).
 */
export function addMonths(iso: string, months: number): string {
  const d = parse(iso);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay))));
}

/** The anniversary `years` years later; 29 February → 28 February in a common year. */
export function addYears(iso: string, years: number): string {
  return addMonths(iso, years * 12);
}
