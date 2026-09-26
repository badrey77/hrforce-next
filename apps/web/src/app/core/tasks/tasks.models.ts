/**
 * "My tasks" types (`docs/contracts/leave.md` › Endpoints: `GET /tasks?status=open`, `POST /tasks/:id/approve|reject`).
 * Plain TypeScript. The contract says a task comes "with subject summary (employee name, type, dates, days)"; the
 * web reads it as `subject` below, with the step's labels so the list can name the step in the UI language.
 */
import type { Labels, LeaveEmployee } from '../leave/leave.models';

export interface TaskSubject {
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
