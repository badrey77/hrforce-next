import type { NotificationSubjectType } from '../../../platform/notifications/notifier.js';

/** docs/contracts/notifications.md › Endpoints (subject types extended by docs/contracts/documents.md). */
export interface NotificationView {
  id: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  subject: { type: NotificationSubjectType; id: string };
  data: Record<string, string | number | null>;
  /**
   * Who the caller is to the subject: `employee` (their own request → "your request"), `requester` (filed it for
   * someone else → name the employee), `approver` (a task candidate). null for a row without one.
   */
  audience: 'approver' | 'employee' | 'requester' | null;
  /** app path, e.g. "/tasks?task=…" */
  link: string;
}

export interface NotificationPage {
  items: NotificationView[];
  nextCursor: string | null;
}

export interface PreferenceView {
  type: string;
  email: boolean;
  default: boolean;
}
