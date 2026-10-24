/**
 * The « Paie » month page's state ⇄ the URL (docs/contracts/payroll-variables.md › Web builder 1), like the deadlines
 * board (board-state.ts): parse defensively, write only what differs from the default. Also the month bar's helpers
 * and the value formatting/parsing shared by the table, the chips and the employee panel.
 */
import {
  DEFAULT_VARIABLES_QUERY,
  monthKey,
  type PayrollUnit,
  type PeriodSummary,
  VARIABLES_FILTERS,
  type VariablesFilter,
  type VariablesQuery,
} from '../../core/payroll/payroll.models';

export const MAX_VARIABLES_PAGE_SIZE = 200;
export const VARIABLES_PAGE_SIZES = [25, 50, 100, 200] as const;
/** The value bounds of `payroll_adjustment.value` (numeric(12,2)). */
export const VALUE_MAX = 999_999_999.99;
export const NOTE_MAX = 300;
export const REASON_MIN = 5;
export const REASON_MAX = 300;
export const PAYROLL_CODE_MAX = 20;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface PayrollPageParams {
  readonly month?: string;
  readonly unitId?: string;
  readonly includeSubUnits?: string;
  readonly q?: string;
  readonly rubriqueId?: string;
  readonly filter?: string;
  readonly page?: string;
  readonly pageSize?: string;
  readonly employee?: string;
}

export interface PayrollPageQuery {
  /** `null` → the default month (the latest open month ≤ today). A malformed or future month is dropped. */
  readonly month: string | null;
  readonly employee: string | null;
  readonly variables: VariablesQuery;
}

/** The URL keys of the page (the variables query's keys, the month and the open employee panel). */
export type PayrollChange = Partial<VariablesQuery> & { readonly month?: string | null; readonly employee?: string | null };

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 && n <= max ? n : fallback;
}

export function isMonth(value: string | undefined | null): value is string {
  return !!value && MONTH.test(value);
}

export function resolvePayrollQuery(params: PayrollPageParams, currentMonth: string): PayrollPageQuery {
  const d = DEFAULT_VARIABLES_QUERY;
  const month = isMonth(params.month) && params.month <= currentMonth ? params.month : null;
  const filter = (VARIABLES_FILTERS as readonly string[]).includes(params.filter ?? '') ? (params.filter as VariablesFilter) : null;
  return {
    month,
    employee: params.employee || null,
    variables: {
      unitId: params.unitId || null,
      includeSubUnits: params.includeSubUnits === undefined ? d.includeSubUnits : params.includeSubUnits !== 'false',
      q: params.q ?? d.q,
      rubriqueId: params.rubriqueId || null,
      filter,
      page: positiveInt(params.page, d.page),
      pageSize: positiveInt(params.pageSize, d.pageSize, MAX_VARIABLES_PAGE_SIZE),
    },
  };
}

/** Query params for `router.navigate`: the changed values, `null` where the default applies (removes the param). */
export function toPayrollQueryParams(change: PayrollChange): Record<string, string | null> {
  const d: Record<string, unknown> = { ...DEFAULT_VARIABLES_QUERY, month: null, employee: null };
  const params: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(change)) {
    params[key] = value === d[key] || value === '' || value === null || value === undefined ? null : String(value);
  }
  return params;
}

/** `YYYY-MM` ± n months. */
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/** `2026-09` or `2026-09-01` → `09/2026` (the régularisation chip, the origin column). */
export function periodLabel(month: string): string {
  return `${month.slice(5, 7)}/${month.slice(0, 4)}`;
}

/** The default month: the latest open month ≤ the current one in `items`, else the current month. */
export function defaultMonth(items: readonly PeriodSummary[], currentMonth: string): string {
  const open = items
    .map((p) => monthKey(p.month))
    .filter((m, i) => items[i]?.status === 'open' && m <= currentMonth)
    .toSorted();
  return open.at(-1) ?? currentMonth;
}

export interface MonthCell {
  readonly month: string;
  /** `null` for a month after the current one (not listed by the API). */
  readonly summary: PeriodSummary | null;
  readonly future: boolean;
}

/** The 12 months of `year`, each with its summary (months after the current one are `future`). */
export function monthsOfYear(year: number, items: readonly PeriodSummary[], currentMonth: string): MonthCell[] {
  const byMonth = new Map(items.map((p) => [monthKey(p.month), p]));
  return Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, '0')}`;
    const future = month > currentMonth;
    // A past month the API did not list is open (a month without a period row is open).
    const summary = byMonth.get(month) ?? null;
    return { month, summary: future ? null : summary, future };
  });
}

// --- Values ---------------------------------------------------------------------------------------------------------

const MINUS = '−';

/** A value as shown: up to two decimals, the locale's separators, a real minus sign. */
export function formatValue(value: number, locale: string): string {
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 0 }).format(Math.abs(value));
  return value < 0 ? `${MINUS}${text}` : text;
}

/** The unit's short translation key (« j », « h », « DA »). */
export function unitKey(unit: PayrollUnit): string {
  return `payroll.month.unitShort.${unit}`;
}

/**
 * A typed value → a number: `,` or `.` as the decimal mark, spaces (and no-break spaces) ignored, `-` or `−` for a
 * negative, at most two decimals, within the column's bounds. `null` when it is not such a number.
 */
export function parseValue(text: string): number | null {
  const cleaned = text.replace(/[\s  ]/g, '').replace(MINUS, '-').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Math.abs(n) <= VALUE_MAX ? n : null;
}

/** A number as the value input shows it (the UI language's decimal mark; no grouping, so it parses back). */
export function valueInputText(value: number, lang: string): string {
  const text = String(Math.round(value * 100) / 100);
  return lang === 'en' ? text : text.replace('.', ',');
}
