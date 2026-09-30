/**
 * Audit timeline — pure rules (docs/contracts/audit.md › Endpoint). No Nest, no Kysely.
 */

export const TIMELINE_SUBJECT_TYPES = ['org_unit', 'site', 'role', 'user', 'employee', 'leave_request', 'issued_document', 'attendance_device', 'attendance_correction'] as const;

/** Subject types whose history follows the subject's own visibility rule instead of `audit.read`. */
export const SELF_VISIBLE_SUBJECT_TYPES: readonly TimelineSubjectType[] = ['leave_request', 'issued_document', 'attendance_device', 'attendance_correction'];
export type TimelineSubjectType = (typeof TIMELINE_SUBJECT_TYPES)[number];

export interface TimelineSubject {
  type: TimelineSubjectType;
  id: string;
}

export const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 100;
/** Value stored instead of a masked column's value (audit.capture()). */
export const MASKED_VALUE = '***';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTimelineSubjectType(value: string): value is TimelineSubjectType {
  return (TIMELINE_SUBJECT_TYPES as readonly string[]).includes(value);
}

export type SubjectParse =
  | { ok: true; subject: TimelineSubject }
  /** `syntax`: not `<type>:<id>` or unknown type (422) · `unknown`: well-formed type but the id cannot exist (404) */
  | { ok: false; reason: 'syntax' | 'unknown' };

/** `<type>:<uuid>`, e.g. `org_unit:0190a5d0-…`. The id is lower-cased. */
export function parseSubject(raw: string): SubjectParse {
  const colon = raw.indexOf(':');
  if (colon <= 0) return { ok: false, reason: 'syntax' };
  const type = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (!isTimelineSubjectType(type)) return { ok: false, reason: 'syntax' };
  if (!UUID.test(id)) return { ok: false, reason: 'unknown' };
  return { ok: true, subject: { type, id: id.toLowerCase() } };
}

/**
 * Position of an entry in the merged, newest-first order: (at, kind, id) descending — `at` with microseconds (all the
 * rows of one transaction share it), events after changes of the same instant, then the per-table identity.
 */
export interface TimelineCursor {
  /** ISO-8601 UTC with microseconds, e.g. 2026-09-26T11:09:47.059884Z */
  at: string;
  kind: 0 | 1;
  id: string;
}

const CURSOR_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DIGITS = /^\d{1,19}$/;

export function encodeCursor(cursor: TimelineCursor): string {
  return Buffer.from(`${cursor.at}|${cursor.kind}|${cursor.id}`, 'utf8').toString('base64url');
}

/** null when malformed. */
export function decodeCursor(raw: string): TimelineCursor | null {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(raw)) return null;
  const [at, kind, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !at || !CURSOR_AT.test(at) || (kind !== '0' && kind !== '1') || !id || !DIGITS.test(id)) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  return { at, kind: kind === '1' ? 1 : 0, id };
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  masked: boolean;
}

export type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One line per changed column, in the stored `changed` order. A column listed in `masked` shows MASKED_VALUE for any
 * non-null value — also for rows captured before it was masked (a newly masked column never leaks older values).
 */
export function fieldChanges(
  row: { before: unknown; after: unknown; changed: readonly string[] },
  masked: ReadonlySet<string>,
): FieldChange[] {
  const before = isObject(row.before) ? row.before : null;
  const after = isObject(row.after) ? row.after : null;
  return row.changed.map((field) => {
    const isMasked = masked.has(field);
    const value = (image: JsonObject | null): unknown => {
      const v = image?.[field] ?? null;
      return isMasked && v !== null ? MASKED_VALUE : v;
    };
    return { field, before: value(before), after: value(after), masked: isMasked };
  });
}
