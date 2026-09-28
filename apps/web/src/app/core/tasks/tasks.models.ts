/**
 * "My tasks" types (`docs/contracts/leave.md` › Endpoints: `GET /tasks?status=open`, `POST /tasks/:id/approve|reject`).
 * Plain TypeScript. The contract says a task comes "with subject summary (employee name, type, dates, days)"; the
 * web reads it as `subject` below, with the step's labels so the list can name the step in the UI language.
 *
 * Since the Documents slice a task may also be about a self-service document request
 * (docs/contracts/documents.md › Endpoints: summary `{type: 'document_request', employee, documentType, language,
 * purpose, requestedAt}`). `TaskSubject` is a DISCRIMINATED UNION on `type`: code (and templates) check
 * `subject.type` first, and TypeScript then knows which fields exist.
 */
import type { DocumentLanguage } from '../documents/documents.models';
import type { Labels, LeaveEmployee } from '../leave/leave.models';

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

export type TaskSubject = LeaveTaskSubject | DocumentTaskSubject;

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
