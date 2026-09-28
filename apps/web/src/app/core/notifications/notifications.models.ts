/**
 * Notifications contract types (`docs/contracts/notifications.md` › Endpoints, Live updates). Plain TypeScript.
 * Field names match the contract text: the API builds against the same document.
 */

/** The types the contract lists (fr/ar/en sentences under `notifications.types.<type>`). */
export const NOTIFICATION_TYPES = [
  'task.assigned',
  'task.escalated',
  'leave.approved',
  'leave.rejected',
  'leave.cancelled',
  'leave.submitted_on_behalf',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/**
 * Who the recipient is to the notification's subject (contract › Wording by audience): `employee` = the person the
 * leave request is for ("your request"); `requester` = they filed it for someone else; `approver` = a task
 * candidate; `null` = unknown (treated as "someone else"). Chooses the wording, never who may see what.
 */
export type NotificationAudience = 'employee' | 'requester' | 'approver';

export interface NotificationView {
  readonly id: string;
  /** One of `NOTIFICATION_TYPES`; kept a `string` so a type added by the API later still renders (generic sentence). */
  readonly type: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly subject: { readonly type: 'workflow_task' | 'leave_request'; readonly id: string };
  /** Names/dates needed to render, e.g. `{employeeName, leaveType (code), startDate, endDate, days, actorName, stepKey}`. */
  readonly data: Readonly<Record<string, string | number | null>>;
  /** Per recipient: picks "your request" (`employee`) or a sentence naming the employee (anything else). */
  readonly audience: NotificationAudience | null;
  /** App path, e.g. `/tasks?task=…` or `/me/leave?request=…`. */
  readonly link: string;
}

/** `GET /me/notifications` — newest first; `nextCursor: null` = nothing older. */
export interface NotificationPage {
  readonly items: readonly NotificationView[];
  readonly nextCursor: string | null;
}

/** `GET /me/notifications/unread-count` and the SSE `unread` event. */
export interface UnreadCount {
  readonly count: number;
}

/** `GET /me/notification-preferences` item. `default` = the value when the user never chose (contract table). */
export interface NotificationPreference {
  readonly type: string;
  readonly email: boolean;
  readonly default: boolean;
}

/** `PUT /me/notification-preferences` item. */
export interface NotificationPreferenceInput {
  readonly type: string;
  readonly email: boolean;
}

/** What one list request needs. `cursor: null` = the newest page. */
export interface NotificationQuery {
  readonly unreadOnly: boolean;
  readonly cursor: string | null;
  readonly limit: number;
}

/**
 * The SSE `notification` event: the contract promises `{id, type, …}`. The web reads it as a full `NotificationView`
 * when it has one (it is shown in the bell at once) and otherwise re-reads the latest list.
 */
export type NotificationEvent = Pick<NotificationView, 'id' | 'type'> & Partial<NotificationView>;

/** Bell dropdown size (contract › Web: "the latest 10") and the /notifications page size. */
export const BELL_SIZE = 10;
export const NOTIFICATIONS_PAGE_SIZE = 20;
