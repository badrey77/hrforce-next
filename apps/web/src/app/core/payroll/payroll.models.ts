/**
 * Payroll variables (docs/contracts/payroll-variables.md › Endpoints). Plain TypeScript; field names follow the
 * contract. Months are `YYYY-MM` in URLs.
 */
import type { EmployeeRef, UserRef } from '../attendance/attendance.models';
import type { Labels } from '../leave/leave.models';

export type { EmployeeRef, Labels, UserRef };

export const PAYROLL_SOURCES = ['leave', 'absence', 'late', 'overtime_normal', 'overtime_rest_day', 'overtime_holiday', 'service_days', 'manual'] as const;
export type PayrollSource = (typeof PAYROLL_SOURCES)[number];

export const PAYROLL_UNITS = ['days', 'hours', 'amount'] as const;
export type PayrollUnit = (typeof PAYROLL_UNITS)[number];

export type PeriodStatus = 'open' | 'closed';
export type PeriodAction = 'close' | 'reopen' | 'export' | 'export_draft';

export interface PeriodSummary {
  readonly month: string;
  readonly status: PeriodStatus;
  readonly cutoffDate: string;
  readonly version: number | null;
  readonly closedAt: string | null;
  readonly closedBy: UserRef | null;
}

export interface PeriodTotal {
  readonly rubriqueId: string;
  readonly exportCode: string;
  readonly names: Labels;
  readonly unit: PayrollUnit;
  readonly employees: number;
  readonly total: number;
}

export interface PeriodClosing {
  readonly version: number;
  readonly closedAt: string;
  readonly closedBy: UserRef | null;
  readonly reopenedAt: string | null;
  readonly reopenedBy: UserRef | null;
  readonly reopenReason: string | null;
}

export interface PeriodView extends PeriodSummary {
  readonly employees: number;
  readonly lines: number;
  readonly totals: readonly PeriodTotal[];
  readonly regularizations: number;
  readonly flags: { readonly incompleteDays: number; readonly pendingLeave: number; readonly noAttendance: number };
  readonly closings: readonly PeriodClosing[];
  readonly _actions: readonly PeriodAction[];
}

export interface PeriodList {
  readonly items: readonly PeriodSummary[];
}

export interface PayrollLine {
  readonly rubriqueId: string;
  readonly exportCode: string;
  readonly names: Labels;
  readonly unit: PayrollUnit;
  readonly source: PayrollSource;
  readonly originMonth: string;
  readonly computed: number | null;
  readonly value: number;
  readonly adjusted: boolean;
  readonly note: string | null;
}

export type EmployeeFlag = 'incomplete_days' | 'pending_leave' | 'no_attendance';

export interface EmployeeVariables {
  readonly employee: EmployeeRef;
  readonly payrollCode: string | null;
  readonly entry: string | null;
  readonly exit: string | null;
  readonly flags: readonly EmployeeFlag[];
  readonly incompleteDays: number;
  /** Amount lines are omitted without `employee.salary.read`. */
  readonly lines: readonly PayrollLine[];
  readonly _actions: readonly 'edit'[];
}

