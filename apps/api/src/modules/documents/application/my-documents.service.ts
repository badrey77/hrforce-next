import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { Notifier, type NotificationData } from '../../../platform/notifications/notifier.js';
import { StaffingService } from '../../staffing/index.js';
import { WorkflowEngine, WorkflowSubjects, type HookContext } from '../../workflow/index.js';
import { checkEmploymentFor } from '../domain/rules.js';
import { DOCUMENT_WORKFLOW_CODE, type DocumentLanguage, type DocumentTypeCode } from '../domain/types.js';
import { DocumentsRepository, pgError, type RequestRow } from '../infra/documents.repository.js';
import { DocumentIssuer, documentProblem, documentProblems } from './document-issuer.js';
import { DocumentPresenter, labelsOf } from './document-presenter.js';
import type { DocumentRequestView, MyDocumentsView, PdfFile } from './document-views.js';
import { DocumentsClock } from './documents-clock.js';
import { caller } from './documents.service.js';

const notLinked = () => new ProblemException(409, 'document-not-linked', 'Your account is not linked to an employee.');
const requestNotFound = () => new NotFoundException('Document request not found');

/**
 * Self-service documents (docs/contracts/documents.md › /me/documents*, Assumption 6): an employee requests an
 * attestation for themselves; the request goes through the workflow engine (`document.hr_only`: one step,
 * `document.issue` over the employee's unit) and APPROVING it issues the document in the same transaction (issued_by =
 * the approver, the type's default signatory or the nearest one, the request's language). Also the `document_request`
 * subject hooks, and the notifications document.ready / document.rejected to the employee's linked user.
 */
