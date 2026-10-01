/**
 * Turns API timeline entries into what the timeline template shows: day groups, one line per changed field,
 * display values (masked / empty / yes-no / date range / resolved name), translation keys for tables, ops, fields
 * and event sentences. Plain TypeScript — no Angular — so it is unit-testable without TestBed and the template
 * stays free of logic. The Timeline component calls `buildTimeline()` inside a `computed()` (see timeline.ts for
 * why a `computed()` rather than a grouping pipe).
 *
 * Translation keys (docs/contracts/audit.md › Web): `audit.fields.<table>.<column>` (unknown → the column name,
 * decided in the template), `audit.tables.<table>`, `audit.ops.<op>`, `audit.events.<type>` (event data as
 * placeholders).
 */
import type { AuditChange, AuditOp, TimelineEntry } from '../../core/audit/audit.models';

/**
 * What an id-like value refers to, so a page can name it. `leaveType` = a leave type id (LeaveCatalog), `step` = a
 * workflow step key (`manager`, `hr`) named by the request's workflow definition, `signatory` = a document
 * signatory id, `fileCategory` = an employee file category id.
 */
export type AuditRefKind =
  | 'unit'
  | 'site'
  | 'role'
  | 'roleCode'
  | 'permission'
  | 'user'
  | 'kind'
  | 'leaveType'
  | 'step'
  | 'signatory'
  | 'fileCategory'
  /** A connected app's role id (`sso_role_assignment.sso_app_role_id`), named by its code where the page knows it. */
  | 'appRole';

/**
 * References whose raw value means nothing to a reader (a bare UUID, unlike a role code or a unit id an admin may
 * recognise): when the page cannot name them, the line says "name not available" instead of printing the id.
 */
const OPAQUE_REFS: ReadonlySet<AuditRefKind> = new Set<AuditRefKind>(['signatory', 'fileCategory', 'appRole']);

/**
 * Names a referenced value (a unit id, a role code…) from data the host page already has, or `undefined` to show
 * the raw value. May READ SIGNALS: it is called inside the timeline's `computed()`, so the names update when the
 * page's data (tree, sites, role catalogue) arrives. Pass a stable function (a class field), not an inline arrow.
 */
export type AuditNameResolver = (kind: AuditRefKind, value: string) => string | undefined;

/** Columns whose values are ids/codes of something with a name. */
export const REFERENCE_FIELDS: Readonly<Record<string, AuditRefKind>> = {
  parent_id: 'unit',
  org_unit_id: 'unit',
  site_id: 'site',
  role_id: 'role',
  permission_code: 'permission',
  user_id: 'user',
  granted_by: 'user',
  ended_by: 'user',
  kind: 'kind',
  // Leave requests and their approval flow (notifications contract › Audit gap).
  leave_type_id: 'leaveType',
  requested_by: 'user',
  started_by: 'user',
  acted_by: 'user',
  assignee_user_id: 'user',
  scope_unit_id: 'unit',
  step_key: 'step',
  // Documents (documents contract › Audit): who issued / voided a document.
  issued_by: 'user',
  voided_by: 'user',
  // Employee file (documents contract › Phase B): who added / deleted a document.
  uploaded_by: 'user',
  deleted_by: 'user',
  // Documents: the signatory of an issued document, the default one of a type; the category of an employee file.
  signatory_id: 'signatory',
  default_signatory_id: 'signatory',
  category_id: 'fileCategory',
  // Attendance (attendance contract › Audit): who recorded a manual punch, who revoked a kiosk.
  created_by: 'user',
  revoked_by: 'user',
  // SSO (sso contract › Audit): who assigned an app role, who disabled an app; which app role an assignment is for.
  assigned_by: 'user',
  disabled_by: 'user',
  sso_app_role_id: 'appRole',
};

/**
 * SHA-256 columns (`bytea`): the audit diff holds them as Postgres writes a bytea in JSON, `\x` + 64 hex digits.
 * Shown as a short fingerprint (the document detail page's convention), the full value on hover.
 */
const HASH_FIELDS: ReadonlySet<string> = new Set(['content_sha256', 'sha256', 'logo_sha256']);
const HEX = /^(?:\\x)?([0-9a-f]{2,})$/i;
/** Hex digits shown: enough to compare two fingerprints by eye. */
export const SHORT_HASH_LENGTH = 12;

