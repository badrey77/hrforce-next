import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { builtinLayout } from '../domain/builtin-layouts.js';
import { missingProfileFields, type ProfileFacts } from '../domain/snapshot.js';
import { checkFieldValues, sampleFieldValues } from '../domain/template-fields.js';
import { blankLayout, hasPositions, LAYOUT_LIMITS, validateFields, validateLayout, type LayoutError, type TemplateField, type TemplateLayout, type TemplateLayouts } from '../domain/template-layout.js';
import { SAMPLE_LEAVE, SAMPLE_PROFILE, SAMPLE_SIGNATORY, sampleEmployee } from '../domain/template-samples.js';
import { variablesFor } from '../domain/template-variables.js';
import { DOCUMENT_PERMISSIONS as P, isDocumentTypeCode, TEMPLATE_VERSIONS, type DocumentLanguage, type DocumentSubject } from '../domain/types.js';
import { DocumentsRepository, pgError, type TypeRow } from '../infra/documents.repository.js';
import { TemplatesRepository, type TemplateVersionRow } from '../infra/templates.repository.js';
import { DocumentIssuer, documentProblems, layoutOf, type PreparedDocument } from './document-issuer.js';
import type { DocumentTypeView, TemplateVariableView, TemplateVersionSummary, TemplateVersionView, TypeTemplatesView, UserRefView } from './document-views.js';
import { DocumentsClock } from './documents-clock.js';
import { caller, DocumentsService } from './documents.service.js';

const typeNotFound = () => new NotFoundException('Document type not found');
const versionNotFound = () => new NotFoundException('Template version not found');
const notDraft = () => new ProblemException(409, 'document-template-not-draft', 'Only a draft can be changed, published or discarded.');

export interface SaveInput {
  revision: number;
  layouts: unknown;
  fields: unknown;
  note: string | null;
}

export interface PreviewInput {
  lang: DocumentLanguage;
  sample?: true | undefined;
  employmentId?: string | undefined;
  leaveRequestId?: string | undefined;
  fields?: Record<string, string> | undefined;
}

