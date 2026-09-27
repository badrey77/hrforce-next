/**
 * Leave and workflow API types — from the binding contract `docs/contracts/leave.md`.
 * Plain TypeScript, no Angular: these types vanish at runtime and only let `strictTemplates` check our usage.
 *
 * The contract lists tables, endpoints and slugs; it does not spell out every JSON body. Where it is silent the web
 * reads the shapes below, checked against the API's views (apps/api/src/modules/leave/application/leave-views.ts,
 * workflow-views.ts) and listed under "Contract interpretations" in apps/web/README.md:
 * - labels of reference data come as `labels: { fr, ar, en }`, like the org kind catalogue (`GET /org/kinds`);
 * - `days` (numeric(5,1)) are JSON numbers with at most one decimal; the web only formats them;
 * - list items carry a `workflow` progress block (status, current step, step definitions) so a list can draw its
 *   stepper without one request per row; the detail adds the task `history`.
 *
 * Lives in core/ because four features read it (my leave, my tasks, HR leave, the employee Leave tab).
 */
import type { NamePair, UnitRef } from '../employees/employees.models';

/** A text maintained by the business in every UI language (leave type names, holiday names, workflow steps). */
export interface Labels {
  readonly fr: string;
  readonly ar: string;
  readonly en: string;
}

/** Some fields may come as one already-localised string (e.g. a holiday `name` in the preview): accept both. */
export type LocalizedText = string | Labels;

// --- Reference data ---------------------------------------------------------------------------------------------

export type CountMode = 'calendar' | 'working';

export interface LeaveType {
  readonly id: string;
  readonly code: string;
  readonly labels: Labels;
  readonly countMode: CountMode;
  readonly hasBalance: boolean;
  readonly accrualDaysPerMonth: number | null;
  readonly maxDaysPerYear: number | null;
  readonly maxDaysPerRequest: number | null;
  readonly oncePerCareer: boolean;
  readonly requiresDocument: boolean;
  readonly workflowDefinitionId?: string | null;
  readonly active: boolean;
}

export interface LeaveTypeList {
  readonly items: readonly LeaveType[];
}

/** `PUT /leave/types/:id` — the editable numbers and labels (codes and count modes are fixed by the seed). */
export interface UpdateLeaveType {
  readonly labels: Labels;
  readonly accrualDaysPerMonth: number | null;
  readonly maxDaysPerYear: number | null;
  readonly maxDaysPerRequest: number | null;
  readonly requiresDocument: boolean;
  readonly active: boolean;
}

export interface PublicHoliday {
  readonly id: string;
  readonly date: string;
  readonly labels: Labels;
  /** Lunar holidays: the date is an estimate HR must confirm each year. */
  readonly approximate: boolean;
}

export interface HolidayList {
  readonly items: readonly PublicHoliday[];
}

/** `POST /leave/holidays`, `PUT /leave/holidays/:id`. */
export interface HolidayInput {
  readonly date: string;
  readonly labels: Labels;
  readonly approximate: boolean;
}

/** ISO day numbers: 1 = Monday … 7 = Sunday. The Algerian default weekend is {5, 6} (Friday, Saturday). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const ISO_WEEKDAYS: readonly IsoWeekday[] = [1, 2, 3, 4, 5, 6, 7];

export interface LeavePolicy {
  /** First month of the reference year (7 = 1 July → 30 June). */
  readonly referenceStartMonth: number;
  readonly weekendDays: readonly IsoWeekday[];
  /** Months after the reference year starts before its days may be used (annual leave: 12). Kept as sent. */
  readonly entitlementDelayMonths?: number;
}

// --- Balances and ledger ----------------------------------------------------------------------------------------

/** One (type, reference year) balance. `balance` = sum of the ledger; `available` = balance − pending. */
export interface LeaveBalance {
  readonly leaveTypeId: string;
  /** First day of the reference year (`YYYY-07-01` with the default policy). */
  readonly periodStart: string;
  readonly periodEnd?: string;
  readonly leaveTypeCode?: string;
  /** First day this year's days may be used. */
  readonly availableFrom?: string;
  readonly accrued: number;
  readonly taken: number;
  readonly adjusted: number;
  readonly balance: number;
  readonly pending: number;
  readonly available: number;
}

export interface BalanceList {
  readonly asOf?: string;
  readonly items: readonly LeaveBalance[];
}

export type LedgerKind = 'accrual' | 'taken' | 'adjustment' | 'reversal';

export interface LedgerEntry {
  readonly id: string;
  readonly leaveTypeId: string;
  readonly periodStart: string;
  readonly kind: LedgerKind;
  /** Signed: + accrual/adjustment/reversal, − taken. */
  readonly days: number;
  readonly requestId: string | null;
  readonly note: string | null;
  readonly createdBy: { readonly id: string; readonly displayName: string } | null;
  readonly createdAt: string;
}

export interface LedgerList {
  readonly items: readonly LedgerEntry[];
}

/** `POST /employees/:id/leave/adjustments`. */
export interface LeaveAdjustment {
  readonly leaveTypeId: string;
  readonly periodStart: string;
  readonly days: number;
  readonly note: string;
}

// --- Requests and workflow --------------------------------------------------------------------------------------

export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export const LEAVE_STATUSES: readonly LeaveStatus[] = ['pending', 'approved', 'rejected', 'cancelled'];

export type WorkflowStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** One step of a workflow definition (`workflow_definition.steps`). */
export interface WorkflowStepDef {
  readonly key: string;
  readonly kind: 'manager' | 'permission';
  readonly permission?: string;
  readonly labels: Labels;
}

/**
 * The API's own state of each step (apps/api/src/modules/workflow/domain/steps.ts `progressOf`): `escalated` = a
 * manager step nobody could take; `skipped` = never reached because the instance finished earlier.
 */
