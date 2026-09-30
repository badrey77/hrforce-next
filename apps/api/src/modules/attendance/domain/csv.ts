/**
 * CSV for spreadsheets (docs/contracts/attendance.md › GET /attendance/reports/monthly.csv) — pure.
 *
 * - UTF-8 with a byte-order mark: Excel then opens Arabic text correctly (without it, it guesses a legacy code page).
 * - `;` separator (settled): Excel in a French locale — the usual one here — splits on `;`, and `,` would clash with
 *   the comma-separated absence dates. CRLF line ends (RFC 4180).
 * - Formula injection: a cell starting with = + - @ TAB or CR is prefixed with `'`, so a spreadsheet shows it as text
 *   instead of evaluating it (OWASP "CSV injection"); then a cell holding `;`, `"`, CR or LF is quoted, `"` doubled.
 */

export const CSV_SEPARATOR = ';';
export const CSV_BOM = '﻿';

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number): string {
  let text = typeof value === 'number' ? String(value) : value;
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The whole file: BOM + rows joined with `;` and CRLF (a trailing CRLF after the last row). */
export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  return CSV_BOM + rows.map((row) => row.map(csvCell).join(CSV_SEPARATOR)).join('\r\n') + '\r\n';
}

/** Minutes → "h:mm" (e.g. 2410 → "40:10"). */
export function hoursMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