/**
 * Designed templates (docs/contracts/document-templates.md › Endpoints): the placeholder catalogue, a type's versions,
 * drafts (create, save with an optimistic revision, discard), the PDF preview (sample or real subject), publishing and
 * the return to a built-in template. Reads need `document.design` anywhere (the route guard); writes need it over the
 * WHOLE company (else 403 forbidden-scope). Every write is audited by the row triggers; publishing and reverting also
 * record an event.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly repo: DocumentsRepository,
    private readonly templates: TemplatesRepository,
    private readonly issuer: DocumentIssuer,
    private readonly documents: DocumentsService,
    private readonly scopes: ScopeService,
    private readonly clock: DocumentsClock,
    private readonly audit: AuditEvents,
  ) {}

  private async canWrite(): Promise<boolean> {
    return this.scopes.coversCompany(P.design);
  }

  private async assertCompanyWide(): Promise<void> {
    if (!(await this.canWrite())) {
      throw new ProblemException(403, 'forbidden-scope', 'Document templates apply to the whole company: document.design over the root unit is needed.');
    }
  }

  private async type(companyId: string, id: string): Promise<TypeRow> {
    const type = await this.repo.type(companyId, id);
    if (!type) throw typeNotFound();
    return type;
  }

  private async versionRow(companyId: string, id: string): Promise<TemplateVersionRow> {
    const row = await this.templates.version(companyId, id);
    if (!row) throw versionNotFound();
    return row;
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────

  variables(subject: DocumentSubject): { items: TemplateVariableView[] } {
    return { items: variablesFor(subject).map((v) => ({ key: v.key, labels: v.labels, group: v.group, sample: v.sample })) };
  }

  async typeTemplates(typeId: string): Promise<TypeTemplatesView> {
    const { companyId } = caller();
    const type = await this.type(companyId, typeId);
    const [rows, names] = await Promise.all([this.templates.versions(companyId, typeId), this.repo.names(companyId)]);
    return {
      mode: type.templateMode,
      builtin: isDocumentTypeCode(type.code) ? { version: TEMPLATE_VERSIONS[type.code], available: true } : null,
      items: rows.map((r) => this.summary(r, names)),
    };
  }

  async version(id: string): Promise<TemplateVersionView> {
    const { companyId } = caller();
    return this.view(companyId, await this.versionRow(companyId, id));
  }

  builtinLayoutOf(type: TypeRow, lang: DocumentLanguage): TemplateLayout {
    if (!isDocumentTypeCode(type.code)) throw new NotFoundException('This document type has no built-in template');
    return builtinLayout(type.code, lang);
  }

  async builtinLayout(typeId: string, lang: DocumentLanguage): Promise<TemplateLayout> {
    const { companyId } = caller();
    return this.builtinLayoutOf(await this.type(companyId, typeId), lang);
  }

  private summary(r: TemplateVersionRow, names: Map<string, string>): TemplateVersionSummary {
    const ref = (id: string | null): UserRefView | null => (id ? { id, displayName: names.get(id) ?? id } : null);
    return {
      id: r.id,
      version: r.version,
      status: r.status,
      languages: (['fr', 'ar'] as const).filter((lang) => r.layouts[lang] !== undefined),
      fieldCount: r.fields.length,
      note: r.note,
      updatedAt: r.updatedAt,
      updatedBy: ref(r.updatedBy),
      publishedAt: r.publishedAt,
      publishedBy: ref(r.publishedBy),
      issuedCount: r.issuedCount,
    };
  }

  private async view(companyId: string, r: TemplateVersionRow): Promise<TemplateVersionView> {
    const [type, names, versions, writer] = await Promise.all([
      this.type(companyId, r.typeId),
      this.repo.names(companyId),
      this.templates.versions(companyId, r.typeId),
      this.canWrite(),
    ]);
    const draftExists = versions.some((v) => v.status === 'draft');
    const actions: TemplateVersionView['_actions'] = [];
    if (writer && r.status === 'draft') actions.push('edit', 'publish', 'discard');
    if (writer && !draftExists) actions.push('duplicate');
    return { ...this.summary(r, names), typeId: r.typeId, typeCode: type.code, layouts: r.layouts, fields: r.fields, revision: r.revision, basedOn: r.basedOn, _actions: actions };
  }

  // ── drafts ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /documents/types/:id/templates: a new draft from blank, the built-in wording, the published or a given version. */
  async createDraft(typeId: string, from: string): Promise<TemplateVersionView> {
    const { companyId, userId } = caller();
    const type = await this.type(companyId, typeId);
    await this.assertCompanyWide();
    // one draft per type: concurrent creates queue on the type row, the partial unique index is the backstop
    await this.templates.lockType(companyId, typeId);
    const existing = await this.templates.versions(companyId, typeId);
    if (existing.some((v) => v.status === 'draft')) throw this.draftExists();
    let layouts: TemplateLayouts = {};
    let fields: TemplateField[] = [];
    let basedOn: string;
    if (from === 'blank') {
      for (const lang of type.languages) layouts[lang] = blankLayout();
      basedOn = 'blank';
    } else if (from === 'builtin') {
      if (!isDocumentTypeCode(type.code)) throw new ProblemException(409, 'document-template-no-builtin', 'This document type has no built-in template.');
      for (const lang of type.languages) layouts[lang] = builtinLayout(type.code, lang);
      basedOn = `builtin:${TEMPLATE_VERSIONS[type.code]}`;
    } else {
      const source = from === 'published' ? existing.find((v) => v.status === 'published') : existing.find((v) => v.id === from);
      if (!source) {
        if (from === 'published') throw new ProblemException(409, 'document-template-missing', 'This document type has no published template to copy.');
        throw versionNotFound();
      }
      layouts = source.layouts;
      fields = source.fields;
      basedOn = source.id;
    }
    let id: string;
    try {
      id = await this.templates.insertDraft(companyId, { typeId, layouts, fields, basedOn, note: null, userId });
    } catch (error) {
      if (pgError(error)?.constraint === 'document_template_version_one_draft_uk') throw this.draftExists();
      throw error;
    }
    return this.view(companyId, await this.versionRow(companyId, id));
  }

  private draftExists(): ProblemException {
    return new ProblemException(409, 'document-template-draft-exists', 'This document type already has a draft: open it or discard it first.');
  }

  /** The layouts and fields of a save, checked (422 with every error); bidi controls removed. */
  private checked(type: TypeRow, layoutsInput: unknown, fieldsInput: unknown): { layouts: TemplateLayouts; fields: TemplateField[] } {
    const errors: LayoutError[] = [];
    const { fields, errors: fieldErrors } = validateFields(fieldsInput);
    errors.push(...fieldErrors);
    const layouts: TemplateLayouts = {};
    if (typeof layoutsInput !== 'object' || layoutsInput === null || Array.isArray(layoutsInput)) {
      errors.push({ field: 'layouts', code: 'invalid', message: 'An object with a layout per language.' });
    } else {
      const context = { subject: type.subject, fieldKeys: new Set(fields.map((f) => f.key)) };
      for (const [lang, value] of Object.entries(layoutsInput)) {
        if (lang !== 'fr' && lang !== 'ar') {
          errors.push({ field: `layouts.${lang}`, code: 'invalid', message: 'Languages: fr, ar.' });
          continue;
        }
        if (!type.languages.includes(lang)) {
          errors.push({ field: `layouts.${lang}`, code: 'not_allowed', message: 'This document type is not issued in this language.' });
          continue;
        }
        if (value === undefined || value === null) continue;
        const result = validateLayout(value, context, `layouts.${lang}`);
        errors.push(...result.errors);
        if (result.layout) layouts[lang] = result.layout;
      }
    }
    if (Buffer.byteLength(JSON.stringify({ layouts, fields })) > LAYOUT_LIMITS.versionBytes) {
      errors.push({ field: 'layouts', code: 'layout_too_large', message: `At most ${LAYOUT_LIMITS.versionBytes / 1024} KB for the whole template.` });
    }
    if (errors.length) throw new ValidationProblemException(errors, 'The template contains errors.');
    return { layouts, fields };
  }

  /** PUT /documents/templates/:id: saves a draft (stale revision → 409 document-template-changed with the current one). */
  async save(id: string, input: SaveInput): Promise<TemplateVersionView> {
    const { companyId, userId } = caller();
    const current = await this.versionRow(companyId, id);
    await this.assertCompanyWide();
    await this.templates.lockVersion(companyId, id);
    const row = await this.versionRow(companyId, id);
    if (row.status !== 'draft') throw notDraft();
    if (row.revision !== input.revision) throw this.changed(row);
    const type = await this.type(companyId, current.typeId);
    const { layouts, fields } = this.checked(type, input.layouts, input.fields);
    if (!(await this.templates.saveDraft(companyId, id, { revision: input.revision, layouts, fields, note: input.note, userId }))) {
      throw this.changed(await this.versionRow(companyId, id));
    }
    return this.view(companyId, await this.versionRow(companyId, id));
  }

  private changed(row: TemplateVersionRow): ProblemException {
    return new ProblemException(409, 'document-template-changed', 'This draft was changed meanwhile: reload it.', undefined, {
      extensions: { revision: row.revision, updatedBy: row.updatedBy, updatedAt: row.updatedAt },
    });
  }

  /** DELETE /documents/templates/:id: discards a draft. */
  async discard(id: string): Promise<void> {
    const { companyId } = caller();
    await this.versionRow(companyId, id);
    await this.assertCompanyWide();
    await this.templates.lockVersion(companyId, id);
    const row = await this.versionRow(companyId, id);
    if (row.status !== 'draft' || !(await this.templates.deleteDraft(companyId, id))) throw notDraft();
  }

  // ── preview and publish ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The prepared document of a SAMPLE preview: the company's letterhead (or, for the publish check only, a sample one
   * when it is incomplete), a fictitious employee, a leave of 15 days, a sample signatory, sample field values.
   */
  private async samplePrepared(companyId: string, type: TypeRow, version: TemplateVersionRow, lang: DocumentLanguage, options: { sampleLetterhead: boolean }): Promise<PreparedDocument> {
    const layout = layoutOf(version, lang);
    const stored = await this.repo.profile(companyId);
    let profile: ProfileFacts;
    if (stored && missingProfileFields(stored, lang).length === 0) profile = stored;
    else if (options.sampleLetterhead) profile = SAMPLE_PROFILE;
    else {
      throw new ProblemException(
        409,
        'document-profile-incomplete',
        'The company letterhead is incomplete for this language: complete it in the document settings.',
        missingProfileFields(stored ?? null, lang).map((field) => ({ field, code: 'required', message: 'Required on the letterhead of this language.' })),
      );
    }
    const logo = profile === stored && stored.hasLogo ? this.issuer.renderableLogo(companyId, await this.repo.logo(companyId)) : null;
    const employee = sampleEmployee(type.employmentRule);
    const fieldValues = checkFieldValues(version.fields, sampleFieldValues(version.fields, lang)).values;
    return this.issuer.prepared({
      type,
      employee,
      signatory: SAMPLE_SIGNATORY,
      leave: null,
      logo,
      profile,
      version,
      layout,
      fieldValues,
      input: {
        type: type.code,
        lang,
        issueDate: this.clock.today(),
        profile: { ...profile, hasLogo: logo !== null },
        employee,
        signatory: SAMPLE_SIGNATORY,
        ...(hasPositions(layout) ? { positions: true } : {}),
        ...(type.subject === 'leave_request' ? { leave: SAMPLE_LEAVE } : {}),
      },
    });
  }

  /** POST /documents/templates/:id/preview: SPÉCIMEN PDF with sample data or a real subject (document.issue over it). */
  async preview(id: string, input: PreviewInput): Promise<{ pdf: Buffer; filename: string }> {
    const { companyId } = caller();
    const version = await this.versionRow(companyId, id);
    const type = await this.type(companyId, version.typeId);
    const real = input.employmentId !== undefined || input.leaveRequestId !== undefined;
    const pdf = await documentProblems(async () => {
      if (!real) return this.issuer.preview(await this.samplePrepared(companyId, type, version, input.lang, { sampleLetterhead: false }));
      layoutOf(version, input.lang);
      // fields left out of a preview take their sample value (a preview never fails on a missing field)
      const fields = { ...sampleFieldValues(version.fields, input.lang), ...input.fields };
      const spec = await this.documents.spec(companyId, {
        typeCode: type.code,
        employmentId: input.employmentId,
        leaveRequestId: input.leaveRequestId,
        language: input.lang,
        fields,
      });
      return this.issuer.preview(await this.issuer.prepare(companyId, spec, { template: version }));
    });
    return { pdf, filename: `specimen-${type.code}-v${version.version}-${input.lang}.pdf` };
  }

  /** POST /documents/templates/:id/publish: draft → published, the previous published → archived, type → designed. */
  async publish(id: string, input: { revision: number; note: string | null }): Promise<TemplateVersionView> {
    const { companyId, userId } = caller();
    const current = await this.versionRow(companyId, id);
    await this.assertCompanyWide();
    await this.templates.lockType(companyId, current.typeId);
    await this.templates.lockVersion(companyId, id);
    const row = await this.versionRow(companyId, id);
    if (row.status !== 'draft') throw notDraft();
    if (row.revision !== input.revision) throw this.changed(row);
    const type = await this.type(companyId, row.typeId);
    // what was saved is checked again against the type as it is now (languages, subject)
    // a blank draft starts with an empty layout per language: one left empty would issue numbered blank pages
    const incomplete = type.languages.flatMap((lang) => {
      const layout = row.layouts[lang];
      if (!layout) return [{ field: `layouts.${lang}`, code: 'required', message: 'Every language of the document type needs a layout.' }];
      return layout.blocks.length === 0 ? [{ field: `layouts.${lang}`, code: 'empty', message: 'This layout has no block yet.' }] : [];
    });
    if (incomplete.length) throw new ValidationProblemException(incomplete, 'The template is not complete.');
    this.checked(type, row.layouts, row.fields);
    if (type.selfService && row.fields.some((f) => f.required)) {
      throw new ProblemException(409, 'document-template-self-service', 'Employees request this document themselves: its template cannot have required fields.');
    }
    // the sample document of every language must render within the page cap
    await documentProblems(async () => {
      for (const lang of type.languages) await this.issuer.preview(await this.samplePrepared(companyId, type, row, lang, { sampleLetterhead: true }));
    });
    const previous = await this.templates.archivePublished(companyId, type.id);
    await this.templates.publish(companyId, id, userId, input.note);
    await this.templates.setTypeTemplate(companyId, type.id, id);
    await this.audit.record({
      type: 'document.template_published',
      subject: { type: 'document_template_version', id },
      data: { typeCode: type.code, version: row.version, previousVersion: previous?.version ?? null },
    });
    return this.view(companyId, await this.versionRow(companyId, id));
  }

  /** POST /documents/types/:id/templates/builtin: a system type goes back to its built-in template. */
  async revertToBuiltin(typeId: string): Promise<DocumentTypeView> {
    const { companyId } = caller();
    const type = await this.type(companyId, typeId);
    await this.assertCompanyWide();
    if (!isDocumentTypeCode(type.code)) throw new ProblemException(409, 'document-template-no-builtin', 'This document type has no built-in template.');
    await this.templates.lockType(companyId, typeId);
    if (type.templateMode === 'designed') {
      const previous = await this.templates.archivePublished(companyId, typeId);
      await this.templates.setTypeTemplate(companyId, typeId, null);
      await this.audit.record({
        type: 'document.template_reverted',
        subject: { type: 'document_template_version', id: previous?.id ?? type.publishedTemplateId ?? typeId },
        data: { typeCode: type.code, toBuiltin: true, previousVersion: previous?.version ?? null },
      });
    }
    const view = (await this.documents.types()).items.find((t) => t.id === typeId);
    if (!view) throw typeNotFound();
    return view;
  }
}
