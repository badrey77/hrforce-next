import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { LeaveFacts } from '../../leave/index.js';
import { formatNumber } from '../domain/numbering.js';
import { coveringSignatories, nextSeq } from '../domain/rules.js';
import { DOCUMENT_PERMISSIONS as P, type DocumentLanguage, type DocumentTypeCode } from '../domain/types.js';
import { DocumentsRepository, type DocumentRow } from '../infra/documents.repository.js';
import { DocumentIssuer, documentProblems, type IssueSpec } from './document-issuer.js';
import { DocumentPresenter, labelsOf, signatoryView } from './document-presenter.js';
import type { DocumentTypeView, IssuedDocumentDetail, IssuedDocumentPage, IssuedDocumentView, PdfFile, SignatoryView } from './document-views.js';
import { DocumentsClock } from './documents-clock.js';

export interface IssueInput {
  typeCode: DocumentTypeCode;
  employmentId?: string | undefined;
  leaveRequestId?: string | undefined;
  language: DocumentLanguage;
  signatoryId?: string | undefined;
  clientRequestId?: string | undefined;
}

export interface RegisterInput {
  typeCode?: DocumentTypeCode | undefined;
  status?: 'issued' | 'void' | undefined;
  employmentId?: string | undefined;
  leaveRequestId?: string | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

export function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

const documentNotFound = () => new NotFoundException('Document not found');

/**
 * HR side of documents (docs/contracts/documents.md › Endpoints /documents*): reference data, signatories for the
 * issue form, preview, issuing (gap-free numbers, clientRequestId replay), the register, detail, PDF download, void.
 * Scope: the EMPLOYEE's scope unit today (evaluated at read time); out of scope → 404; readable but outside the
 * action's permission → 403 forbidden-scope.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly issuer: DocumentIssuer,
    private readonly presenter: DocumentPresenter,
    private readonly scopes: ScopeService,
    private readonly clock: DocumentsClock,
    private readonly audit: AuditEvents,
    private readonly leaves: LeaveFacts,
  ) {}

  private async holds(code: string): Promise<boolean> {
    return (await this.scopes.unitIds(code)).size > 0;
  }

  /** The employee's scope unit when `permission` covers it; 403 when only document.read does; else 404. */
  private async unitFor(companyId: string, employmentId: string, permission: string, notFound: () => Error): Promise<string> {
    const unitId = await this.repo.scopeUnit(companyId, employmentId, this.clock.today());
    if (!unitId) throw notFound();
    if (await this.scopes.inScope(permission, unitId)) return unitId;
    if (permission !== P.read && (await this.scopes.inScope(P.read, unitId))) {
      throw new ProblemException(403, 'forbidden-scope', `You cannot do this for this employee (outside your ${permission} scope).`);
    }
    throw notFound();
  }

  // ── reference data ──────────────────────────────────────────────────────────────────────────────────────────────

  async types(): Promise<{ items: DocumentTypeView[] }> {
    const { companyId } = caller();
    const types = await this.repo.types(companyId);
    const privileged = (await this.holds(P.issue)) || (await this.holds(P.configure));
    const year = Number(this.clock.today().slice(0, 4));
    const last = privileged ? await this.repo.lastValues(companyId, year) : new Map<string, number>();
    return {
      items: types.map((t) => ({
        id: t.id,
        code: t.code,
        labels: labelsOf(t),
        languages: t.languages,
        selfService: t.selfService,
        active: t.active,
        sortOrder: t.sortOrder,
        numberFormat: privileged ? t.numberFormat : null,
        nextNumber: privileged ? formatNumber(t.numberFormat, year, nextSeq(last.get(t.id) ?? null)) : null,
        defaultSignatoryId: privileged ? t.defaultSignatoryId : null,
      })),
    };
  }

  /** GET /documents/signatories?employmentId=: active signatories covering that employee, nearest first (all active without). */
  async signatoriesFor(employmentId: string | undefined): Promise<{ items: SignatoryView[] }> {
    const { companyId } = caller();
    const today = this.clock.today();
    const [all, types] = await Promise.all([this.repo.signatories(companyId, today), this.repo.types(companyId)]);
    let items = all.filter((s) => s.active);
    if (employmentId) {
      const unitId = await this.unitFor(companyId, employmentId, P.issue, () => new NotFoundException('Employee not found'));
      items = coveringSignatories(items, await this.repo.ancestorsOf(companyId, unitId));
    }
    return { items: items.map((s) => signatoryView(s, types)) };
  }

  // ── issuing ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Access check + the issue spec (employee from the body or from the leave request). */
  private async spec(companyId: string, input: IssueInput): Promise<IssueSpec> {
    const titre = input.typeCode === 'titre_conge';
    if (titre ? !input.leaveRequestId || input.employmentId : !input.employmentId || input.leaveRequestId) {
      const field = titre ? (input.leaveRequestId ? 'employmentId' : 'leaveRequestId') : input.employmentId ? 'leaveRequestId' : 'employmentId';
      const code = (titre && field === 'leaveRequestId') || (!titre && field === 'employmentId') ? 'required' : 'not_allowed';
      throw new ValidationProblemException([{ field, code, message: titre ? 'A titre de congé is issued from leaveRequestId.' : 'This document is issued for employmentId.' }]);
    }
    let employmentId = input.employmentId ?? '';
    if (titre) {
      const leave = await this.leaves.request(companyId, input.leaveRequestId ?? '');
      if (!leave) throw new NotFoundException('Leave request not found');
      employmentId = leave.employmentId;
    }
    await this.unitFor(companyId, employmentId, P.issue, () => new NotFoundException(titre ? 'Leave request not found' : 'Employee not found'));
    return {
      typeCode: input.typeCode,
      employmentId,
      leaveRequestId: input.leaveRequestId ?? null,
      language: input.language,
      signatoryId: input.signatoryId,
      issueDate: this.clock.today(),
    };
  }

