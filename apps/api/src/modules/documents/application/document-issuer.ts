import { createHash } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { readImageHeader, withinImageLimits } from '../../../platform/pdf/image-header.js';
import { PdfRenderError, PdfRenderer } from '../../../platform/pdf/pdf-renderer.js';
import { LeaveFacts, type LeaveRequestFacts } from '../../leave/index.js';
import { formatNumber, specimenNumber } from '../domain/numbering.js';
import { checkEmploymentOf, checkLanguage, chooseSignatory } from '../domain/rules.js';
import { buildSnapshot, missingProfileFields, type DocumentSnapshot, type EmployeeFacts, type LeaveSnapshotFacts, type ProfileFacts, type SnapshotInput } from '../domain/snapshot.js';
import { checkFieldValues, formatFieldValues } from '../domain/template-fields.js';
import { hasPositions, layoutKeys, LAYOUT_LIMITS, type TemplateLayout } from '../domain/template-layout.js';
import { resolveLayout } from '../domain/template-resolve.js';
import { pickValues, variableValues } from '../domain/template-variables.js';
import {
  DESIGNED_TEMPLATE,
  designedTemplateVersion,
  DocumentRuleViolation,
  isDocumentTypeCode,
  TEMPLATE_VERSIONS,
  type DocumentLanguage,
  type DocumentTypeCode,
} from '../domain/types.js';
import { DocumentsRepository, pgError, type EmployeeRow, type LogoRow, type SignatoryRow, type TypeRow } from '../infra/documents.repository.js';
import { TemplatesRepository, type TemplateVersionRow } from '../infra/templates.repository.js';

/** What to issue, after the caller's access was checked. */
export interface IssueSpec {
  typeCode: DocumentTypeCode;
  employmentId: string;
  leaveRequestId: string | null;
  language: DocumentLanguage;
  signatoryId?: string | undefined;
  issueDate: string;
  /** values of the designed template's fields, as typed (document-templates.md › Issuing) */
  fields?: Record<string, string> | undefined;
}

/** A preview of a template version that is not (or not yet) the published one: the designer's preview. */
export interface PrepareOptions {
  template?: TemplateVersionRow;
}

/** The designed template a document renders, and the layout of its language. */
export interface DesignedTemplate {
  version: TemplateVersionRow;
  layout: TemplateLayout;
}

/** Everything checked and formatted: what a preview renders and an issue numbers. */
export interface PreparedDocument {
  type: TypeRow;
  employee: Pick<EmployeeRow, 'employmentId' | 'unitId'>;
  signatory: Pick<SignatoryRow, 'id'>;
  leave: LeaveRequestFacts | null;
  snapshot: DocumentSnapshot;
  logo: { path: string; bytes: Buffer } | null;
  /** null: the built-in template of a system type */
  template: DesignedTemplate | null;
  /** the facts some placeholders need besides the snapshot (designed templates) */
  sources: { profile: Pick<ProfileFacts, 'nif' | 'nis' | 'rc' | 'ai'>; employee: Pick<EmployeeFacts, 'firstName' | 'lastName' | 'firstNameAr' | 'lastNameAr'> };
}

export interface IssueContext {
  issuedBy: string;
  via: 'hr' | 'self_service';
  documentRequestId: string | null;
  clientRequestId: string | null;
}

/** The marker `designed.typ` panics with when a document runs past the page cap. */
const TOO_LONG = 'document-template-too-long';

