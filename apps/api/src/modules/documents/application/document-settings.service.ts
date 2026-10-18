import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, readImageHeader, withinImageLimits } from '../../../platform/pdf/image-header.js';
import { isValidNumberFormat } from '../domain/numbering.js';
import { LOGO_MAX_BYTES } from '../domain/rules.js';
import { missingProfileFields } from '../domain/snapshot.js';
import { DOCUMENT_PERMISSIONS as P, isDocumentTypeCode, type DocumentLanguage, type DocumentSubject, type EmploymentRule } from '../domain/types.js';
import { DocumentsRepository, pgError, type LogoRow, type ProfileInput } from '../infra/documents.repository.js';
import { TemplatesRepository } from '../infra/templates.repository.js';
import { signatoryView } from './document-presenter.js';
import type { CompanyProfileView, DocumentTypeView, SignatoryView } from './document-views.js';
import { DocumentsClock } from './documents-clock.js';
import { caller, DocumentsService } from './documents.service.js';

export interface TypePatch {
  numberFormat?: string | undefined;
  languages?: DocumentLanguage[] | undefined;
  selfService?: boolean | undefined;
  defaultSignatoryId?: string | null | undefined;
  active?: boolean | undefined;
  /** custom types only */
  names?: { fr: string; ar: string; en: string } | undefined;
  /** custom employee documents only */
  employmentRule?: EmploymentRule | undefined;
}

export interface NewTypeInput {
  code: string;
  names: { fr: string; ar: string; en: string };
  subject: DocumentSubject;
  employmentRule?: EmploymentRule | undefined;
  numberFormat: string;
  languages: DocumentLanguage[];
  sortOrder?: number | undefined;
}

const INVALID_FORMAT = 'Literals A-Z 0-9 / _ . - and {YYYY} {YY} {SEQ} {SEQ:n}; one {SEQ}, a year token, at most 40 characters.';

/** Unique violations of document_type → 409 (format or code already used). */
function typeConflict(error: unknown): ProblemException | null {
  const constraint = pgError(error)?.constraint;
  if (constraint === 'document_type_company_format_uk') {
    return new ProblemException(409, 'document-format-taken', 'Another document type already uses this number format.', [
      { field: 'numberFormat', code: 'format_taken', message: 'Already used by another type.' },
    ]);
  }
  if (constraint === 'document_type_company_code_uk') {
    return new ProblemException(409, 'document-type-code-taken', 'Another document type already has this code.', [{ field: 'code', code: 'code_taken', message: 'Already used.' }]);
  }
  return null;
}

export interface SignatoryInput {
  orgUnitId?: string | null | undefined;
  names?: { fr: string; ar: string } | undefined;
  titles?: { fr: string; ar: string } | undefined;
  active?: boolean | undefined;
}

/**
 * Document settings (docs/contracts/documents.md › Endpoints /documents/settings*, PUT /documents/types/:id): the
 * letterhead (company_profile) and its logo, signatories, types (number format, languages, self-service, default
 * signatory, active). Reads need `document.configure` anywhere (the route guard); writes need it over the WHOLE
 * company (else 403 forbidden-scope, like PUT /access/security-policy). Every write is audited by the row triggers.
 */
