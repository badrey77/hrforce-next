/**
 * Documents — reference data (docs/contracts/documents.md › Phase A, document-templates.md, ADR 008). Pure: no Nest,
 * no Kysely.
 */

/** The three system types (seeded per company, built-in templates in code). */
export const DOCUMENT_TYPE_CODES = ['attestation_travail', 'certificat_travail', 'titre_conge'] as const;
export type SystemDocumentTypeCode = (typeof DOCUMENT_TYPE_CODES)[number];
/** Any type code of a company: a system code or a custom one (document-templates.md › Data). */
export type DocumentTypeCode = string;

/** Codes of every type (system codes match it too); custom codes are never system codes. */
export const TYPE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;

export const DOCUMENT_LANGUAGES = ['fr', 'ar'] as const;
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number];

export function isDocumentTypeCode(value: string): value is SystemDocumentTypeCode {
  return (DOCUMENT_TYPE_CODES as readonly string[]).includes(value);
}

/** What a document is issued for (document-templates.md › Concepts). */
export const DOCUMENT_SUBJECTS = ['employment', 'leave_request'] as const;
export type DocumentSubject = (typeof DOCUMENT_SUBJECTS)[number];

/** The employment state an `employment` type needs on the issue date. */
export const EMPLOYMENT_RULES = ['any', 'active', 'ended'] as const;
export type EmploymentRule = (typeof EMPLOYMENT_RULES)[number];

export type TemplateMode = 'builtin' | 'designed';

/**
 * Template file and version per system type (ADR 008 › Decision 3): `apps/api/assets/pdf/templates/<code>.typ`. The
 * version is stored with every document; changing a template's wording or layout bumps it.
 */
export const TEMPLATE_VERSIONS: Readonly<Record<SystemDocumentTypeCode, string>> = {
  attestation_travail: 'attestation_travail@2',
  certificat_travail: 'certificat_travail@2',
  titre_conge: 'titre_conge@2',
};

/** The fixed Typst file that lays out designed templates (ADR 008 amendment 2026-10-09). */
export const DESIGNED_TEMPLATE = 'designed';

/** `issued_document.template_version` of a document rendered from a designed version. */
export function designedTemplateVersion(typeCode: string, version: number): string {
  return `${typeCode}.designed@${version}`;
}

export const DOCUMENT_PERMISSIONS = {
  read: 'document.read',
  issue: 'document.issue',
  void: 'document.void',
  configure: 'document.configure',
  requestSelf: 'document.request_self',
  design: 'document.design',
} as const;

/** The self-service workflow (seeded per company): one HR step, `document.issue` over the employee's unit. */
export const DOCUMENT_WORKFLOW_CODE = 'document.hr_only';

/** Subject and employment rule of each system type (immutable; migration 0022 backfills them). */
export const SYSTEM_TYPE_RULES: Readonly<Record<SystemDocumentTypeCode, { subject: DocumentSubject; employmentRule: EmploymentRule }>> = {
  attestation_travail: { subject: 'employment', employmentRule: 'active' },
  certificat_travail: { subject: 'employment', employmentRule: 'ended' },
  titre_conge: { subject: 'leave_request', employmentRule: 'any' },
};

/** Default types of every company (migration 0014 for existing ones, seedDocumentDefaults for new ones). */
export const DEFAULT_DOCUMENT_TYPES: readonly {
  code: SystemDocumentTypeCode;
  names: { fr: string; ar: string; en: string };
  numberFormat: string;
  selfService: boolean;
  sortOrder: number;
}[] = [
  { code: 'attestation_travail', names: { fr: 'Attestation de travail', ar: 'شهادة عمل', en: 'Employment certificate' }, numberFormat: 'ATT-{YYYY}-{SEQ:5}', selfService: true, sortOrder: 10 },
  {
    code: 'certificat_travail',
    names: { fr: 'Certificat de travail', ar: 'شهادة نهاية العمل', en: 'Certificate of employment (end of contract)' },
    numberFormat: 'CT-{YYYY}-{SEQ:5}',
    selfService: false,
    sortOrder: 20,
  },
  { code: 'titre_conge', names: { fr: 'Titre de congé', ar: 'سند عطلة', en: 'Leave certificate' }, numberFormat: 'TC-{YYYY}-{SEQ:5}', selfService: false, sortOrder: 30 },
];

/** A document rule that fails: 409 problem (or 422 on a field) with this slug. */
export class DocumentRuleViolation extends Error {
  constructor(
    readonly slug: string,
    message: string,
    readonly status: 409 | 422 = 409,
    readonly errors?: { field: string; code: string; message: string }[],
  ) {
    super(message);
  }
}