/**
 * Columns holding a code from a fixed list, shown through a translation key `<prefix><value>` (e.g. a leave request
 * `status` "approved" → `leave.status.approved`, the same word the leave screens use). Unknown values fall back to
 * the stored text (decided in the template).
 */
export const ENUM_FIELDS: Readonly<Record<string, string>> = {
  'leave_request.status': 'leave.status.',
  'workflow_instance.status': 'leave.status.',
  'workflow_task.status': 'audit.values.workflow_task.status.',
  'workflow_task.outcome': 'audit.values.workflow_task.outcome.',
  'workflow_task.assignee_kind': 'audit.values.workflow_task.assignee_kind.',
  // Documents: the same words as the documents screens.
  'issued_document.status': 'documents.status.',
  'issued_document.language': 'documents.languages.',
  'issued_document.type_code': 'documents.typeNames.',
  'document_request.status': 'documents.requestStatus.',
  'document_request.language': 'documents.languages.',
  'employee_file_category.access_class': 'documents.fileCategories.class.',
  // Reserved for a future antivirus (documents contract › Phase B): today always `not_scanned`.
  'employee_file.scan_status': 'audit.values.employee_file.scan_status.',
  // Attendance: the same words as the attendance screens.
  'attendance_punch.direction': 'attendance.direction.',
  'attendance_punch.source': 'attendance.source.',
  'attendance_punch.status': 'attendance.punchStatus.',
  'attendance_device.status': 'attendance.kiosks.statusName.',
  // Attendance Phase B: corrections.
  'attendance_correction.status': 'attendance.corrections.status.',
  'attendance_correction_item.action': 'attendance.corrections.action.',
  'attendance_correction_item.direction': 'attendance.direction.',
  // SSO: the same words as Access → Applications.
  'sso_client.status': 'sso.status.',
  'sso_client.client_auth_method': 'sso.authMethod.',
};

/**
 * Columns not worth a line: the row id and tenant id (the subject is already known), and columns GENERATED from
 * others (`org_unit_version.name_search` from `name`; `role_grant.valid` from `valid_from`/`valid_to`).
 */
const HIDDEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  '*': ['id', 'company_id'],
  org_unit_version: ['name_search'],
  role_grant: ['valid'],
  // Employee subject (employment contract › Audit): the link columns only repeat the subject.
  employment: ['person_id'],
  assignment: ['employment_id'],
  employment_salary: ['employment_id', 'currency'],
  person_sensitive: ['person_id'],
  // Leave: the links only repeat the subject (the request, its employee, its flow).
  leave_request: ['employment_id', 'workflow_instance_id'],
  workflow_instance: ['definition_id', 'subject_type', 'subject_id', 'subject_user_id'],
  workflow_task: ['instance_id'],
  // Documents: links that repeat the subject or the type (shown by `type_code`); `snapshot` is the whole printed text
  // as JSON — one unreadable line here, and the document's detail page already shows what was printed.
  issued_document: ['employment_id', 'document_type_id', 'snapshot'],
  document_request: ['employment_id', 'document_type_id', 'workflow_instance_id'],
  // Employee file: the employment repeats the subject.
  employee_file: ['employment_id'],
  // Attendance: the employment repeats the subject; `work_date` is generated from `occurred_at`.
  attendance_punch: ['employment_id', 'work_date', 'correction_id', 'void_correction_id'],
  // Attendance Phase B: the links repeat the subject; punch ids mean nothing to a reader (the item shows the time).
  attendance_correction: ['employment_id', 'workflow_instance_id'],
  attendance_correction_item: ['correction_id', 'punch_id', 'result_punch_id'],
  // SSO: a role row on the app's own history repeats the app.
  sso_app_role: ['sso_client_id'],
};

export type DisplayValue =
  | { readonly kind: 'masked' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'bool'; readonly value: boolean }
  /** A Postgres `daterange` as stored (`[2026-01-01,2027-01-01)`); `to: null` = open end. */
  | { readonly kind: 'range'; readonly from: string; readonly to: string | null }
  /** A `date` as stored (`YYYY-MM-DD`) — formatted by `DatePipe` in the UI language (Angular reads it as a local day: no timezone shift). */
  | { readonly kind: 'date'; readonly iso: string }
  /** A `timestamptz` as stored (ISO) — formatted by `DatePipe` in the UI language. */
  | { readonly kind: 'timestamp'; readonly iso: string }
  /** A code from a fixed list (`ENUM_FIELDS`): shown as `t(key)`, or `text` when the key is unknown. */
  | { readonly kind: 'key'; readonly key: string; readonly text: string }
  /** A SHA-256 fingerprint: `hex` in full (for `title`), `short` = its first `SHORT_HASH_LENGTH` digits. */
  | { readonly kind: 'hash'; readonly hex: string; readonly short: string }
  /** An id the page cannot name (`OPAQUE_REFS`): a neutral "name not available", never the raw id. */
  | { readonly kind: 'unnamed' }
  | { readonly kind: 'text'; readonly text: string };

