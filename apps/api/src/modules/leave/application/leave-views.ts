/** Response shapes of docs/contracts/leave.md (the API layer returns them as-is). Day amounts are JSON numbers. */
import type { EmployeeCard } from '../../staffing/index.js';
import type { Labels, TaskHistoryView, UserRef, WorkflowProgressView } from '../../workflow/index.js';
import type { CountMode } from '../domain/days.js';
import type { RequestStatus } from '../domain/rules.js';

export interface LeaveTypeView {
  id: string;
  code: string;
  labels: Labels;
  countMode: CountMode;
  hasBalance: boolean;
  accrualDaysPerMonth: number | null;
  maxDaysPerYear: number | null;
  maxDaysPerRequest: number | null;
  oncePerCareer: boolean;
  requiresDocument: boolean;
  workflowDefinitionId: string;
  active: boolean;
  sortOrder: number;
}

export interface HolidayView {
  id: string;
  date: string;
  labels: Labels;
  approximate: boolean;
}

export interface PolicyView {
  referenceStartMonth: number;
  weekendDays: number[];
  entitlementDelayMonths: number;
}

export interface BalanceView {
  leaveTypeId: string;
  leaveTypeCode: string;
  periodStart: string;
  periodEnd: string;
  /** first day the year's days may be used (annual leave: 12 months after the year starts) */
  availableFrom: string;
  accrued: number;
  /** taken minus reversals (≤ 0) */
  taken: number;
  adjusted: number;
  /** ledger sum */
  balance: number;
  /** pending requests' days charged to this year (oldest usable years first) */
  pending: number;
  /** usable on `asOf` after pending requests (0 for a year not usable yet) */
  available: number;
}

export interface BalancesView {
  asOf: string;
  items: BalanceView[];
}

export interface LedgerView {
  id: string;
  leaveTypeId: string;
  periodStart: string;
  kind: 'accrual' | 'taken' | 'adjustment' | 'reversal';
  days: number;
  requestId: string | null;
  note: string | null;
  createdBy: UserRef | null;
  createdAt: string;
}

export type LeaveEmployee = Pick<EmployeeCard, 'id' | 'matricule' | 'person' | 'unit'>;

export interface LeaveRequestSummary {
  id: string;
  employee: LeaveEmployee;
  leaveTypeId: string;
  leaveType: { code: string; labels: Labels };
  startDate: string;
  endDate: string;
  days: number;
  halfDayStart: boolean;
  halfDayEnd: boolean;
  status: RequestStatus;
  requestedAt: string;
  workflow: WorkflowProgressView | null;
}

export type LeaveRequestAction = 'cancel';

export interface LeaveRequestDetail extends LeaveRequestSummary {
  reason: string | null;
  documentRef: string | null;
  requestedBy: UserRef | null;
  /** the workflow's tasks, oldest first */
  history: TaskHistoryView[];
  /** the employee's balances of this type (balance types only) */
  balances: BalanceView[];
  _actions: LeaveRequestAction[];
}

export interface LeaveRequestPage {
  items: LeaveRequestSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PreviewView {
  days: number;
  breakdown: { calendarDays: number; weekendDays: number; holidays: { date: string; name: Labels }[]; halfDays: number };
  /** usable days on the start date after this request and the other pending ones (null = no balance) */
  balanceAfter: number | null;
  /** 409 slugs a submit would hit (e.g. leave-balance, leave-overlap); empty = it would be accepted */
  warnings: string[];
}
