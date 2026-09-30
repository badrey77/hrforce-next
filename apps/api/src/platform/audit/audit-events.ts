/**
 * Seam for application audit events (docs/contracts/audit.md › Application events; ADR 005: row triggers capture
 * WHAT changed, these events add the use case — a login, a grant — that a row diff cannot express).
 * Implemented by the Audit module (global provider), so Identity and Authorization emit events without importing it.
 * Rows land in audit.event through the SECURITY DEFINER function audit.record_event(): the company, actor and request
 * id always come from the transaction's settings (app.company_id / app.user_id / app.request_id), never from here.
 */

/** Subject types of audit events and timelines. */
export type AuditSubjectType =
  | 'user'
  | 'org_unit'
  | 'site'
  | 'role'
  | 'employee'
  | 'leave_request'
  | 'document_request'
  | 'issued_document'
  | 'employee_file'
  | 'attendance_device';

export interface AuditEventInput {
  /** `<area>.<event>`, e.g. `auth.login`, `access.grant_created` */
  type: string;
  subject: { type: AuditSubjectType; id: string } | null;
  /** JSON object stored as is (no secrets: never tokens, hashes or passwords). */
  data?: Record<string, unknown>;
}

/** Tenant and actor of an event written outside a request transaction. `actorUserId` null = system. */
export interface AuditTenant {
  companyId: string;
  actorUserId: string | null;
}

export abstract class AuditEvents {
  /**
   * Writes the event inside the CURRENT request transaction (rolled back with it). Throws when the route has no
   * request transaction (@SkipTransaction) — use {@link recordFor} there.
   */
  abstract record(event: AuditEventInput): Promise<void>;

  /**
   * Writes the event in its own short transaction with `app.company_id` = `tenant.companyId`, `app.user_id` =
   * `tenant.actorUserId` and the current request id (routes without a request transaction, i.e. /api/auth/*).
   */
  abstract recordFor(tenant: AuditTenant, event: AuditEventInput): Promise<void>;
}
