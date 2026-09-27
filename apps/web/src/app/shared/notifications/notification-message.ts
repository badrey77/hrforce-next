/**
 * Turns a notification (`type` + `data`) into a translation key and its placeholders. Plain TypeScript, no Angular:
 * the formatting helpers (leave type name, dates, numbers) are passed in, so it is unit-testable without TestBed and
 * the template stays free of logic.
 *
 * Keys: `notifications.types.<type>` (`task.assigned` → `notifications.types.task.assigned`: Transloco reads the dots
 * as nesting, the same as `audit.events.<type>`). The template falls back to `notifications.types.unknown` when a type
 * has no key yet (the API may add one before the web).
 *
 * `data` holds names, dates and the leave type CODE (contract › NotificationView), never ids to resolve: the
 * recipient may not be allowed to read the employee, so the server wrote what they may see.
 */
import type { NotificationView } from '../../core/notifications/notifications.models';

export interface MessageFormatters {
  /** Leave type code → name in the UI language (LeaveCatalog.nameOfCode). */
  readonly leaveType: (code: string) => string;
  /** `YYYY-MM-DD` → a date in the UI language. */
  readonly date: (iso: string) => string;
  /** Days (one decimal at most) → a number in the UI language. */
  readonly days: (days: number) => string;
  /** Arabic UI: use `employeeNameAr` when the server sent one (optional Arabic names, HANDOFF assumptions). */
  readonly arabic?: boolean;
}

export interface NotificationMessage {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

/** Every placeholder a sentence may use; missing data shows as an ellipsis rather than a raw `{{placeholder}}`. */
const PLACEHOLDERS = ['employeeName', 'leaveType', 'startDate', 'endDate', 'days', 'actorName', 'stepKey'] as const;
const MISSING = '…';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function notificationMessage(notification: Pick<NotificationView, 'type' | 'data'>, format: MessageFormatters): NotificationMessage {
  const params: Record<string, string> = {};
  for (const name of PLACEHOLDERS) params[name] = MISSING;
  for (const [name, value] of Object.entries(notification.data ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    if (name === 'leaveType') params[name] = format.leaveType(String(value));
    else if (name === 'days' && typeof value === 'number') params[name] = format.days(value);
    else if (typeof value === 'string' && DATE.test(value)) params[name] = format.date(value);
    else params[name] = String(value);
  }
  const arabicName = notification.data?.['employeeNameAr'];
  if (format.arabic && typeof arabicName === 'string' && arabicName.trim()) params['employeeName'] = arabicName;
  return { key: `notifications.types.${notification.type}`, params };
}