export interface VariablesPage {
  readonly items: readonly EmployeeVariables[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export const VARIABLES_FILTERS = ['adjusted', 'regularization', 'flagged'] as const;
export type VariablesFilter = (typeof VARIABLES_FILTERS)[number];

export interface VariablesQuery {
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly q: string;
  readonly rubriqueId: string | null;
  readonly filter: VariablesFilter | null;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_VARIABLES_QUERY: VariablesQuery = {
  unitId: null,
  includeSubUnits: true,
  q: '',
  rubriqueId: null,
  filter: null,
  page: 1,
  pageSize: 50,
};

/** `PUT …/variables/:employeeId/lines`. `originMonth` only for a régularisation line. */
export interface LineInput {
  readonly rubriqueId: string;
  readonly originMonth?: string;
  readonly value: number;
  readonly note?: string | null;
}

export interface EmployeeCodeInput {
  readonly code: string | null;
}

export interface EmployeeCodeView {
  readonly employeeId: string;
  readonly code: string | null;
}

export interface ReopenInput {
  readonly reason: string;
}

/** Unit filter of the export and the control report. */
export interface ExportFilter {
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
}

export interface RubriqueView {
  readonly id: string;
  readonly source: PayrollSource;
  readonly leaveType: { readonly id: string; readonly code: string; readonly labels: Labels } | null;
  readonly exportCode: string;
  readonly names: Labels;
  readonly unit: PayrollUnit;
  readonly active: boolean;
  readonly sortOrder: number;
}

export interface RubriqueList {
  readonly items: readonly RubriqueView[];
}

/** `POST /payroll/rubriques` (source `manual`). */
export interface NewRubrique {
  readonly exportCode: string;
  readonly names: Labels;
  readonly unit: PayrollUnit;
}

/** `PUT /payroll/rubriques/:id`; `unit` for manual rubriques only. */
export interface RubriqueUpdate {
  readonly exportCode?: string;
  readonly names?: Labels;
  readonly unit?: PayrollUnit;
  readonly active?: boolean;
  readonly sortOrder?: number;
}

/** Pattern of export codes and payroll matricules (1–20 characters). */
export const PAYROLL_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,20}$/;

export const PAYROLL_LAYOUTS = ['per_line', 'per_employee'] as const;
export type PayrollLayout = (typeof PAYROLL_LAYOUTS)[number];
export const PAYROLL_SEPARATORS = ['semicolon', 'comma', 'tab', 'pipe'] as const;
export type PayrollSeparator = (typeof PAYROLL_SEPARATORS)[number];
export const PAYROLL_DECIMALS = ['comma', 'dot'] as const;
export type PayrollDecimalSeparator = (typeof PAYROLL_DECIMALS)[number];
export const PAYROLL_ENCODINGS = ['windows1252', 'utf8', 'utf8_bom'] as const;
export type PayrollEncoding = (typeof PAYROLL_ENCODINGS)[number];
export const PAYROLL_PERIOD_FORMATS = ['mm_yyyy', 'yyyymm', 'yyyy_mm'] as const;
export type PayrollPeriodFormat = (typeof PAYROLL_PERIOD_FORMATS)[number];
export const PAYROLL_EXTENSIONS = ['csv', 'txt'] as const;
export type PayrollExtension = (typeof PAYROLL_EXTENSIONS)[number];

/** Export columns allowed per layout (contract › Data › `payroll_policy.columns`). */
export const PER_LINE_COLUMNS: readonly string[] = ['matricule', 'last_name', 'first_name', 'rubrique', 'label', 'value', 'unit', 'period', 'origin_period', 'unit_code'];
export const PER_EMPLOYEE_COLUMNS: readonly string[] = ['matricule', 'last_name', 'first_name', 'unit_code', 'period', 'origin_period'];
export const MAX_COLUMNS = 10;

export interface PayrollSettings {
  readonly cutoffDay: number;
  readonly regularizationMonths: number;
  readonly overtimeMinMinutes: number;
  readonly layout: PayrollLayout;
  readonly separator: PayrollSeparator;
  readonly decimalSeparator: PayrollDecimalSeparator;
  readonly encoding: PayrollEncoding;
  readonly headerRow: boolean;
  readonly columns: readonly string[];
  readonly periodFormat: PayrollPeriodFormat;
  readonly fileExtension: PayrollExtension;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  cutoffDay: 20,
  regularizationMonths: 3,
  overtimeMinMinutes: 30,
  layout: 'per_line',
  separator: 'semicolon',
  decimalSeparator: 'comma',
  encoding: 'windows1252',
  headerRow: true,
  columns: ['matricule', 'rubrique', 'value', 'period'],
  periodFormat: 'mm_yyyy',
  fileExtension: 'csv',
};

/** Bounds of the calendar settings (contract › Data). */
export const SETTINGS_BOUNDS = {
  cutoffDay: { min: 1, max: 28 },
  regularizationMonths: { min: 0, max: 12 },
  overtimeMinMinutes: { min: 0, max: 240 },
} as const;

export interface SettingsPreview {
  readonly filename: string;
  readonly encoding: PayrollEncoding;
  readonly sample: string;
}

/** A downloaded file: the bytes and the name the API gave in `Content-Disposition`. */
export interface DownloadedFile {
  readonly blob: Blob;
  readonly filename: string;
}

/** Columns allowed by a layout. */
export function allowedColumns(layout: PayrollLayout): readonly string[] {
  return layout === 'per_line' ? PER_LINE_COLUMNS : PER_EMPLOYEE_COLUMNS;
}

export type ColumnsProblem = 'required' | 'too_many' | 'invalid' | 'missing_matricule' | 'missing_rubrique_value';

/** Client-side check mirroring the API's 422 `columns` `invalid`; `null` when valid. */
export function columnsProblem(layout: PayrollLayout, columns: readonly string[]): ColumnsProblem | null {
  if (columns.length === 0) return 'required';
  if (columns.length > MAX_COLUMNS) return 'too_many';
  const allowed = allowedColumns(layout);
  if (new Set(columns).size !== columns.length || columns.some((c) => !allowed.includes(c))) return 'invalid';
  if (!columns.includes('matricule')) return 'missing_matricule';
  if (layout === 'per_line' && !(columns.includes('rubrique') && columns.includes('value'))) return 'missing_rubrique_value';
  return null;
}

/** `YYYY-MM` from a `YYYY-MM-DD` or `YYYY-MM` string. */
export function monthKey(month: string): string {
  return month.slice(0, 7);
}

/** Query params of `GET …/variables`: empty filters left out, paging always sent, `lang` only for Arabic. */
export function variablesParams(query: VariablesQuery, lang: string | null = null): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.rubriqueId) params['rubriqueId'] = query.rubriqueId;
  if (query.filter) params['filter'] = query.filter;
  if (lang === 'ar') params['lang'] = 'ar';
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

/** Unit filter params of the export and the control report. */
export function exportFilterParams(filter: ExportFilter | null | undefined): Record<string, string> {
  if (!filter?.unitId) return {};
  return { unitId: filter.unitId, includeSubUnits: String(filter.includeSubUnits) };
}

/**
 * The file name of a `Content-Disposition` header (`filename*=UTF-8''…` preferred, else `filename="…"`), or
 * `fallback`. Path separators are replaced.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  let name: string | null = null;
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      name = null;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
    if (plain) name = (plain[1] ?? plain[2] ?? '').replace(/\\(.)/g, '$1').trim();
  }
  const clean = name?.replace(/[\\/]/g, '_').trim();
  return clean ? clean : fallback;
}
