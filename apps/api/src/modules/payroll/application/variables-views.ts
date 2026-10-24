/** Response shapes of the variables and periods endpoints (docs/contracts/payroll-variables.md › Endpoints). */
import type { AttendanceEmployeeRef } from '../../attendance/index.js';
import type { PayrollSource, PayrollUnit } from '../domain/computation.js';
import type { Labels } from '../domain/lines.js';

export interface UserRef {
  id: string;
  /** the id itself for a former member */
  displayName: string;
}

export type PeriodAction = 'close' | 'reopen' | 'export' | 'export_draft';

export interface PeriodSummary {
  /** YYYY-MM */
  month: string;
  status: 'open' | 'closed';
  /** YYYY-MM-DD */
  cutoffDate: string;
  version: number | null;
  closedAt: string | null;
  closedBy: UserRef | null;
}

export interface PeriodTotal {
  rubriqueId: string;
  exportCode: string;
  names: Labels;
  unit: PayrollUnit;
  employees: number;
  total: number;
}

export interface PeriodClosingView {
  version: number;
  closedAt: string;
  closedBy: UserRef | null;
  reopenedAt: string | null;
  reopenedBy: UserRef | null;
  reopenReason: string | null;
}

export interface PeriodView extends PeriodSummary {
  /** employees with at least one line (value ≠ 0) in the caller's scope */
  employees: number;
  /** lines with a value ≠ 0 */
  lines: number;
  totals: PeriodTotal[];
  regularizations: number;
  flags: { incompleteDays: number; pendingLeave: number; noAttendance: number };
  closings: PeriodClosingView[];
  _actions: PeriodAction[];
}

export interface PayrollLineView {
  rubriqueId: string;
  exportCode: string;
  names: Labels;
  unit: PayrollUnit;
  source: PayrollSource;
  /** YYYY-MM */
  originMonth: string;
  computed: number | null;
  value: number;
  adjusted: boolean;
  note: string | null;
}

export type EmployeeFlag = 'incomplete_days' | 'pending_leave' | 'no_attendance';

export interface EmployeeVariables {
  employee: AttendanceEmployeeRef;
  payrollCode: string | null;
  entry: string | null;
  exit: string | null;
  flags: EmployeeFlag[];
  incompleteDays: number;
  lines: PayrollLineView[];
  _actions: 'edit'[];
}

export interface VariablesPage {
  items: EmployeeVariables[];
  total: number;
  page: number;
  pageSize: number;
}
