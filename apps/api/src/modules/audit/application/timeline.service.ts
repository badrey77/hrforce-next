import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { WorkflowEngine } from '../../workflow/index.js';
import { encodeCursor, fieldChanges, type TimelineCursor, type TimelineSubject } from '../domain/timeline.js';
import { AuditRepository, type TimelineRow } from '../infra/audit.repository.js';
import type { TimelineEntry, TimelineView } from './timeline-views.js';

export const AUDIT_READ = 'audit.read';
export const LEAVE_READ = 'leave.read';
export const DOCUMENT_READ = 'document.read';
export const MEDICAL_READ = 'employee.medical.read';
export const ATTENDANCE_CONFIGURE = 'attendance.configure';

function subjectNotFound(): NotFoundException {
  return new NotFoundException('Subject not found');
}

/**
 * History of one subject (docs/contracts/audit.md › Endpoint, › Permission). Visibility follows the caller's
 * audit.read scope: an org unit (with its versions) when the unit is in scope; a user when any of their grants is in
 * scope or they have none — then their events and their grants whose unit is in scope; roles and sites company-wide
 * (audit.read held anywhere, which the route guard already checked); an employee (employment id: the employment, its
 * assignments and salaries, its person and person_sensitive rows, its leave requests and their workflow events) when
 * the employee's scope unit is in scope; a leave request (the request, its workflow instance and tasks, its workflow.*
 * events) like GET /leave/requests/:id — leave.read over the request's unit, the requester or the employee's linked
 * user, or a current candidate of its open task (no audit.read needed); an issued document (its register row and its
 * document.* events) like GET /documents/:id — document.read over the employee's scope unit (no audit.read needed).
 * The employee timeline also lists the employee's issued documents and self-service document requests with their
 * events, and its employee-file rows and events — those of MEDICAL files only when the caller also holds
 * employee.medical.read over the employee's unit (a file title can be medical data) — and its attendance punch events
 * except QR arrivals/departures (manual punches, voids, deletions; docs/contracts/attendance.md › Audit and timeline).
 * An attendance kiosk (its device rows and events) is visible with attendance.configure held anywhere (no audit.read).
 * Anything else — unknown, other company, out of scope — is 404.
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly scopes: ScopeService,
    private readonly workflow: WorkflowEngine,
  ) {}

  async timeline(subject: TimelineSubject, cursor: TimelineCursor | null, limit: number): Promise<TimelineView> {
    const { companyId } = requireContext();
    if (!companyId) throw subjectNotFound();
    const { medicalFiles } = await this.assertVisible(companyId, subject);

    const rows = await this.repo.timeline(companyId, subject, {
      cursor,
      limit: limit + 1,
      unitScope: await this.scopes.scopeOf(AUDIT_READ),
      medicalFiles,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last ? encodeCursor({ at: last.atMicros, kind: last.kind, id: last.id }) : null;

    const names = new Map((await this.repo.members(companyId)).map((m) => [m.id, m.displayName]));
    const masked = page.some((r) => r.kind === 0) ? await this.repo.maskedColumns() : new Map<string, Set<string>>();
    return { items: page.map((row) => toEntry(row, names, masked)), nextCursor };
  }

  /** 404 unless the caller may see the subject's history; `medicalFiles`: medical employee-file entries are included. */
  private async assertVisible(companyId: string, subject: TimelineSubject): Promise<{ medicalFiles: boolean }> {
    const plain = { medicalFiles: false };
    switch (subject.type) {
      case 'org_unit':
        if (!(await this.scopes.inScope(AUDIT_READ, subject.id))) throw subjectNotFound();
        return plain;
      case 'site':
      case 'role':
        // company-wide: audit.read held anywhere (checked by the route's @RequirePermission)
        if (!(await this.repo.rowKnown(companyId, subject.type, subject.id))) throw subjectNotFound();
        return plain;
      case 'employee': {
        // the employee's scope: the unit of its assignment valid today, else its last one (ended), else its first
        const unitId = await this.repo.employeeScopeUnit(companyId, subject.id);
        if (!unitId || !(await this.scopes.inScope(AUDIT_READ, unitId))) throw subjectNotFound();
        return { medicalFiles: await this.scopes.inScope(MEDICAL_READ, unitId) };
      }
      case 'leave_request': {
        const request = await this.repo.leaveRequestAccess(companyId, subject.id);
        if (!request) throw subjectNotFound();
        const { userId } = requireContext();
        const visible =
          request.requestedBy === userId ||
          (request.linkedUserId !== null && request.linkedUserId === userId) ||
          (await this.scopes.inScope(LEAVE_READ, request.orgUnitId)) ||
          (request.workflowInstanceId !== null && (await this.workflow.isCandidate(request.workflowInstanceId)));
        if (!visible) throw subjectNotFound();
        return plain;
      }
      case 'issued_document': {
        const employmentId = await this.repo.issuedDocumentEmployment(companyId, subject.id);
        const unitId = employmentId ? await this.repo.employeeScopeUnit(companyId, employmentId) : undefined;
        if (!unitId || !(await this.scopes.inScope(DOCUMENT_READ, unitId))) throw subjectNotFound();
        return plain;
      }
      case 'attendance_device': {
        if ((await this.scopes.unitIds(ATTENDANCE_CONFIGURE)).size === 0) throw subjectNotFound();
        if (!(await this.repo.attendanceDeviceKnown(companyId, subject.id))) throw subjectNotFound();
        return plain;
      }
      case 'user': {
        const member = (await this.repo.members(companyId)).some((m) => m.id === subject.id);
        if (!member) throw subjectNotFound();
        const units = await this.repo.grantUnitsOf(companyId, subject.id);
        if (units.length === 0) return plain;
        const readable = await this.scopes.unitIds(AUDIT_READ);
        if (!units.some((u) => readable.has(u))) throw subjectNotFound();
        return plain;
      }
    }
  }
}

function toEntry(row: TimelineRow, names: ReadonlyMap<string, string>, masked: ReadonlyMap<string, ReadonlySet<string>>): TimelineEntry {
  const base = {
    at: row.at.toISOString(),
    // a former member keeps their id as display name (auth.company_members lists current members only)
    actor: row.actorUserId ? { id: row.actorUserId, displayName: names.get(row.actorUserId) ?? row.actorUserId } : null,
    requestId: row.requestId,
  };
  if (row.kind === 1) {
    return { id: `e:${row.id}`, ...base, kind: 'event', event: { type: row.type ?? '', data: row.data ?? {} } };
  }
  const table = row.tableName ?? '';
  return {
    id: `c:${row.id}`,
    ...base,
    kind: 'change',
    table,
    op: row.op ?? 'update',
    changes: fieldChanges({ before: row.before, after: row.after, changed: row.changed ?? [] }, masked.get(table) ?? new Set()),
  };
}