@Injectable()
export class MyDocumentsService implements OnModuleInit {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly issuer: DocumentIssuer,
    private readonly presenter: DocumentPresenter,
    private readonly staffing: StaffingService,
    private readonly engine: WorkflowEngine,
    private readonly subjects: WorkflowSubjects,
    private readonly notifier: Notifier,
    private readonly audit: AuditEvents,
    private readonly clock: DocumentsClock,
  ) {}

  onModuleInit(): void {
    this.subjects.register('document_request', {
      // the definition has no manager step
      resolveManager: () => Promise.resolve({ userId: null, reason: 'no-manager' }),
      onApproved: (c) => this.onApproved(c),
      onRejected: (c) => this.onRejected(c),
      onCancelled: (c) => this.onCancelled(c),
      summaries: (ids) => this.summaries(ids),
      notificationData: (id) => this.notificationData(id),
    });
  }

  private async ownEmployment(): Promise<string> {
    const { userId } = caller();
    const employmentId = await this.staffing.linkedEmploymentOf(userId);
    if (!employmentId) throw notLinked();
    return employmentId;
  }

  // ── endpoints ───────────────────────────────────────────────────────────────────────────────────────────────────

  async mine(): Promise<MyDocumentsView> {
    const { companyId } = caller();
    const employmentId = await this.ownEmployment();
    const [documents, requests] = await Promise.all([this.repo.documentsOf(companyId, employmentId, { issuedOnly: true }), this.repo.requestsOf(companyId, employmentId)]);
    return {
      documents: await this.presenter.views(companyId, documents, { actions: false }),
      requests: await this.requestViews(companyId, requests),
    };
  }

  async request(input: { typeCode: DocumentTypeCode; language: DocumentLanguage; purpose: string | null }): Promise<DocumentRequestView> {
    const { companyId, userId } = caller();
    const employmentId = await this.ownEmployment();
    const type = await this.repo.typeByCode(companyId, input.typeCode);
    if (!type) throw new ValidationProblemException([{ field: 'typeCode', code: 'not_found', message: 'Unknown document type.' }]);
    if (!type.selfService) throw new ProblemException(409, 'document-type-not-self-service', 'This document is issued by HR only.');
    if (!type.active) throw new ProblemException(409, 'document-type-inactive', 'This document type is not active.');
    if (!type.languages.includes(input.language)) {
      throw new ValidationProblemException([{ field: 'language', code: 'unsupported_language', message: `One of: ${type.languages.join(', ')}` }]);
    }
    const today = this.clock.today();
    const employee = await this.repo.employee(companyId, employmentId, today);
    if (!employee) throw notLinked();
    await documentProblems(() => Promise.resolve(checkEmploymentFor(type.code, employee, today)));
    if (await this.repo.pendingRequestExists(companyId, employmentId, type.id)) {
      throw new ProblemException(409, 'document-request-pending', 'You already have a pending request for this document.');
    }
    const definitionId = await this.repo.definitionId(companyId, DOCUMENT_WORKFLOW_CODE);
    if (!definitionId) throw new Error(`workflow definition ${DOCUMENT_WORKFLOW_CODE} missing`);
    let id: string;
    try {
      id = await this.repo.insertRequest(companyId, { employmentId, documentTypeId: type.id, language: input.language, purpose: input.purpose, requestedBy: userId });
    } catch (error) {
      if (pgError(error)?.constraint === 'document_request_one_pending_uk') {
        throw new ProblemException(409, 'document-request-pending', 'You already have a pending request for this document.');
      }
      throw error;
    }
    const instanceId = await this.engine.start({ definitionId, subjectType: 'document_request', subjectId: id, scopeUnitId: employee.unitId, subjectUserId: userId });
    await this.repo.setRequestInstance(companyId, id, instanceId);
    return this.requestView(companyId, id);
  }

  async cancel(id: string): Promise<DocumentRequestView> {
    const { companyId } = caller();
    const employmentId = await this.ownEmployment();
    const request = await this.repo.request(companyId, id);
    if (!request || request.employmentId !== employmentId) throw requestNotFound();
    if (request.status !== 'pending' || !request.workflowInstanceId) {
      throw new ProblemException(409, 'document-request-not-cancellable', 'Only a pending request can be cancelled.');
    }
    await this.engine.cancel(request.workflowInstanceId);
    return this.requestView(companyId, id);
  }

  /** GET /me/documents/:id/pdf: own ISSUED document only (void ones and anybody else's → 404); audited. */
  async pdf(id: string, disposition: 'attachment' | 'inline'): Promise<PdfFile> {
    const { companyId } = caller();
    const employmentId = await this.ownEmployment();
    const row = await this.repo.document(companyId, id);
    if (!row || row.employmentId !== employmentId || row.status !== 'issued') throw new NotFoundException('Document not found');
    const bytes = await this.repo.file(companyId, id);
    if (!bytes) throw new NotFoundException('Document not found');
    await this.audit.record({ type: 'document.downloaded', subject: { type: 'issued_document', id }, data: { number: row.number, disposition, via: 'self' } });
    return { bytes, number: row.number, sha256: row.sha256, status: row.status };
  }

  // ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private async requestView(companyId: string, id: string): Promise<DocumentRequestView> {
    const row = await this.repo.request(companyId, id);
    if (!row) throw requestNotFound();
    const [view] = await this.requestViews(companyId, [row]);
    if (!view) throw requestNotFound();
    return view;
  }

  private async requestViews(companyId: string, rows: readonly RequestRow[]): Promise<DocumentRequestView[]> {
    if (rows.length === 0) return [];
    const instanceIds = rows.flatMap((r) => (r.workflowInstanceId ? [r.workflowInstanceId] : []));
    const [types, progress, history] = await Promise.all([this.repo.types(companyId), this.engine.progress(instanceIds), this.engine.history(instanceIds)]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const progressById = new Map(progress.map((p) => [p.instanceId, p]));
    return rows.map((r) => {
      const type = typeById.get(r.documentTypeId);
      const rejection = r.workflowInstanceId ? (history.get(r.workflowInstanceId) ?? []).find((t) => t.outcome === 'reject') : undefined;
      return {
        id: r.id,
        type: { code: r.typeCode, labels: type ? labelsOf(type) : { fr: r.typeCode, ar: r.typeCode, en: r.typeCode } },
        language: r.language,
        purpose: r.purpose,
        status: r.status,
        requestedAt: r.requestedAt,
        workflow: r.workflowInstanceId ? (progressById.get(r.workflowInstanceId) ?? null) : null,
        document: r.issuedDocumentId && r.issuedNumber ? { id: r.issuedDocumentId, number: r.issuedNumber } : null,
        rejectionComment: rejection?.comment ?? null,
        _actions: r.status === 'pending' ? ['cancel'] : [],
      };
    });
  }

  // ── workflow hooks (inside the approval / rejection / cancellation transaction) ────────────────────────────────

  /** Approved: issue the document now (any issuing error fails — and rolls back — the approval with its slug). */
  private async onApproved(context: HookContext): Promise<void> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, context.subjectId);
    if (!request) throw requestNotFound();
    let documentId: string;
    try {
      const prepared = await this.issuer.prepare(companyId, {
        typeCode: request.typeCode,
        employmentId: request.employmentId,
        leaveRequestId: null,
        language: request.language,
        issueDate: this.clock.today(),
      });
      documentId = await this.issuer.issue(companyId, prepared, { issuedBy: context.actorUserId, via: 'self_service', documentRequestId: request.id, clientRequestId: null });
    } catch (error) {
      throw documentProblem(error);
    }
    await this.repo.setRequestStatus(companyId, request.id, 'approved', documentId);
    const employeeUser = (await this.staffing.linkedUsersOf([request.employmentId])).get(request.employmentId) ?? null;
    const document = await this.repo.document(companyId, documentId);
    await this.notifier.notify({
      type: 'document.ready',
      subject: { type: 'issued_document', id: documentId },
      data: { ...(await this.notificationData(request.id)), documentId, number: document?.number ?? null, actorName: (await this.engine.displayName(context.actorUserId)) || null },
      recipients: [{ userId: employeeUser, audience: 'employee' }],
    });
  }

  private async onRejected(context: HookContext): Promise<void> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, context.subjectId);
    if (!request) throw requestNotFound();
    await this.repo.setRequestStatus(companyId, request.id, 'rejected');
    const employeeUser = (await this.staffing.linkedUsersOf([request.employmentId])).get(request.employmentId) ?? null;
    await this.notifier.notify({
      type: 'document.rejected',
      subject: { type: 'document_request', id: request.id },
      data: { ...(await this.notificationData(request.id)), actorName: (await this.engine.displayName(context.actorUserId)) || null },
      recipients: [{ userId: employeeUser, audience: 'employee' }],
    });
  }

  private async onCancelled(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.setRequestStatus(companyId, context.subjectId, 'cancelled');
  }

  /** "My tasks" summaries: {type, employee, documentType, language, purpose, requestedAt}. */
  private async summaries(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const { companyId } = caller();
    const rows = await this.repo.requests(companyId, ids);
    const [cards, types] = await Promise.all([this.staffing.cards(rows.map((r) => r.employmentId)), this.repo.types(companyId)]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const card = cards.get(r.employmentId);
      const type = typeById.get(r.documentTypeId);
      out.set(r.id, {
        type: 'document_request',
        employee: card ? { id: card.id, matricule: card.matricule, person: card.person, unit: card.unit } : null,
        documentType: { code: r.typeCode, labels: type ? labelsOf(type) : { fr: r.typeCode, ar: r.typeCode, en: r.typeCode } },
        language: r.language,
        purpose: r.purpose,
        requestedAt: r.requestedAt,
      });
    }
    return out;
  }

  /** Names, type code and language — never the purpose. */
  private async notificationData(requestId: string): Promise<NotificationData> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, requestId);
    if (!request) return { requestId };
    const card = (await this.staffing.cards([request.employmentId])).get(request.employmentId);
    const person = card?.person;
    return {
      requestId,
      employeeName: person ? `${person.firstName} ${person.lastName}` : null,
      employeeNameAr: person?.firstNameAr && person.lastNameAr ? `${person.firstNameAr} ${person.lastNameAr}` : null,
      documentType: request.typeCode,
      language: request.language,
    };
  }
}