  async preview(input: IssueInput): Promise<Buffer> {
    const { companyId } = caller();
    const spec = await this.spec(companyId, input);
    return documentProblems(async () => this.issuer.preview(await this.issuer.prepare(companyId, spec)));
  }

  /** POST /documents → the new document (created) or, for a replayed clientRequestId, the one already issued. */
  async issue(input: IssueInput): Promise<{ created: boolean; view: IssuedDocumentView }> {
    const { companyId, userId } = caller();
    const spec = await this.spec(companyId, input);
    if (input.clientRequestId) {
      await this.repo.lockClientRequest(companyId, input.clientRequestId);
      const existing = await this.repo.documentByClientRequest(companyId, input.clientRequestId);
      if (existing) {
        const same =
          existing.typeCode === spec.typeCode &&
          existing.employmentId === spec.employmentId &&
          existing.leaveRequestId === spec.leaveRequestId &&
          existing.language === spec.language &&
          (!spec.signatoryId || existing.signatoryId === spec.signatoryId);
        if (!same) throw new ProblemException(409, 'document-client-request-reused', 'This clientRequestId was already used for another document.');
        return { created: false, view: await this.view(companyId, existing) };
      }
    }
    const id = await documentProblems(async () => {
      const prepared = await this.issuer.prepare(companyId, spec);
      return this.issuer.issue(companyId, prepared, { issuedBy: userId, via: 'hr', documentRequestId: null, clientRequestId: input.clientRequestId ?? null });
    });
    const row = await this.repo.document(companyId, id);
    if (!row) throw documentNotFound();
    return { created: true, view: await this.view(companyId, row) };
  }

  // ── register ────────────────────────────────────────────────────────────────────────────────────────────────────

  async register(input: RegisterInput): Promise<IssuedDocumentPage> {
    const { companyId } = caller();
    const { rows, total } = await this.repo.register(companyId, {
      scope: await this.scopes.scopeOf(P.read),
      today: this.clock.today(),
      typeCode: input.typeCode,
      status: input.status,
      employmentId: input.employmentId,
      leaveRequestId: input.leaveRequestId,
      unitId: input.unitId,
      includeSubUnits: input.includeSubUnits,
      from: input.from,
      to: input.to,
      q: input.q,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return { items: await this.presenter.views(companyId, rows), total, page: input.page, pageSize: input.pageSize };
  }

  /** A document the caller may read (document.read over the employee's scope unit today), else 404. */
  private async readable(companyId: string, id: string, permission: string = P.read): Promise<DocumentRow> {
    const row = await this.repo.document(companyId, id);
    if (!row) throw documentNotFound();
    await this.unitFor(companyId, row.employmentId, permission, documentNotFound);
    return row;
  }

  private async view(companyId: string, row: DocumentRow): Promise<IssuedDocumentView> {
    const [view] = await this.presenter.views(companyId, [row]);
    if (!view) throw documentNotFound();
    return view;
  }

  async get(id: string): Promise<IssuedDocumentDetail> {
    const { companyId } = caller();
    const row = await this.readable(companyId, id);
    const snapshot = await this.repo.snapshot(companyId, id);
    if (!snapshot) throw documentNotFound();
    return { ...(await this.view(companyId, row)), snapshot };
  }

  /** GET /documents/:id/pdf: the stored bytes (also of a void document: it is the record); audited. */
  async pdf(id: string, disposition: 'attachment' | 'inline'): Promise<PdfFile> {
    const { companyId } = caller();
    const row = await this.readable(companyId, id);
    const bytes = await this.repo.file(companyId, id);
    if (!bytes) throw documentNotFound();
    await this.audit.record({ type: 'document.downloaded', subject: { type: 'issued_document', id }, data: { number: row.number, disposition, via: 'hr' } });
    return { bytes, number: row.number, sha256: row.sha256, status: row.status };
  }

  /** POST /documents/:id/void: keeps the number and the file; 409 document-already-void. */
  async void(id: string, reason: string): Promise<IssuedDocumentView> {
    const { companyId, userId } = caller();
    // 404 outside document.read, 403 forbidden-scope when readable but outside document.void
    const row = await this.readable(companyId, id, P.void);
    if (row.status === 'void' || !(await this.repo.voidDocument(companyId, id, userId, reason))) {
      throw new ProblemException(409, 'document-already-void', 'This document is already void.');
    }
    await this.audit.record({ type: 'document.voided', subject: { type: 'issued_document', id }, data: { number: row.number, reason } });
    const updated = await this.repo.document(companyId, id);
    if (!updated) throw documentNotFound();
    return this.view(companyId, updated);
  }
}
