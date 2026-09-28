import type {
  DocumentRequestView,
  DocumentTypeView,
  IssuedDocumentDetail,
  SignatoryView,
} from '../app/core/documents/documents.models';
import { PERSON } from './leave-fixtures';

/** Document types shaped like the contract's seed (docs/contracts/documents.md › Data). */
export const TYPE_ATT: DocumentTypeView = {
  id: 'dt-att',
  code: 'attestation_travail',
  labels: { fr: 'Attestation de travail', ar: 'شهادة عمل', en: 'Employment attestation' },
  languages: ['fr', 'ar'],
  selfService: true,
  active: true,
  sortOrder: 1,
  numberFormat: 'ATT-{YYYY}-{SEQ:5}',
  nextNumber: 'ATT-2026-00043',
  defaultSignatoryId: null,
};
export const TYPE_CT: DocumentTypeView = {
  ...TYPE_ATT,
  id: 'dt-ct',
  code: 'certificat_travail',
  labels: { fr: 'Certificat de travail', ar: 'شهادة نهاية العمل', en: 'Employment certificate' },
  selfService: false,
  sortOrder: 2,
  numberFormat: 'CT-{YYYY}-{SEQ:5}',
  nextNumber: 'CT-2026-00001',
};
export const TYPE_TC: DocumentTypeView = {
  ...TYPE_ATT,
  id: 'dt-tc',
  code: 'titre_conge',
  labels: { fr: 'Titre de congé', ar: 'سند عطلة', en: 'Leave certificate' },
  selfService: false,
  sortOrder: 3,
  numberFormat: 'TC-{YYYY}-{SEQ:5}',
  nextNumber: 'TC-2026-00001',
};
export const DOCUMENT_TYPES: readonly DocumentTypeView[] = [TYPE_ATT, TYPE_CT, TYPE_TC];

export const SIGNATORY_DG: SignatoryView = {
  id: 's-dg',
  unit: null,
  names: { fr: 'Nadia Rahmani', ar: 'نادية رحماني' },
  titles: { fr: 'Directrice RH', ar: 'مديرة الموارد البشرية' },
  active: true,
  defaultFor: [],
};
export const SIGNATORY_EST: SignatoryView = {
  id: 's-est',
  unit: { id: 'r-est', code: 'REG-EST', name: 'Région Est', nameAr: 'الجهة الشرقية' },
  names: { fr: 'Souad Cherif', ar: 'سعاد شريف' },
  titles: { fr: 'Directrice régionale', ar: 'مديرة جهوية' },
  active: true,
  defaultFor: ['titre_conge'],
};

export const UNIT_ANNABA = { id: 'a-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' };

export function issuedDocument(extra: Partial<IssuedDocumentDetail> = {}): IssuedDocumentDetail {
  return {
    id: 'd-1',
    number: 'ATT-2026-00042',
    type: { code: 'attestation_travail', labels: TYPE_ATT.labels },
    language: 'fr',
    status: 'issued',
    issueDate: '2026-09-28',
    issuedAt: '2026-09-28T09:00:00Z',
    issuedBy: { id: 'u-amina', displayName: 'Amina Benali' },
    employee: { id: 'e-1', matricule: 'EMP-0001', person: PERSON, unit: UNIT_ANNABA },
    leaveRequestId: null,
    documentRequestId: null,
    signatory: { id: 's-dg', names: SIGNATORY_DG.names },
    sizeBytes: 24_576,
    sha256: 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12',
    void: null,
    warnings: [],
    _actions: ['void'],
    ...extra,
  };
}

export function documentRequest(extra: Partial<DocumentRequestView> = {}): DocumentRequestView {
  return {
    id: 'dr-1',
    type: { code: 'attestation_travail', labels: TYPE_ATT.labels },
    language: 'fr',
    purpose: 'Dossier de prêt',
    status: 'pending',
    requestedAt: '2026-09-27T08:00:00Z',
    workflow: {
      status: 'pending',
      currentStep: 0,
      steps: [{ key: 'hr', kind: 'permission', permission: 'document.issue', labels: { fr: 'RH', ar: 'الموارد البشرية', en: 'HR' }, state: 'current' }],
    },
    document: null,
    rejectionComment: null,
    _actions: ['cancel'],
    ...extra,
  };
}

/** A problem+json body as a Blob (what a `responseType: 'blob'` request receives on an error). */
export function problemBlob(slug: string, status = 409, errors?: { field: string; code: string; message: string }[]): Blob {
  return new Blob([JSON.stringify({ type: `urn:hrforce:problem:${slug}`, title: 'Conflict', status, ...(errors ? { errors } : {}) })], {
    type: 'application/problem+json',
  });
}
