import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { readImageHeader, withinImageLimits } from '../../../platform/pdf/image-header.js';
import { PdfRenderError, PdfRenderer } from '../../../platform/pdf/pdf-renderer.js';
import { LeaveFacts, type LeaveRequestFacts } from '../../leave/index.js';
import { formatNumber, specimenNumber } from '../domain/numbering.js';
import { checkEmploymentFor, checkLanguage, chooseSignatory } from '../domain/rules.js';
import { buildSnapshot, missingProfileFields, type DocumentSnapshot } from '../domain/snapshot.js';
import { DocumentRuleViolation, TEMPLATE_VERSIONS, type DocumentLanguage, type DocumentTypeCode } from '../domain/types.js';
import { DocumentsRepository, pgError, type EmployeeRow, type LogoRow, type SignatoryRow, type TypeRow } from '../infra/documents.repository.js';

/** What to issue, after the caller's access was checked. */
export interface IssueSpec {
  typeCode: DocumentTypeCode;
  employmentId: string;
  leaveRequestId: string | null;
  language: DocumentLanguage;
  signatoryId?: string | undefined;
  issueDate: string;
}

/** Everything checked and formatted: what a preview renders and an issue numbers. */
export interface PreparedDocument {
  type: TypeRow;
  employee: EmployeeRow;
  signatory: SignatoryRow;
  leave: LeaveRequestFacts | null;
  snapshot: DocumentSnapshot;
  logo: { path: string; bytes: Buffer } | null;
}

export interface IssueContext {
  issuedBy: string;
  via: 'hr' | 'self_service';
  documentRequestId: string | null;
  clientRequestId: string | null;
}

/** Rule violations and database / renderer failures → problem+json. */
export function documentProblem(error: unknown): unknown {
  if (error instanceof DocumentRuleViolation) return new ProblemException(error.status, error.slug, error.message, error.errors);
  if (error instanceof PdfRenderError) {
    return new ProblemException(503, 'document-render-failed', 'The document could not be rendered; nothing was issued. Try again.', undefined, {
      headers: { 'Retry-After': '5' },
    });
  }
  const pg = pgError(error);
  if (pg?.code === '55P03') {
    return new ProblemException(503, 'document-busy', 'Another document of this type is being issued; try again.', undefined, { headers: { 'Retry-After': '2' } });
  }
  if (pg?.code === '23505' && pg.constraint === 'issued_document_number_uk') {
    return new ProblemException(409, 'document-number-taken', 'This number already exists (two number formats produce the same numbers); change the format.', [
      { field: 'numberFormat', code: 'number_taken', message: 'The format produces a number that is already used.' },
    ]);
  }
  return error;
}

export async function documentProblems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw documentProblem(error);
  }
}

/**
 * The issuing core (ADR 008 › Decision 4 and 6): prepare (every check, the snapshot — no lock yet), then allocate the
 * number (row lock held until commit), render, store the register row + the PDF, record `document.issued`. Any failure
 * after the allocation rolls the whole request transaction back, the counter included: a number exists only if its
 * register row and its PDF exist. The caller checks access first (HR scope, or the workflow engine for self-service).
 */
@Injectable()
export class DocumentIssuer {
  private readonly logger = new Logger('DocumentIssuer');

  constructor(
    private readonly repo: DocumentsRepository,
    private readonly renderer: PdfRenderer,
    private readonly audit: AuditEvents,
    private readonly leaves: LeaveFacts,
  ) {}

  async prepare(companyId: string, spec: IssueSpec): Promise<PreparedDocument> {
    const type = await this.repo.typeByCode(companyId, spec.typeCode);
    if (!type) throw new NotFoundException('Document type not found');
    if (!type.active) throw new DocumentRuleViolation('document-type-inactive', 'This document type is not active.');
    checkLanguage(type.languages, spec.language);

    let leave: LeaveRequestFacts | null = null;
    if (spec.typeCode === 'titre_conge') {
      leave = (spec.leaveRequestId ? await this.leaves.request(companyId, spec.leaveRequestId) : undefined) ?? null;
      if (!leave || leave.employmentId !== spec.employmentId) throw new NotFoundException('Leave request not found');
      if (leave.status !== 'approved') throw new DocumentRuleViolation('document-leave-not-approved', 'A titre de congé is issued for an approved leave request only.');
    }
    const employee = await this.repo.employee(companyId, spec.employmentId, spec.issueDate);
    if (!employee) throw new NotFoundException('Employee not found');
    checkEmploymentFor(spec.typeCode, employee, spec.issueDate);

    const profile = await this.repo.profile(companyId);
    const missing = missingProfileFields(profile ?? null, spec.language);
    if (!profile || missing.length > 0) {
      throw new DocumentRuleViolation(
        'document-profile-incomplete',
        'The company letterhead is incomplete for this language: complete it in the document settings.',
        409,
        missing.map((field) => ({ field, code: 'required', message: 'Required on the letterhead of this language.' })),
      );
    }
    const signatory = chooseSignatory(
      await this.repo.signatories(companyId, spec.issueDate),
      await this.repo.ancestorsOf(companyId, employee.unitId),
      spec.signatoryId,
      type.defaultSignatoryId,
    );
    const logo = this.renderableLogo(companyId, profile.hasLogo ? await this.repo.logo(companyId) : undefined);
    const snapshot = buildSnapshot({
      type: spec.typeCode,
      lang: spec.language,
      issueDate: spec.issueDate,
      profile: { ...profile, hasLogo: logo !== null },
      employee,
      signatory,
      ...(leave
        ? {
            leave: {
              requestId: leave.id,
              typeLabels: leave.type.labels,
              startDate: leave.startDate,
              endDate: leave.endDate,
              days: leave.days,
              halfDayStart: leave.halfDayStart,
              halfDayEnd: leave.halfDayEnd,
              resumption: leave.resumption,
            },
          }
        : {}),
    });
    return { type, employee, signatory, leave, snapshot, logo };
  }