export interface FieldLine {
  readonly field: string;
  /** `audit.fields.<table>.<field>`; the template falls back to `field` when the key is unknown. */
  readonly labelKey: string;
  /** `null` = not shown (an insert has no "before", a delete no "after"). */
  readonly before: DisplayValue | null;
  readonly after: DisplayValue | null;
}

interface EntryViewBase {
  readonly id: string;
  readonly at: string;
  readonly actor: string | null;
}

export interface ChangeView extends EntryViewBase {
  readonly kind: 'change';
  readonly table: string;
  readonly op: AuditOp;
  readonly lines: readonly FieldLine[];
}

export interface EventView extends EntryViewBase {
  readonly kind: 'event';
  readonly type: string;
  /** `audit.events.<type>`; the template shows `audit.events.unknown` when the key is missing. */
  readonly sentenceKey: string;
  /** Placeholders of the sentence: the event data (scalars), plus resolved `unit` / `role` names. */
  readonly params: Readonly<Record<string, string>>;
}

export type EntryView = ChangeView | EventView;

export interface DayGroup {
  /** Local calendar day, `YYYY-MM-DD` — the `@for` track key and the input of the `dayHeading` pipe. */
  readonly day: string;
  readonly relative: 'today' | 'yesterday' | null;
  readonly entries: readonly EntryView[];
}

const RANGE = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})?\)$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Formats a `YYYY-MM-DD` day for an event sentence (the Timeline passes one bound to the UI language). */
export type DayFormatter = (isoDay: string) => string;
const RAW_DAY: DayFormatter = (isoDay) => isoDay;
export const MASK = '***';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The LOCAL calendar day of a timestamp (a change at 00:30 in Algiers belongs to that day, not the UTC one). */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

interface FieldKind {
  readonly ref?: AuditRefKind | undefined;
  readonly enumPrefix?: string | undefined;
  readonly hash?: boolean;
}

function displayValue(value: unknown, masked: boolean, field: FieldKind, resolve: AuditNameResolver): DisplayValue {
  const { ref, enumPrefix } = field;
  if (masked || value === MASK) return { kind: 'masked' };
  if (value === null || value === undefined || value === '') return { kind: 'empty' };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (enumPrefix && typeof value === 'string') return { kind: 'key', key: enumPrefix + value, text: value };
  if (field.hash && typeof value === 'string') {
    const hex = HEX.exec(value)?.[1]?.toLowerCase();
    if (hex) return { kind: 'hash', hex, short: hex.slice(0, SHORT_HASH_LENGTH) };
  }
  if (typeof value === 'string') {
    const range = RANGE.exec(value);
    if (range?.[1]) return { kind: 'range', from: range[1], to: range[2] ?? null };
    if (DATE.test(value) && !Number.isNaN(Date.parse(value))) return { kind: 'date', iso: value };
    if (TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))) return { kind: 'timestamp', iso: value };
    const name = ref ? resolve(ref, value) : undefined;
    if (name) return { kind: 'text', text: name };
    if (ref && OPAQUE_REFS.has(ref)) return { kind: 'unnamed' };
    return { kind: 'text', text: value };
  }
  if (typeof value === 'number') return { kind: 'text', text: String(value) };
  // Lists (e.g. a kiosk's allowed networks): "(empty)" for none, else the items separated by commas — not raw JSON.
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'empty' };
    if (value.every((item) => typeof item === 'string' || typeof item === 'number')) return { kind: 'text', text: value.join(', ') };
  }
  return { kind: 'text', text: JSON.stringify(value) };
}

function isHidden(table: string, field: string): boolean {
  return (HIDDEN_FIELDS['*'] ?? []).includes(field) || (HIDDEN_FIELDS[table] ?? []).includes(field);
}

