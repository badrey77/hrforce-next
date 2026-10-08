/**
 * Audit API types — copied from the binding contract `docs/contracts/audit.md` › Endpoint.
 * Keep field names exactly as written there: the API builds against the same text. Plain TypeScript, no Angular.
 *
 * Lives in core/ (not shared/timeline/): the Employees screens will want the same types, and anything in shared/
 * or features/ may import core/, never the other way round.
 */

/** Subject types the timeline endpoint accepts (`?subject=<type>:<id>`). */
/** `leave_request` (notifications contract › Audit gap): its rows, its workflow tasks and `workflow.*` events. */
/** `issued_document` (documents contract › Audit): its row and its `document.*` events. */
/** `attendance_device` (attendance contract › Audit and timeline): a kiosk's rows and its `attendance.device_paired` events. */
export type AuditSubjectType =
  | 'org_unit'
  | 'site'
  | 'role'
  | 'user'
  | 'employee'
  | 'leave_request'
  | 'issued_document'
  | 'attendance_device'
  /** Attendance Phase B: a correction request's rows, items, workflow tasks and `workflow.*` events. */
  | 'attendance_correction'
  /** SSO: a connected app's rows, its roles' rows, its assignments' rows and its `sso.*` events (`sso.read` + `audit.read`). */
  | 'sso_client'
  /** Recruitment: an opening's rows, workflow rows and events; an application's events and its candidate's. */
  | 'recruitment_opening'
  | 'recruitment_application';

/**
 * `"<type>:<uuid>"`, e.g. `org_unit:0190…` (type one of `AuditSubjectType`). A plain `string`, not the template
 * literal type `` `${AuditSubjectType}:${string}` ``: templates build it by concatenation
 * (`'org_unit:' + unit.id`), which the template type-checker types as `string`.
 */
export type AuditSubject = string;

export type AuditOp = 'insert' | 'update' | 'delete';

/** One changed column of a row change. `masked` → `before`/`after` hold `"***"`, never the value. */
export interface AuditChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly masked: boolean;
}

/** An application event (`auth.login`, `access.grant_created`…) — see the contract's "Application events" table. */
export interface AuditEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface TimelineEntry {
  /** `"c:<id>"` (row change) or `"e:<id>"` (event) — unique across both, so it is our `@for` track key. */
  readonly id: string;
  /** ISO timestamp. */
  readonly at: string;
  /** `null` = system / seed / migration. */
  readonly actor: { readonly id: string; readonly displayName: string } | null;
  readonly requestId: string | null;
  readonly kind: 'change' | 'event';
  // kind = change
  readonly table?: string;
  readonly op?: AuditOp;
  readonly changes?: readonly AuditChange[];
  // kind = event
  readonly event?: AuditEvent;
}

/** `GET /api/audit/timeline` — newest first; `nextCursor: null` = no older entries. */
export interface TimelinePage {
  readonly items: readonly TimelineEntry[];
  readonly nextCursor: string | null;
}

/** Contract default page size. */
export const TIMELINE_PAGE_SIZE = 50;
