/**
 * Seam for in-app notifications (docs/contracts/notifications.md): the Workflow and Leave modules create
 * notifications without importing the Notifications module, which implements this port (global provider).
 * Everything runs in the CURRENT request transaction: the rows, their NOTIFY and their e-mail jobs commit or roll back
 * with the business change.
 */

/** Notification types (contract › Types). */
export const NOTIFICATION_TYPES = [
  'task.assigned',
  'task.escalated',
  'leave.approved',
  'leave.rejected',
  'leave.cancelled',
  'leave.submitted_on_behalf',
  'document.ready',
  'document.rejected',
  'attendance.correction_approved',
  'attendance.correction_rejected',
  'recruitment.opening_approved',
  'recruitment.opening_rejected',
  'recruitment.interview_assigned',
  'recruitment.interview_cancelled',
  'recruitment.evaluations_complete',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationSubjectType = 'workflow_task' | 'leave_request' | 'document_request' | 'issued_document' | 'attendance_correction' | 'recruitment_opening' | 'recruitment_interview';

/**
 * Who the recipient is to the subject — decides the link: `approver` (a task candidate: /tasks…), `employee` (the
 * employee's own linked user: /me/leave?request=…, /me/documents?…), `requester` (who filed it for someone else:
 * /leave/requests/…).
 */
export type NotificationAudience = 'approver' | 'employee' | 'requester';

export type NotificationData = Record<string, string | number | null>;

export interface NotificationRecipient {
  userId: string | null;
  audience: NotificationAudience;
}

export interface NotifyInput {
  type: NotificationType;
  subject: { type: NotificationSubjectType; id: string };
  /** names, codes and dates needed to render it — never balances, reasons or other sensitive values */
  data: NotificationData;
  /** null ids are ignored; duplicates are merged (first audience wins); the acting user is removed */
  recipients: readonly NotificationRecipient[];
  /**
   * Keep the acting user among the recipients. Only for what the engine decided rather than the actor
   * (`task.escalated`: the requester learns that their manager step was skipped).
   */
  includeActor?: boolean;
}

export abstract class Notifier {
  /** One row per recipient (once per recipient, type and subject), its NOTIFY, and one e-mail job per new row. */
  abstract notify(input: NotifyInput): Promise<void>;
}