  /**
   * The stored logo as a render asset, or null. Its header is checked again before Typst sees it (upload checks it
   * too): a logo stored before the pixel limits existed, or written around the API, could make Typst allocate
   * gigabytes, and an out-of-memory there aborts the whole API. Such a logo is left out of the document (the snapshot
   * then says `hasLogo: false`, which is what was printed) and a warning is logged; the document is still issued.
   */
  private renderableLogo(companyId: string, row: LogoRow | undefined): { path: string; bytes: Buffer } | null {
    if (!row) return null;
    const header = readImageHeader(row.bytes);
    if (!header.ok || !withinImageLimits(header)) {
      const why = header.ok ? `${header.width} × ${header.height} px, over the limits` : `unreadable header (${header.reason})`;
      this.logger.warn(`company ${companyId}: letterhead logo left out of the document: ${why}; upload a smaller logo in the document settings`);
      return null;
    }
    return { path: `/__assets/logo-${row.sha256.toString('hex')}.${header.type === 'image/png' ? 'png' : 'jpg'}`, bytes: row.bytes };
  }

  private render(prepared: PreparedDocument, snapshot: DocumentSnapshot, specimen: boolean): Promise<Buffer> {
    return this.renderer.render({
      template: prepared.type.code,
      data: snapshot,
      options: { specimen, logo: prepared.logo?.path ?? null },
      assets: prepared.logo ? [prepared.logo] : [],
      standard: 'a-2b',
    });
  }

  /** The preview: same rendering, number `<prefix>-…`, a SPÉCIMEN watermark; no counter, no row, no audit. */
  async preview(prepared: PreparedDocument): Promise<Buffer> {
    const year = Number(prepared.snapshot.issueDate.slice(0, 4));
    return this.render(prepared, { ...prepared.snapshot, number: specimenNumber(prepared.type.numberFormat, year) }, true);
  }

  /** Allocates the number, renders, stores; returns the new document id. */
  async issue(companyId: string, prepared: PreparedDocument, context: IssueContext): Promise<string> {
    const year = Number(prepared.snapshot.issueDate.slice(0, 4));
    const seq = await this.repo.allocate(companyId, prepared.type.id, year);
    const number = formatNumber(prepared.type.numberFormat, year, seq);
    const snapshot: DocumentSnapshot = { ...prepared.snapshot, number };
    const pdf = await this.render(prepared, snapshot, false);
    const sha256 = createHash('sha256').update(pdf).digest();
    const id = await this.repo.insertDocument(
      companyId,
      {
        documentTypeId: prepared.type.id,
        typeCode: prepared.type.code,
        year,
        seq,
        number,
        language: snapshot.lang,
        employmentId: prepared.employee.employmentId,
        leaveRequestId: prepared.leave?.id ?? null,
        documentRequestId: context.documentRequestId,
        orgUnitId: prepared.employee.unitId,
        signatoryId: prepared.signatory.id,
        snapshot,
        templateVersion: TEMPLATE_VERSIONS[prepared.type.code],
        renderer: this.renderer.engine,
        sha256,
        sizeBytes: pdf.length,
        issueDate: snapshot.issueDate,
        issuedBy: context.issuedBy,
        clientRequestId: context.clientRequestId,
      },
      pdf,
    );
    await this.audit.record({
      type: 'document.issued',
      subject: { type: 'issued_document', id },
      data: {
        number,
        typeCode: prepared.type.code,
        language: snapshot.lang,
        employmentId: prepared.employee.employmentId,
        sha256: sha256.toString('hex'),
        via: context.via,
      },
    });
    return id;
  }
}
