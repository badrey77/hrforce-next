/**
 * Payroll settings and rubriques (docs/contracts/payroll-variables.md › Data): the closing calendar, the export file
 * format and the pay-item rules. Pure: no Nest, no Kysely.
 */

export const LAYOUTS = ['per_line', 'per_employee'] as const;
export const SEPARATORS = ['semicolon', 'comma', 'tab', 'pipe'] as const;
export const DECIMAL_SEPARATORS = ['comma', 'dot'] as const;
export const ENCODINGS = ['windows1252', 'utf8', 'utf8_bom'] as const;
export const PERIOD_FORMATS = ['mm_yyyy', 'yyyymm', 'yyyy_mm'] as const;
export const FILE_EXTENSIONS = ['csv', 'txt'] as const;

/** The columns a `per_line` file may list. */
export const LINE_COLUMNS = ['matricule', 'last_name', 'first_name', 'rubrique', 'label', 'value', 'unit', 'period', 'origin_period', 'unit_code'] as const;
/** The identity columns of a `per_employee` file (the rubrique columns follow). */
export const EMPLOYEE_COLUMNS = ['matricule', 'last_name', 'first_name', 'unit_code', 'period', 'origin_period'] as const;

export type Layout = (typeof LAYOUTS)[number];
export type Separator = (typeof SEPARATORS)[number];
export type DecimalSeparator = (typeof DECIMAL_SEPARATORS)[number];
export type Encoding = (typeof ENCODINGS)[number];
export type PeriodFormat = (typeof PERIOD_FORMATS)[number];
export type FileExtension = (typeof FILE_EXTENSIONS)[number];
export type ExportColumn = (typeof LINE_COLUMNS)[number];

export interface PayrollSettings {
  cutoffDay: number;
  regularizationMonths: number;
  overtimeMinMinutes: number;
  layout: Layout;
  separator: Separator;
  decimalSeparator: DecimalSeparator;
  encoding: Encoding;
  headerRow: boolean;
  columns: ExportColumn[];
  periodFormat: PeriodFormat;
  fileExtension: FileExtension;
}

/** = the column defaults of payroll_policy (migration 0024): a company without a row uses these. */
export const DEFAULT_PAYROLL_SETTINGS: Readonly<PayrollSettings> = Object.freeze({
  cutoffDay: 20,
  regularizationMonths: 3,
  overtimeMinMinutes: 30,
  layout: 'per_line',
  separator: 'semicolon',
  decimalSeparator: 'comma',
  encoding: 'windows1252',
  headerRow: true,
  columns: ['matricule', 'rubrique', 'value', 'period'] as ExportColumn[],
  periodFormat: 'mm_yyyy',
  fileExtension: 'csv',
});

export const SETTINGS_RANGES = {
  cutoffDay: [1, 28],
  regularizationMonths: [0, 12],
  overtimeMinMinutes: [0, 240],
} as const;

export const MAX_COLUMNS = 10;

/** Whether `columns` suit `layout`: 1–10 distinct allowed keys with `matricule` (and `rubrique` + `value` per line). */
export function columnsValid(layout: Layout, columns: readonly string[]): boolean {
  const allowed: readonly string[] = layout === 'per_line' ? LINE_COLUMNS : EMPLOYEE_COLUMNS;
  if (columns.length < 1 || columns.length > MAX_COLUMNS) return false;
  if (new Set(columns).size !== columns.length) return false;
  if (!columns.every((c) => allowed.includes(c))) return false;
  if (!columns.includes('matricule')) return false;
  return layout === 'per_employee' || (columns.includes('rubrique') && columns.includes('value'));
}

// ── rubriques ──────────────────────────────────────────────────────────────────────────────────────────────────

export const PAYROLL_SOURCES = ['leave', 'absence', 'late', 'overtime_normal', 'overtime_rest_day', 'overtime_holiday', 'service_days', 'manual'] as const;
export const PAYROLL_UNITS = ['days', 'hours', 'amount'] as const;
export type RubriqueSource = (typeof PAYROLL_SOURCES)[number];
export type RubriqueUnit = (typeof PAYROLL_UNITS)[number];

/** Export codes and payroll matricules: 1–20 letters, digits, `_`, `.`, `-`. */
export const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,20}$/;
export const NAME_MAX = 80;

export const PAYROLL_PERMISSIONS = {
  read: 'payroll.read',
  prepare: 'payroll.prepare',
  export: 'payroll.export',
  close: 'payroll.close',
  configure: 'payroll.configure',
} as const;
