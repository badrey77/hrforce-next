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
 * workflow step key (`manager`, `hr`) named by the request's workflow definition.
 */
export type AuditRefKind = 'unit' | 'site' | 'role' | 'roleCode' | 'permission' | 'user' | 'kind' | 'leaveType' | 'step';

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
};

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

function displayValue(
  value: unknown,
  masked: boolean,
  ref: AuditRefKind | undefined,
  resolve: AuditNameResolver,
  enumPrefix?: string,
): DisplayValue {
  if (masked || value === MASK) return { kind: 'masked' };
  if (value === null || value === undefined || value === '') return { kind: 'empty' };
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (enumPrefix && typeof value === 'string') return { kind: 'key', key: enumPrefix + value, text: value };
  if (typeof value === 'string') {
    const range = RANGE.exec(value);
    if (range?.[1]) return { kind: 'range', from: range[1], to: range[2] ?? null };
    if (DATE.test(value) && !Number.isNaN(Date.parse(value))) return { kind: 'date', iso: value };
    if (TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))) return { kind: 'timestamp', iso: value };
    return { kind: 'text', text: (ref && resolve(ref, value)) || value };
  }
  if (typeof value === 'number') return { kind: 'text', text: String(value) };
  return { kind: 'text', text: JSON.stringify(value) };
}

function isHidden(table: string, field: string): boolean {
  return (HIDDEN_FIELDS['*'] ?? []).includes(field) || (HIDDEN_FIELDS[table] ?? []).includes(field);
}

function fieldLine(table: string, op: AuditOp, change: AuditChange, resolve: AuditNameResolver): FieldLine {
  const ref = REFERENCE_FIELDS[change.field];
  const enumPrefix = ENUM_FIELDS[`${table}.${change.field}`];
  return {
    field: change.field,
    labelKey: `audit.fields.${table}.${change.field}`,
    before: op === 'insert' ? null : displayValue(change.before, change.masked, ref, resolve, enumPrefix),
    after: op === 'delete' ? null : displayValue(change.after, change.masked, ref, resolve, enumPrefix),
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
  return params;
}

export function toEntryView(entry: TimelineEntry, resolve: AuditNameResolver, formatDay: DayFormatter = RAW_DAY): EntryView {
  const base = { id: entry.id, at: entry.at, actor: entry.actor?.displayName ?? null };
  if (entry.kind === 'event' && entry.event) {
    return {
      ...base,
      kind: 'event',
      type: entry.event.type,
      sentenceKey: `audit.events.${entry.event.type}`,
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
