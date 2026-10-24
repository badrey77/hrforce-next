/**
 * The port between the export / control endpoints (API builder 1: export.service.ts) and the computation (API
 * builder 2: PayrollEngine / variables service, which implements it and binds it in payroll.module.ts:
 * `{ provide: PAYROLL_LINES_SOURCE, useExisting: <the implementing class> }`). docs/contracts/payroll-variables.md.
 */

export type PayrollUnit = 'days' | 'hours' | 'amount';
export type PayrollSourceKind = 'leave' | 'absence' | 'late' | 'overtime_normal' | 'overtime_rest_day' | 'overtime_holiday' | 'service_days' | 'manual';
export type PayrollLabels = { fr: string; ar: string; en: string };

export interface PayrollLinesQuery {
  /** `YYYY-MM` (already validated by the caller: not in the future) */
  month: string;
  /**
   * The permission whose scope limits the rows (the employee's assignment unit on the month's last employed day, as the
   * variables list). `payroll.configure` is company-wide (the settings preview).
   */
  permission: 'payroll.read' | 'payroll.export' | 'payroll.configure';
  /** the same filter as GET …/variables (an out-of-scope or unknown unit behaves as it does there) */
  unitId?: string;
  includeSubUnits?: boolean;
  /**
   * Informative only: a closed month always answers the lines of its current closing, an open month the live
   * computation (the export refuses an open month without `draft=true` before calling).
   */
  draft: boolean;
}

/** One line (employee × rubrique × origin month) with a non-zero value. */
export interface PayrollExportLine {
  employeeId: string;
  /** the HRForce matricule (current) */
  matricule: string;
  /** the « matricule paie » (current), null when none */
  payrollCode: string | null;
  /** the matricule the file prints: closed → `payroll_line.matricule` (snapshot); open → payrollCode ?? matricule */
  exportMatricule: string;
  /** Latin names (closed → the snapshot) */
  lastName: string;
  firstName: string;
  /** Arabic names (current; null when none) — the control report in `ar` */
  lastNameAr: string | null;
  firstNameAr: string | null;
  /** the assignment unit: code (closed → snapshot `unit_code`) and names (current) */
  unitCode: string | null;
  unitName: string | null;
  unitNameAr: string | null;
  rubriqueId: string;
  /** closed → snapshot `export_code` / `unit` */
  exportCode: string;
  unit: PayrollUnit;
  source: PayrollSourceKind;
  /** the rubrique's current names and sort order */
  names: PayrollLabels;
  sortOrder: number;
  /** `YYYY-MM` */
  originMonth: string;
  computed: number | null;
  value: number;
  adjusted: boolean;
  note: string | null;
}

export interface PayrollLinesResult {
  status: 'open' | 'closed';
  /** the current closing's version (closed), null when open */
  version: number | null;
  /**
   * Lines of the employees in the caller's scope for `permission`, ANY order. `amount` lines are omitted where the
   * caller lacks employee.salary.read over the employee (the same rule as GET …/variables).
   */
  lines: PayrollExportLine[];
}

export interface PayrollLinesSource {
  linesFor(query: PayrollLinesQuery): Promise<PayrollLinesResult>;
}

/** Nest injection token. */
export const PAYROLL_LINES_SOURCE = Symbol('PayrollLinesSource');
