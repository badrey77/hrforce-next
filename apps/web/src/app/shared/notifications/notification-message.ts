/**
 * Turns a notification (`type` + `data`) into a translation key and its placeholders. Plain TypeScript, no Angular:
 * the formatting helpers (leave type name, dates, numbers) are passed in, so it is unit-testable without TestBed and
 * the template stays free of logic.
 *
 * Keys: `notifications.types.<type>` (`task.assigned` → `notifications.types.task.assigned`: Transloco reads the dots
 * as nesting, the same as `audit.events.<type>`). The template falls back to `notifications.types.unknown` when a type
 * has no key yet (the API may add one before the web).
 *
 * **Wording by audience** (notifications contract): the same event reads differently for the employee it is about
 * ("Your request … was approved") and for anyone else — an HR user who filed it on their behalf, an approver
 * ("Amina BENALI's request … was approved"). For the types in `WORDED_BY_AUDIENCE`, any audience other than
 * `employee` (including `null`, and a missing field from an older payload) uses the sentence under
 * `notifications.typesNamed.<type>`, which names the employee. A parallel key tree rather than one sentence with a
 * `{{whose}}` placeholder: "your" vs "X's" changes word order and agreement in French and Arabic, so each language
 * needs whole sentences.
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
  /**
   * Translation key of the document type's name (`documents.typeNames.<code>`), when the data names one. The template
   * translates it and passes it as the `documentType` placeholder: a type code is fixed in code, so its name is an
   * i18n key — no request to the document catalogue from the header bell.
   */
  readonly documentTypeKey?: string;
}

/** Types whose sentence depends on `audience`; the others already name the employee (or only go to them). */
export const WORDED_BY_AUDIENCE: ReadonlySet<string> = new Set(['leave.approved', 'leave.rejected', 'task.escalated']);

/**
 * Translation key of a notification's sentence: "your request" for its employee, "X's request" for anyone else.
 * `task.assigned` about a document request (`data.subjectType`, documents contract › Notifications) has its own
 * sentence (`…task.assigned_document`): "Attestation request to handle: <Name>", not the leave wording with dates.
 * Attendance corrections (attendance contract › Phase B › Notifications) likewise: `task.assigned` with
 * `data.subjectType: 'attendance_correction'` → `…task.assigned_attendance`, and `task.escalated` whose SUBJECT is a
 * correction (its subject is the request itself, not a task) → `…task.escalated_attendance`.
 */
export function notificationKey(
  notification: Pick<NotificationView, 'type'> & Partial<Pick<NotificationView, 'audience' | 'data' | 'subject'>>,
): string {
  const aboutSomeoneElse = WORDED_BY_AUDIENCE.has(notification.type) && notification.audience !== 'employee';
  let suffix = '';
  if (notification.type === 'task.assigned') {
    const subjectType = notification.data?.['subjectType'];
    if (subjectType === 'document_request') suffix = '_document';
    else if (subjectType === 'attendance_correction') suffix = '_attendance';
  } else if (notification.type === 'task.escalated' && notification.subject?.type === 'attendance_correction') {
    suffix = '_attendance';
  }
  return `notifications.${aboutSomeoneElse ? 'typesNamed' : 'types'}.${notification.type}${suffix}`;
}

/** Every placeholder a sentence may use; missing data shows as an ellipsis rather than a raw `{{placeholder}}`. */
const PLACEHOLDERS = ['employeeName', 'leaveType', 'startDate', 'endDate', 'days', 'actorName', 'stepKey', 'documentType', 'number', 'date', 'changes'] as const;
const MISSING = '…';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function notificationMessage(
  notification: Pick<NotificationView, 'type' | 'data'> & Partial<Pick<NotificationView, 'audience' | 'subject'>>,
  format: MessageFormatters,
): NotificationMessage {
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
  const documentType = notification.data?.['documentType'];
  const message = { key: notificationKey(notification), params };
  return typeof documentType === 'string' && documentType ? { ...message, documentTypeKey: `documents.typeNames.${documentType}` } : message;
}