@Injectable()
export class DocumentSettingsService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly scopes: ScopeService,
    private readonly clock: DocumentsClock,
    private readonly documents: DocumentsService,
    private readonly templates: TemplatesRepository,
  ) {}

  private async assertCompanyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'Document settings apply to the whole company: document.configure over the root unit is needed.');
    }
  }

  // ── profile ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async profile(): Promise<CompanyProfileView> {
    const { companyId } = caller();
    const p = await this.repo.profile(companyId);
    return {
      legalNameFr: p?.legalNameFr ?? null,
      legalNameAr: p?.legalNameAr ?? null,
      addressFr: p?.addressFr ?? null,
      addressAr: p?.addressAr ?? null,
      cityFr: p?.cityFr ?? null,
      cityAr: p?.cityAr ?? null,
      phone: p?.phone ?? null,
      email: p?.email ?? null,
      nif: p?.nif ?? null,
      nis: p?.nis ?? null,
      rc: p?.rc ?? null,
      ai: p?.ai ?? null,
      footerFr: p?.footerFr ?? null,
      footerAr: p?.footerAr ?? null,
      hasLogo: p?.hasLogo ?? false,
      complete: { fr: missingProfileFields(p ?? null, 'fr').length === 0, ar: missingProfileFields(p ?? null, 'ar').length === 0 },
    };
  }

  async saveProfile(input: ProfileInput): Promise<CompanyProfileView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    await this.repo.saveProfile(companyId, input);
    return this.profile();
  }

  async logo(): Promise<LogoRow> {
    const { companyId } = caller();
    const logo = await this.repo.logo(companyId);
    if (!logo) throw new NotFoundException('No logo');
    return logo;
  }

  async setLogo(file: { buffer: Buffer } | undefined): Promise<CompanyProfileView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    if (!file || file.buffer.length === 0) throw new ValidationProblemException([{ field: 'file', code: 'required', message: 'A PNG or JPEG file is required.' }]);
    if (file.buffer.length > LOGO_MAX_BYTES) throw new ValidationProblemException([{ field: 'file', code: 'too_large', message: 'At most 256 KB.' }]);
    // the type by the first bytes, the size by the header (never decoded here): Typst decodes the whole canvas at
    // every render, and an out-of-memory there aborts the API (platform/pdf/image-header.ts)
    const header = readImageHeader(file.buffer);
    if (!header.ok) throw new ValidationProblemException([{ field: 'file', code: 'unsupported_type', message: 'PNG or JPEG only (a readable header is needed).' }]);
    if (!withinImageLimits(header)) {
      throw new ValidationProblemException([
        { field: 'file', code: 'dimensions_too_large', message: `At most ${IMAGE_MAX_SIDE} × ${IMAGE_MAX_SIDE} px and ${IMAGE_MAX_PIXELS / 1_000_000} megapixels.` },
      ]);
    }
    const mime = header.type;
    await this.repo.setLogo(companyId, { bytes: file.buffer, mime, sha256: createHash('sha256').update(file.buffer).digest() });
    return this.profile();
  }

  async deleteLogo(): Promise<void> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    if (await this.repo.logo(companyId)) await this.repo.setLogo(companyId, null);
  }

  // ── signatories ─────────────────────────────────────────────────────────────────────────────────────────────────

  async signatories(): Promise<{ items: SignatoryView[] }> {
    const { companyId } = caller();
    const [rows, types] = await Promise.all([this.repo.signatories(companyId, this.clock.today()), this.repo.types(companyId)]);
    return { items: rows.map((s) => signatoryView(s, types)) };
  }

  private async signatoryView(companyId: string, id: string): Promise<SignatoryView> {
    const [rows, types] = await Promise.all([this.repo.signatories(companyId, this.clock.today()), this.repo.types(companyId)]);
    const row = rows.find((s) => s.id === id);
    if (!row) throw new NotFoundException('Signatory not found');
    return signatoryView(row, types);
  }

  private async assertUnit(companyId: string, orgUnitId: string | null | undefined): Promise<void> {
    if (orgUnitId && !(await this.repo.unitExists(companyId, orgUnitId))) {
      throw new ValidationProblemException([{ field: 'orgUnitId', code: 'not_found', message: 'The unit does not exist.' }]);
    }
  }

  async createSignatory(input: { orgUnitId: string | null; names: { fr: string; ar: string }; titles: { fr: string; ar: string } }): Promise<SignatoryView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    await this.assertUnit(companyId, input.orgUnitId);
    const id = await this.repo.insertSignatory(companyId, { orgUnitId: input.orgUnitId, nameFr: input.names.fr, nameAr: input.names.ar, titleFr: input.titles.fr, titleAr: input.titles.ar });
    return this.signatoryView(companyId, id);
  }

  async updateSignatory(id: string, input: SignatoryInput): Promise<SignatoryView> {
    const { companyId } = caller();
    const existing = (await this.repo.signatories(companyId, this.clock.today())).find((s) => s.id === id);
    if (!existing) throw new NotFoundException('Signatory not found');
    await this.assertCompanyWide();
    await this.assertUnit(companyId, input.orgUnitId);
    const patch: Record<string, unknown> = {};
    if (input.orgUnitId !== undefined) patch['org_unit_id'] = input.orgUnitId;
    if (input.names) Object.assign(patch, { name_fr: input.names.fr, name_ar: input.names.ar });
    if (input.titles) Object.assign(patch, { title_fr: input.titles.fr, title_ar: input.titles.ar });
    if (input.active !== undefined) patch['active'] = input.active;
    await this.repo.updateSignatory(companyId, id, patch);
    return this.signatoryView(companyId, id);
  }

  // ── types ───────────────────────────────────────────────────────────────────────────────────────────────────────

  async updateType(id: string, input: TypePatch): Promise<DocumentTypeView> {
    const { companyId } = caller();
    const type = await this.repo.type(companyId, id);
    if (!type) throw new NotFoundException('Document type not found');
    await this.assertCompanyWide();
    const errors: { field: string; code: string; message: string }[] = [];
    if (input.numberFormat !== undefined && !isValidNumberFormat(input.numberFormat)) {
      errors.push({ field: 'numberFormat', code: 'invalid_format', message: INVALID_FORMAT });
    }
    const custom = type.kind === 'custom';
    const published = type.publishedTemplateId ? (await this.templates.published(companyId, [type.publishedTemplateId])).get(type.publishedTemplateId) : undefined;
    if (input.selfService === true && type.code !== 'attestation_travail') {
      if (!custom || type.subject !== 'employment') {
        errors.push({ field: 'selfService', code: 'not_allowed', message: 'Only the attestation de travail and custom employee documents can be requested by employees.' });
      } else if (published?.fields.some((f) => f.required)) {
        errors.push({ field: 'selfService', code: 'required_fields', message: 'Employees cannot fill in the required fields of this template.' });
      }
    }
    if (input.names !== undefined && !custom) errors.push({ field: 'names', code: 'not_allowed', message: 'The names of a system type are fixed.' });
    if (input.employmentRule !== undefined && (!custom || type.subject !== 'employment')) {
      errors.push({ field: 'employmentRule', code: 'not_allowed', message: 'Only a custom employee document has an employment rule to choose.' });
    }
    // a designed type is issued in a language only when its published version has that layout
    const languages = input.languages ? [...new Set(input.languages)] : undefined;
    if (languages && published && languages.some((lang) => !published.layouts[lang])) {
      errors.push({ field: 'languages', code: 'template_language_missing', message: 'The published template has no layout in this language.' });
    }
    if (input.defaultSignatoryId) {
      const signatory = (await this.repo.signatories(companyId, this.clock.today())).find((s) => s.id === input.defaultSignatoryId);
      if (!signatory?.active) errors.push({ field: 'defaultSignatoryId', code: 'not_found', message: 'No active signatory with this id.' });
    }
    if (errors.length) throw new ValidationProblemException(errors);
    if (input.active === true && custom && !type.publishedTemplateId) {
      throw new ProblemException(409, 'document-template-missing', 'Publish a template for this document type before activating it.');
    }
    const patch: Record<string, unknown> = {};
    if (input.numberFormat !== undefined) patch['number_format'] = input.numberFormat;
    if (languages !== undefined) patch['languages'] = languages;
    if (input.selfService !== undefined) patch['self_service'] = input.selfService;
    if (input.defaultSignatoryId !== undefined) patch['default_signatory_id'] = input.defaultSignatoryId;
    if (input.active !== undefined) patch['active'] = input.active;
    if (input.names !== undefined) Object.assign(patch, { name_fr: input.names.fr, name_ar: input.names.ar, name_en: input.names.en });
    if (input.employmentRule !== undefined) patch['employment_rule'] = input.employmentRule;
    try {
      await this.repo.updateType(companyId, id, patch);
    } catch (error) {
      throw typeConflict(error) ?? error;
    }
    return this.typeView(id);
  }

  private async typeView(id: string): Promise<DocumentTypeView> {
    const view = (await this.documents.types()).items.find((t) => t.id === id);
    if (!view) throw new NotFoundException('Document type not found');
    return view;
  }

  /** POST /documents/types: a custom type, inactive until a template is published (document-templates.md › Endpoints). */
  async createType(input: NewTypeInput): Promise<DocumentTypeView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    const errors: { field: string; code: string; message: string }[] = [];
    if (!isValidNumberFormat(input.numberFormat)) errors.push({ field: 'numberFormat', code: 'invalid_format', message: INVALID_FORMAT });
    if (input.subject === 'leave_request' && input.employmentRule !== undefined && input.employmentRule !== 'any') {
      errors.push({ field: 'employmentRule', code: 'not_allowed', message: 'A leave document has no employment rule.' });
    }
    if (errors.length) throw new ValidationProblemException(errors);
    if (isDocumentTypeCode(input.code)) {
      throw new ProblemException(409, 'document-type-code-taken', 'This code belongs to a built-in document type.', [{ field: 'code', code: 'code_taken', message: 'Already used.' }]);
    }
    let id: string;
    try {
      id = await this.repo.insertType(companyId, {
        code: input.code,
        nameFr: input.names.fr,
        nameAr: input.names.ar,
        nameEn: input.names.en,
        subject: input.subject,
        employmentRule: input.subject === 'employment' ? (input.employmentRule ?? 'any') : 'any',
        numberFormat: input.numberFormat,
        languages: [...new Set(input.languages)],
        sortOrder: input.sortOrder ?? null,
      });
    } catch (error) {
      throw typeConflict(error) ?? error;
    }
    return this.typeView(id);
  }
}
