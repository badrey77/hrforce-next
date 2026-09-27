import { Injectable } from '@nestjs/common';
import type { NotificationData } from '../../../platform/notifications/notifier.js';

/** Who approves a `manager` step (resolved by the subject module when the step opens). */
export type ManagerCandidate = { userId: string } | { userId: null; reason: 'no-manager' | 'manager-not-linked' };

export interface HookContext {
  instanceId: string;
  subjectId: string;
  /** the acting user (approver, rejecter, canceller) */
  actorUserId: string;
}

/**
 * A subject type's callbacks (docs/contracts/leave.md › Subject hooks), all called INSIDE the request transaction
 * that changes the workflow, so the subject and the workflow commit or roll back together.
 */
export interface WorkflowSubject {
  resolveManager(subjectId: string): Promise<ManagerCandidate>;
  onApproved(context: HookContext): Promise<void>;
  onRejected(context: HookContext): Promise<void>;
  /**
   * `wasApproved`: the instance had finished approved (cancellation of an approved request).
   * `openTaskCandidates`: who could act on the task that was open (empty when none was) — to tell them.
   */
  onCancelled(context: HookContext & { wasApproved: boolean; openTaskCandidates: readonly string[] }): Promise<void>;
  /** Display summaries for "My tasks" (subject id → JSON object). */
  summaries(subjectIds: readonly string[]): Promise<Map<string, Record<string, unknown>>>;
  /**
   * What a notification about the subject shows (names, codes, dates — never sensitive values), e.g.
   * `{requestId, employeeName, employeeNameAr, leaveType, startDate, endDate, days}`.
   */
  notificationData(subjectId: string): Promise<NotificationData>;
}

/** Registry of subject types (the Leave module registers `leave_request` on init). */
@Injectable()
export class WorkflowSubjects {
  private readonly subjects = new Map<string, WorkflowSubject>();

  register(type: string, subject: WorkflowSubject): void {
    this.subjects.set(type, subject);
  }

  get(type: string): WorkflowSubject {
    const subject = this.subjects.get(type);
    if (!subject) throw new Error(`workflow: no subject registered for ${type}`);
    return subject;
  }
}
