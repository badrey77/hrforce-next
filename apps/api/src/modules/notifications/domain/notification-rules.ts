/**
 * Notification rules (docs/contracts/notifications.md › Notifications) — pure: e-mail defaults per type, the link of a
 * notification, the list cursor. No Nest, no Kysely.
 */
import { NOTIFICATION_TYPES, type NotificationType } from '../../../platform/notifications/notifier.js';

export { NOTIFICATION_TYPES, type NotificationType };

/** E-mail default per type (contract › Types): an absent preference row means this value. */
export const EMAIL_DEFAULTS: Readonly<Record<NotificationType, boolean>> = {
  'task.assigned': true,
  'task.escalated': false,
  'leave.approved': true,
  'leave.rejected': true,
  'leave.cancelled': false,
  'leave.submitted_on_behalf': true,
};

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function emailDefault(type: string): boolean {
  return isNotificationType(type) ? EMAIL_DEFAULTS[type] : false;
}

export interface LinkSource {
  type: string;
  subjectType: string;
  subjectId: string;
  data: Readonly<Record<string, unknown>>;
}

/**
 * The app path a notification opens (also `${WEB_BASE_URL}` + path in its e-mail):
 *   task.assigned            → /tasks?task=<task id>
 *   leave.cancelled          → /tasks (the recipients were approvers of a task that no longer exists)
 *   other leave_request ones → /me/leave?request=<id> for the employee's own user, else /leave/requests/<id>
 *                              (the requester who filed it on someone's behalf)
 */
export function linkOf(n: LinkSource): string {
  const id = encodeURIComponent(n.subjectId);
  if (n.type === 'task.assigned' && n.subjectType === 'workflow_task') return `/tasks?task=${id}`;
  if (n.type === 'leave.cancelled') return '/tasks';
  if (n.subjectType === 'leave_request') return n.data['audience'] === 'employee' ? `/me/leave?request=${id}` : `/leave/requests/${id}`;
  return '/notifications';
}

/** Data as returned to the client: the internal `audience` key (used for the link) is left out. */
export function publicData(data: Readonly<Record<string, unknown>>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'audience') continue;
    out[key] = typeof value === 'string' || typeof value === 'number' ? value : null;
  }
  return out;
}

// ── cursor (newest first: created_at desc, id desc) ─────────────────────────────────────────────────────────────

export interface NotificationCursor {
  /** ISO-8601 UTC with microseconds */
  at: string;
  id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(cursor: NotificationCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.id}`, 'utf8').toString('base64url');
}

/** null when malformed. */
export function decodeCursor(raw: string): NotificationCursor | null {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(raw)) return null;
  const [at, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !at || !id || !CURSOR_AT.test(at) || !UUID.test(id) || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}
