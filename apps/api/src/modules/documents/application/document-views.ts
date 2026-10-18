/** Response shapes of docs/contracts/documents.md › Endpoints (the API layer returns them as-is). */
import type { EmployeeCard } from '../../staffing/index.js';
import type { WorkflowProgressView } from '../../workflow/index.js';
import type { DocumentSnapshot } from '../domain/snapshot.js';
import type { TemplateField, TemplateLayouts } from '../domain/template-layout.js';
import type { DocumentLanguage, DocumentSubject, EmploymentRule, TemplateMode } from '../domain/types.js';

export interface Labels {
  fr: string;
  ar: string;
  en: string;
}

export interface DocumentTypeView {
  id: string;
  code: string;
  labels: Labels;
  languages: DocumentLanguage[];
  selfService: boolean;
  active: boolean;
  sortOrder: number;
  /** null unless the caller holds document.issue or document.configure somewhere */
  numberFormat: string | null;
  nextNumber: string | null;
  defaultSignatoryId: string | null;
  kind: 'system' | 'custom';
  subject: DocumentSubject;
  employmentRule: EmploymentRule;
  templateMode: TemplateMode;
  /** the published designed version (its fields make the issue form); null = the built-in template or none yet */
  template: { id: string; version: number; fields: TemplateField[] } | null;
}

export interface SignatoryView {
  id: string;
  unit: { id: string; code: string; name: string; nameAr: string | null } | null;
  names: { fr: string; ar: string };
  titles: { fr: string; ar: string };
  active: boolean;
  /** type codes whose default signatory this is */
  defaultFor: string[];
}

export interface CompanyProfileView {
  legalNameFr: string | null;
  legalNameAr: string | null;
  addressFr: string | null;
  addressAr: string | null;
  cityFr: string | null;
  cityAr: string | null;
  phone: string | null;
  email: string | null;
  nif: string | null;
  nis: string | null;
  rc: string | null;
  ai: string | null;
  footerFr: string | null;
  footerAr: string | null;
  hasLogo: boolean;
  complete: { fr: boolean; ar: boolean };
}

export type DocumentEmployee = Pick<EmployeeCard, 'id' | 'matricule' | 'person' | 'unit'>;

export interface UserRefView {
  id: string;
  displayName: string;
}

export interface IssuedDocumentView {
  id: string;
  number: string;
  type: { code: string; labels: Labels };
  language: DocumentLanguage;
  status: 'issued' | 'void';
  issueDate: string;
  issuedAt: string;
  issuedBy: UserRefView | null;
  employee: DocumentEmployee;
  leaveRequestId: string | null;
  documentRequestId: string | null;
  signatory: { id: string; names: { fr: string; ar: string } };
  /** e.g. `attestation_travail@2` or `ordre_mission.designed@3` */
  templateVersion: string;
  /** the designed version used, null for a built-in template */
  template: { id: string; version: number } | null;
  sizeBytes: number;
  /** hex SHA-256 of the stored PDF */
  sha256: string;
  void: { at: string; by: UserRefView | null; reason: string } | null;
  warnings: 'leave-cancelled'[];
  _actions: 'void'[];
}

export interface IssuedDocumentDetail extends IssuedDocumentView {
  snapshot: DocumentSnapshot;
}

export interface IssuedDocumentPage {
  items: IssuedDocumentView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DocumentRequestView {
  id: string;
  type: { code: string; labels: Labels };
  language: DocumentLanguage;
  purpose: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requestedAt: string;
  workflow: WorkflowProgressView | null;
  document: { id: string; number: string } | null;
  rejectionComment: string | null;
  _actions: 'cancel'[];
}

export interface MyDocumentsView {
  documents: IssuedDocumentView[];
  requests: DocumentRequestView[];
}

/** A PDF response (the controller sets the contract's headers). */
export interface PdfFile {
  bytes: Buffer;
  number: string;
  sha256: string;
  status: 'issued' | 'void';
}

// ── designed templates (docs/contracts/document-templates.md › Endpoints) ─────────────────────────────────────────

export interface TemplateVersionSummary {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  /** the languages the version has a layout for */
  languages: DocumentLanguage[];
  fieldCount: number;
  note: string | null;
  updatedAt: string;
  updatedBy: UserRefView | null;
  publishedAt: string | null;
  publishedBy: UserRefView | null;
  /** documents issued with this version */
  issuedCount: number;
}

export interface TemplateVersionView extends TemplateVersionSummary {
  typeId: string;
  typeCode: string;
  layouts: TemplateLayouts;
  fields: TemplateField[];
  revision: number;
  basedOn: string | null;
  _actions: ('edit' | 'publish' | 'discard' | 'duplicate')[];
}

export interface TypeTemplatesView {
  mode: TemplateMode;
  /** system types: the built-in template (always available); custom types: null */
  builtin: { version: string; available: boolean } | null;
  items: TemplateVersionSummary[];
}

export interface TemplateVariableView {
  key: string;
  labels: Labels;
  group: string;
  sample: { fr: string; ar: string };
}