/** Rule violations and database / renderer failures → problem+json. */
export function documentProblem(error: unknown): unknown {
  if (error instanceof DocumentRuleViolation) return new ProblemException(error.status, error.slug, error.message, error.errors);
  if (error instanceof PdfRenderError) {
    if (error.reason === 'error' && error.message.includes(TOO_LONG)) {
      return new ProblemException(422, TOO_LONG, `The document would be longer than ${LAYOUT_LIMITS.pages} pages: shorten the template.`);
    }
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

/** The designed layout of `lang` in a version, or 409 document-template-missing. */
export function layoutOf(version: TemplateVersionRow, lang: DocumentLanguage): TemplateLayout {
  const layout = version.layouts[lang];
  if (!layout) throw new DocumentRuleViolation('document-template-missing', `The template of this document type has no ${lang === 'ar' ? 'Arabic' : 'French'} layout yet.`);
  return layout;
}

/** The snapshot facts of a leave request. */
export function leaveSnapshotFacts(leave: LeaveRequestFacts): LeaveSnapshotFacts {
  return {
    requestId: leave.id,
    typeLabels: leave.type.labels,
    startDate: leave.startDate,
    endDate: leave.endDate,
    days: leave.days,
    halfDayStart: leave.halfDayStart,
    halfDayEnd: leave.halfDayEnd,
    resumption: leave.resumption,
  };
}

/**
 * The issuing core (ADR 008 › Decision 4 and 6): prepare (every check, the snapshot — no lock yet), then allocate the
 * number (row lock held until commit), render, store the register row + the PDF, record `document.issued`. Any failure
 * after the allocation rolls the whole request transaction back, the counter included: a number exists only if its
 * register row and its PDF exist. The caller checks access first (HR scope, or the workflow engine for self-service).
 * A type renders its built-in template (system types, `template_mode = builtin`) or its published designed version
 * (document-templates.md › Rendering).
 */
@Injectable()
export class DocumentIssuer {
  private readonly logger = new Logger('DocumentIssuer');

  constructor(
    private readonly repo: DocumentsRepository,
    private readonly renderer: PdfRenderer,
    private readonly audit: AuditEvents,
    private readonly leaves: LeaveFacts,
    private readonly templates: TemplatesRepository,
  ) {}

  /** The designed template a type issues with (its published version), or null for a built-in one. */
  private async templateOf(companyId: string, type: TypeRow, options: PrepareOptions): Promise<TemplateVersionRow | null> {
    if (options.template) return options.template;
    if (type.templateMode === 'builtin' && type.kind === 'system') return null;
    const version = type.publishedTemplateId ? (await this.templates.published(companyId, [type.publishedTemplateId])).get(type.publishedTemplateId) : undefined;
    if (!version) throw new DocumentRuleViolation('document-template-missing', 'This document type has no published template yet.');
    return version;
  }

  async prepare(companyId: string, spec: IssueSpec, options: PrepareOptions = {}): Promise<PreparedDocument> {
    const type = await this.repo.typeByCode(companyId, spec.typeCode);
    if (!type) throw new NotFoundException('Document type not found');
    // the designer previews drafts of types not active yet
    if (!type.active && !options.template) throw new DocumentRuleViolation('document-type-inactive', 'This document type is not active.');
    checkLanguage(type.languages, spec.language);
    const version = await this.templateOf(companyId, type, options);
    const layout = version ? layoutOf(version, spec.language) : null;

    // the fields typed at issue time: only a designed template has them
    let fieldValues: Record<string, string> = {};
    if (version) {
      const checked = checkFieldValues(version.fields, spec.fields);
      if (checked.errors.length) throw new DocumentRuleViolation('validation-error', 'Some fields of the document are missing or invalid.', 422, checked.errors);
      fieldValues = checked.values;
    } else if (spec.fields && Object.keys(spec.fields).length > 0) {
      throw new DocumentRuleViolation(
        'validation-error',
        'This document has no fields to fill in.',
        422,
        Object.keys(spec.fields).map((key) => ({ field: `fields.${key}`, code: 'unknown_field', message: 'This template has no such field.' })),
      );
    }

    let leave: LeaveRequestFacts | null = null;
    if (type.subject === 'leave_request') {
      leave = (spec.leaveRequestId ? await this.leaves.request(companyId, spec.leaveRequestId) : undefined) ?? null;
      if (!leave || leave.employmentId !== spec.employmentId) throw new NotFoundException('Leave request not found');
      if (leave.status !== 'approved') {
        throw new DocumentRuleViolation('document-leave-not-approved', 'This document is issued for an approved leave request only.');
      }
    }
    const employee = await this.repo.employee(companyId, spec.employmentId, spec.issueDate);
    if (!employee) throw new NotFoundException('Employee not found');
    checkEmploymentOf(type, employee, spec.issueDate);

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
    const input: SnapshotInput = {
      type: spec.typeCode,
      lang: spec.language,
      issueDate: spec.issueDate,
      profile: { ...profile, hasLogo: logo !== null },
      employee,
      signatory,
      ...(layout && hasPositions(layout) ? { positions: true } : {}),
      ...(leave ? { leave: leaveSnapshotFacts(leave) } : {}),
    };
    return this.prepared({ type, employee, signatory, leave, logo, input, profile, version, layout, fieldValues });
  }

  /** The snapshot of a prepared document (also the designer's sample preview, with fictitious facts). */
  prepared(p: {
    type: TypeRow;
    employee: EmployeeFacts & { unitId: string };
    signatory: Pick<SignatoryRow, 'id'>;
    leave: LeaveRequestFacts | null;
    logo: { path: string; bytes: Buffer } | null;
    input: SnapshotInput;
    profile: ProfileFacts;
    version: TemplateVersionRow | null;
    layout: TemplateLayout | null;
    fieldValues: Record<string, string>;
  }): PreparedDocument {
    const snapshot = buildSnapshot(p.input);
    if (p.version && p.layout) {
      snapshot.v = 2;
      snapshot.fieldValues = p.fieldValues;
      snapshot.fields = formatFieldValues(p.version.fields, p.fieldValues, p.input.lang);
    }
    return {
      type: p.type,
      employee: { employmentId: p.employee.employmentId, unitId: p.employee.unitId },
      signatory: { id: p.signatory.id },
      leave: p.leave,
      snapshot,
      logo: p.logo,
      template: p.version && p.layout ? { version: p.version, layout: p.layout } : null,
      sources: {
        profile: { nif: p.profile.nif, nis: p.profile.nis, rc: p.profile.rc, ai: p.profile.ai },
        employee: { firstName: p.employee.firstName, lastName: p.employee.lastName, firstNameAr: p.employee.firstNameAr, lastNameAr: p.employee.lastNameAr },
      },
    };
  }

  /**
   * The stored logo as a render asset, or null. Its header is checked again before Typst sees it (upload checks it
   * too): a logo stored before the pixel limits existed, or written around the API, could make Typst allocate
   * gigabytes, and an out-of-memory there aborts the whole API. Such a logo is left out of the document (the snapshot
   * then says `hasLogo: false`, which is what was printed) and a warning is logged; the document is still issued.
   */
  renderableLogo(companyId: string, row: LogoRow | undefined): { path: string; bytes: Buffer } | null {
    if (!row) return null;
    const header = readImageHeader(row.bytes);
    if (!header.ok || !withinImageLimits(header)) {
      const why = header.ok ? `${header.width} × ${header.height} px, over the limits` : `unreadable header (${header.reason})`;
      this.logger.warn(`company ${companyId}: letterhead logo left out of the document: ${why}; upload a smaller logo in the document settings`);
      return null;
    }
    return { path: `/__assets/logo-${row.sha256.toString('hex')}.${header.type === 'image/png' ? 'png' : 'jpg'}`, bytes: row.bytes };
  }

  /** The snapshot with its number and, for a designed template, the variables exactly as printed. */
  private numbered(prepared: PreparedDocument, number: string): DocumentSnapshot {
    const snapshot: DocumentSnapshot = { ...prepared.snapshot, number };
    if (prepared.template) {
      const values = variableValues({ snapshot, ...prepared.sources });
      snapshot.vars = pickValues(values, layoutKeys(prepared.template.layout));
    }
    return snapshot;
  }

  private async render(prepared: PreparedDocument, snapshot: DocumentSnapshot, specimen: boolean): Promise<Buffer> {
    const options = { specimen, logo: prepared.logo?.path ?? null };
    const assets = prepared.logo ? [prepared.logo] : [];
    if (!prepared.template) {
      return this.renderer.render({ template: prepared.type.code, data: snapshot, options, assets, standard: 'a-2b' });
    }
    const values = variableValues({ snapshot, ...prepared.sources });
    const layout = resolveLayout(prepared.template.layout, {
      lang: snapshot.lang,
      values,
      sex: snapshot.employee.sex,
      jobTitle: snapshot.employee.jobTitle,
      positions: snapshot.employee.positions ?? [],
    });
    const title = snapshot.lang === 'ar' ? prepared.type.nameAr : prepared.type.nameFr;
    return this.renderer.render({ template: DESIGNED_TEMPLATE, data: snapshot, options: { ...options, title }, layout, assets, standard: 'a-2b' });
  }

  /** The preview: same rendering, number `<prefix>-…`, a SPÉCIMEN watermark; no counter, no row, no audit. */
  async preview(prepared: PreparedDocument): Promise<Buffer> {
    const year = Number(prepared.snapshot.issueDate.slice(0, 4));
    return this.render(prepared, this.numbered(prepared, specimenNumber(prepared.type.numberFormat, year)), true);
  }

  /** Allocates the number, renders, stores; returns the new document id. */
  async issue(companyId: string, prepared: PreparedDocument, context: IssueContext): Promise<string> {
    const year = Number(prepared.snapshot.issueDate.slice(0, 4));
    const seq = await this.repo.allocate(companyId, prepared.type.id, year);
    const number = formatNumber(prepared.type.numberFormat, year, seq);
    const snapshot = this.numbered(prepared, number);
    const pdf = await this.render(prepared, snapshot, false);
    const sha256 = createHash('sha256').update(pdf).digest();
    const code = prepared.type.code;
    const templateVersion = prepared.template
      ? designedTemplateVersion(code, prepared.template.version.version)
      : isDocumentTypeCode(code)
        ? TEMPLATE_VERSIONS[code]
        : code;
    const id = await this.repo.insertDocument(
      companyId,
      {
        documentTypeId: prepared.type.id,
        typeCode: code,
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
        templateVersion,
        templateVersionId: prepared.template?.version.id ?? null,
        subject: prepared.type.subject,
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
        typeCode: code,
        language: snapshot.lang,
        employmentId: prepared.employee.employmentId,
        sha256: sha256.toString('hex'),
        via: context.via,
      },
    });
    return id;
  }
}