export type WorkflowStepApiState = 'done' | 'current' | 'pending' | 'escalated' | 'rejected' | 'cancelled' | 'skipped';

/** Where an instance stands: enough to draw a stepper. `currentStep` = index of the open step, `null` when finished. */
export interface WorkflowProgress {
  readonly status: WorkflowStatus;
  readonly currentStep: number | null;
  /** Each step carries the API's `state`; list rows have no task history, so it is the only source there. */
  readonly steps: readonly (WorkflowStepDef & { readonly state?: WorkflowStepApiState })[];
}

export type TaskStatus = 'open' | 'done' | 'skipped' | 'cancelled';
export type TaskOutcome = 'approve' | 'reject' | 'escalated';

/** A task of the instance, oldest first (the step history). */
export interface WorkflowTaskHistory {
  readonly id: string;
  readonly stepKey: string;
  readonly stepIndex: number;
  readonly status: TaskStatus;
  readonly outcome: TaskOutcome | null;
  readonly actedBy: { readonly id: string; readonly displayName: string } | null;
  readonly actedAt: string | null;
  readonly comment: string | null;
  readonly createdAt: string;
}

/** The employee a request is about (list/detail). */
export interface LeaveEmployee {
  /** The employment id (`/employees/:id`). */
  readonly id: string;
  readonly matricule: string;
  readonly person: NamePair;
  readonly unit?: UnitRef;
}

export interface LeaveRequestSummary {
  readonly id: string;
  readonly employee: LeaveEmployee;
  readonly leaveTypeId: string;
  /** The type's code and labels (the API sends them; the web names types through LeaveCatalog anyway). */
  readonly leaveType?: { readonly code: string; readonly labels: Labels };
  readonly startDate: string;
  /** Inclusive. */
  readonly endDate: string;
  readonly days: number;
  readonly halfDayStart: boolean;
  readonly halfDayEnd: boolean;
  readonly status: LeaveStatus;
  readonly requestedAt: string;
  readonly workflow: WorkflowProgress | null;
}

export type LeaveRequestAction = 'cancel';

export interface LeaveRequestDetail extends LeaveRequestSummary {
  readonly reason: string | null;
  readonly documentRef: string | null;
  readonly requestedBy: { readonly id: string; readonly displayName: string } | null;
  /** Oldest first. */
  readonly history: readonly WorkflowTaskHistory[];
  /**
   * The employee's balances for this request's type. The approver of the manager step holds no `leave.read`, so the
   * web cannot call `GET /employees/:id/leave/balances` for the task panel: the detail carries them.
   */
  readonly balances?: readonly LeaveBalance[];
  readonly _actions?: readonly LeaveRequestAction[];
}

export interface LeaveRequestList {
  readonly items: readonly LeaveRequestSummary[];
}

export interface LeaveRequestPage extends LeaveRequestList {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** `POST /me/leave/requests` and `POST /employees/:id/leave/requests`. */
export interface NewLeaveRequest {
  readonly leaveTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly halfDayStart?: boolean;
  readonly halfDayEnd?: boolean;
  readonly reason?: string;
  readonly documentRef?: string;
}

/** `POST /leave/preview` — a request that is only counted, never written. */
export interface LeavePreviewRequest extends NewLeaveRequest {
  /** Absent = the caller's own linked employment (self-service). */
  readonly employmentId?: string;
}

export interface PreviewHoliday {
  readonly date: string;
  readonly name: LocalizedText;
}

export interface LeavePreview {
  readonly days: number;
  readonly breakdown: {
    readonly calendarDays: number;
    readonly weekendDays: number;
    readonly holidays: readonly PreviewHoliday[];
    readonly halfDays?: number;
  };
  /** `null` for a type without balance (sick, unpaid…). */
  readonly balanceAfter: number | null;
  /** 409 slugs a submit would hit (`leave-balance`, `leave-overlap`…); empty = it would be accepted. */
  readonly warnings?: readonly string[];
}

/** `GET /me/employment` — the signed-in user's linked employment. */
export interface MyEmployment {
  readonly id: string;
  readonly matricule: string;
  readonly person: NamePair;
  readonly unit: UnitRef;
  readonly jobTitle: string;
  readonly hireDate: string;
}

// --- HR list query ----------------------------------------------------------------------------------------------

export type LeaveStatusFilter = LeaveStatus | 'all';
export const LEAVE_STATUS_FILTERS: readonly LeaveStatusFilter[] = ['pending', 'approved', 'rejected', 'cancelled', 'all'];
export const LEAVE_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];

/** `GET /leave/requests` query, fully resolved. */
export interface LeaveQuery {
  readonly q: string;
  readonly status: LeaveStatusFilter;
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly typeId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_LEAVE_QUERY: LeaveQuery = {
  q: '',
  status: 'all',
  unitId: null,
  includeSubUnits: true,
  typeId: null,
  from: null,
  to: null,
  page: 1,
  pageSize: 25,
};

/** 409 slugs of the contract (`urn:hrforce:problem:<slug>`). */
export type LeaveProblemSlug =
  | 'leave-overlap'
  | 'leave-balance'
  | 'leave-max-request'
  | 'leave-once-per-career'
  | 'leave-dates'
  | 'leave-document-required'
  | 'leave-not-linked'
  | 'workflow-self-approval'
  | 'workflow-task-closed';

/**
 * `_actions` without sprinkling lint exceptions through templates (the field name is the contract's). `undefined`
 * when the API did not send them (list items), so callers can fall back to the contract's rule.
 */
export function requestActions(request: Pick<LeaveRequestDetail, '_actions'>): readonly LeaveRequestAction[] | undefined {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return request._actions;
}
