/** Response shapes of docs/contracts/documents.md › Endpoints (the API layer returns them as-is). */
import type { EmployeeCard } from '../../staffing/index.js';
import type { WorkflowProgressView } from '../../workflow/index.js';
import type { DocumentSnapshot } from '../domain/snapshot.js';
import type { DocumentLanguage } from '../domain/types.js';

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
