/**
 * "My tasks" types (`docs/contracts/leave.md` › Endpoints: `GET /tasks?status=open`, `POST /tasks/:id/approve|reject`).
 * Plain TypeScript. The contract says a task comes "with subject summary (employee name, type, dates, days)"; the
 * web reads it as `subject` below, with the step's labels so the list can name the step in the UI language.
 *
 * Since the Documents slice a task may also be about a self-service document request
 * (docs/contracts/documents.md › Endpoints: summary `{type: 'document_request', employee, documentType, language,
 * purpose, requestedAt}`). `TaskSubject` is a DISCRIMINATED UNION on `type`: code (and templates) check
 * `subject.type` first, and TypeScript then knows which fields exist.
 *
 * Attendance Phase B adds `attendance_correction` (docs/contracts/attendance.md › Audit and timeline (Phase B): summary
 * `{type, employee, date, reason, changes, day: {status, arrival, departure}}`, or `{type, purged: true}` when the
 * retention job deleted the request). The web reads `id` on it too (the correction id, as on the other two kinds).
 * The purged form has no employee: `subjectPerson()` below is what list rows use to name anyone.
 */
import type { CorrectionChange, DayStatus, PunchTime } from '../attendance/attendance.models';
import type { DecisionContract, DecisionProposal } from '../deadlines/deadlines.models';
import type { NamePair } from '../employees/employees.models';
import type { DocumentLanguage } from '../documents/documents.models';
import type { Labels, LeaveEmployee } from '../leave/leave.models';
import type { ProfileSection } from '../profile/profile.models';
import type { OpeningTaskSummary } from '../recruitment/recruitment.models';

export interface DocumentTaskSubject {
  readonly type: 'document_request';
  /** The document request id. */
  readonly id: string;
  readonly employee: LeaveEmployee;
  readonly documentType: { readonly code: string; readonly labels: Labels };
  readonly language: DocumentLanguage;
  /** Shown to HR only, printed nowhere. */
  readonly purpose: string | null;
  readonly requestedAt: string;
}

export interface CorrectionTaskSubject {
  readonly type: 'attendance_correction';
  readonly purged?: false;
  /** The correction id (`GET /attendance/corrections/:id` for the before/after panel). */
  readonly id: string;
  readonly employee: LeaveEmployee;
  readonly date: string;
  readonly reason: string;
  readonly changes: readonly CorrectionChange[];
  /** The day as computed now (before the change). */
  readonly day: { readonly status: DayStatus; readonly arrival: PunchTime | null; readonly departure: PunchTime | null };
}

/** The retention job deleted the correction while its task was still open. */
export interface PurgedCorrectionTaskSubject {
  readonly type: 'attendance_correction';
  readonly purged: true;
  readonly id?: string;
}

/**
 * A contract decision (docs/contracts/contracts-deadlines.md › Contract decisions): a fixed-term contract is ending;
 * the unit head proposes renew / convert to CDI / end, HR approves and the decision is applied. `id` is the decision id
 * (`PUT /contract-decisions/:id/proposal`).
 */
export interface ContractDecisionTaskSubject {
  readonly type: 'contract_decision';
  readonly id: string;
  readonly employee: LeaveEmployee;
  readonly contract: DecisionContract;
  readonly proposal: DecisionProposal | null;
  readonly proposedEndDate: string | null;
  readonly proposedStartDate: string | null;
  readonly comment: string | null;
}

/**
 * A profile change request of an employee (docs/contracts/profile-changes.md): the section and the NAMES of the changed
 * fields only — never their values (the task panel reads `GET /profile/requests/:id` for those). `id` is the request id.
 */
export interface ProfileChangeTaskSubject {
  readonly type: 'profile_change_request';
  readonly id: string;
  readonly employee: LeaveEmployee;
  readonly section: ProfileSection;
  readonly changedFields: readonly string[];
}

export type TaskSubject =
  | ProfileChangeTaskSubject
  | LeaveTaskSubject
  | DocumentTaskSubject
  | CorrectionTaskSubject
  | PurgedCorrectionTaskSubject
  | OpeningTaskSummary
  | ContractDecisionTaskSubject;

/** The person a task is about, or `null` for a purged subject (the only kind without one). */
export function subjectPerson(subject: TaskSubject): NamePair | null {
  return 'employee' in subject ? subject.employee.person : null;
}

export interface LeaveTaskSubject {
  readonly type: 'leave_request';
  /** The leave request id (`GET /leave/requests/:id` for the detail panel). */
  readonly id: string;
  readonly employee: LeaveEmployee;
  readonly leaveTypeId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly days: number;
}

export interface OpenTask {
  readonly id: string;
  readonly stepKey: string;
  readonly stepIndex: number;
  readonly stepLabels: Labels;
  /** The manager step had no linked user and fell through to HR. */
  readonly escalated?: boolean;
  readonly createdAt: string;
  readonly subject: TaskSubject;
}

export interface TaskList {
  readonly items: readonly OpenTask[];
}

export interface TaskDecision {
  /** Required for a rejection (contract: "reject requires comment"). */
  readonly comment?: string;
}