function fieldLine(table: string, op: AuditOp, change: AuditChange, resolve: AuditNameResolver): FieldLine {
  const kind: FieldKind = {
    ref: REFERENCE_FIELDS[change.field],
    enumPrefix: ENUM_FIELDS[`${table}.${change.field}`],
    hash: HASH_FIELDS.has(change.field),
  };
  return {
    field: change.field,
    labelKey: `audit.fields.${table}.${change.field}`,
    before: op === 'insert' ? null : displayValue(change.before, change.masked, kind, resolve),
    after: op === 'delete' ? null : displayValue(change.after, change.masked, kind, resolve),
  };
}

function eventParams(data: Readonly<Record<string, unknown>>, resolve: AuditNameResolver, formatDay: DayFormatter): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && DATE.test(value)) params[key] = formatDay(value);
    else params[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  if (params['unitId']) params['unit'] = resolve('unit', params['unitId']) || params['unitId'];
  if (params['roleCode']) params['role'] = resolve('roleCode', params['roleCode']) || params['roleCode'];
  // workflow.* events carry the step KEY; the host page may know its label (the request's workflow definition).
  if (params['step']) params['step'] = resolve('step', params['step']) || params['step'];
  // attendance.correction_item_* events carry the item's 0-based `position`; a reader counts changes from 1.
  if (typeof data['position'] === 'number') params['number'] = String(data['position'] + 1);
  return params;
}

/**
 * Punch events (attendance contract › Settled by the build) carry only `{source, direction?}` — no time, no employee,
 * by design (the retention purge must leave nothing personal in the audit log). The sentence is therefore picked by
 * those codes — `audit.events.attendance.punch_recorded.manual_in`, `….punch_voided.qr` — so it reads naturally in
 * every language instead of showing raw `in` / `qr` placeholders. Other events: `audit.events.<type>`.
 */
const VARIANT_EVENTS: ReadonlySet<string> = new Set(['attendance.punch_recorded', 'attendance.punch_voided', 'attendance.punch_deleted']);

export function eventSentenceKey(type: string, data: Readonly<Record<string, unknown>>): string {
  const base = `audit.events.${type}`;
  if (!VARIANT_EVENTS.has(type)) return base;
  const source = typeof data['source'] === 'string' ? data['source'] : 'unknown';
  const direction = typeof data['direction'] === 'string' ? `_${data['direction']}` : '';
  return `${base}.${source}${direction}`;
}

export function toEntryView(entry: TimelineEntry, resolve: AuditNameResolver, formatDay: DayFormatter = RAW_DAY): EntryView {
  const base = { id: entry.id, at: entry.at, actor: entry.actor?.displayName ?? null };
  if (entry.kind === 'event' && entry.event) {
    return {
      ...base,
      kind: 'event',
      type: entry.event.type,
      sentenceKey: eventSentenceKey(entry.event.type, entry.event.data),
      params: eventParams(entry.event.data, resolve, formatDay),
    };
  }
  const table = entry.table ?? '';
  const op = entry.op ?? 'update';
  const lines = (entry.changes ?? [])
    .filter((change) => !isHidden(table, change.field))
    .map((change) => fieldLine(table, op, change, resolve));
  return { ...base, kind: 'change', table, op, lines };
}

/**
 * Entries (already newest first, as the API sends them) → day groups, newest day first, keeping the API order inside
 * each day. `now` is a parameter so tests can pin "today".
 */
export function buildTimeline(
  entries: readonly TimelineEntry[],
  resolve: AuditNameResolver,
  now: Date = new Date(),
  formatDay: DayFormatter = RAW_DAY,
): DayGroup[] {
  // People the page does not know (e.g. `granted_by`) are often the actors of these very entries: name them too.
  const actors = new Map(entries.flatMap((e) => (e.actor ? [[e.actor.id, e.actor.displayName] as const] : [])));
  const names: AuditNameResolver = (kind, value) => resolve(kind, value) ?? (kind === 'user' ? actors.get(value) : undefined);
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  // A Map keeps insertion order (newest day first) and guarantees one group per day — `day` is the `@for` track key,
  // and duplicate keys would confuse Angular's list diffing.
  const groups = new Map<string, { day: string; relative: DayGroup['relative']; entries: EntryView[] }>();
  for (const entry of entries) {
    const day = localDay(new Date(entry.at));
    let group = groups.get(day);
    if (!group) {
      group = { day, relative: day === today ? 'today' : day === yesterday ? 'yesterday' : null, entries: [] };
      groups.set(day, group);
    }
    group.entries.push(toEntryView(entry, names, formatDay));
  }
  return [...groups.values()];
}

/** A resolver that knows nothing: every value is shown as stored. */
export const NO_NAMES: AuditNameResolver = () => undefined;
