/**
 * Documents — reference data (docs/contracts/documents.md › Phase A, ADR 008). Pure: no Nest, no Kysely.
 */

export const DOCUMENT_TYPE_CODES = ['attestation_travail', 'certificat_travail', 'titre_conge'] as const;
export type DocumentTypeCode = (typeof DOCUMENT_TYPE_CODES)[number];

export const DOCUMENT_LANGUAGES = ['fr', 'ar'] as const;
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number];

export function isDocumentTypeCode(value: string): value is DocumentTypeCode {
  return (DOCUMENT_TYPE_CODES as readonly string[]).includes(value);
}

/**
 * Template file and version per type (ADR 008 › Decision 3): `apps/api/assets/pdf/templates/<code>.typ`. The version is
 * stored with every document; changing a template's wording or layout bumps it.
 */
export const TEMPLATE_VERSIONS: Readonly<Record<DocumentTypeCode, string>> = {
  attestation_travail: 'attestation_travail@1',
  certificat_travail: 'certificat_travail@1',
  titre_conge: 'titre_conge@1',
};

export const DOCUMENT_PERMISSIONS = {
  read: 'document.read',
  issue: 'document.issue',
  void: 'document.void',
  configure: 'document.configure',
  requestSelf: 'document.request_self',
} as const;

/** The self-service workflow (seeded per company): one HR step, `document.issue` over the employee's unit. */
export const DOCUMENT_WORKFLOW_CODE = 'document.hr_only';

/** Default types of every company (migration 0014 for existing ones, seedDocumentDefaults for new ones). */
export const DEFAULT_DOCUMENT_TYPES: readonly {
  code: DocumentTypeCode;
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
