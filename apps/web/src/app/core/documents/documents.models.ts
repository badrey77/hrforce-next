/**
 * Documents API types — from the binding contract `docs/contracts/documents.md` › Phase A (endpoints and views).
 * Plain TypeScript, no Angular: these types vanish at runtime and only let `strictTemplates` check our usage.
 *
 * Lives in core/ because five places read it: the documents feature (register, detail, issue, settings), My documents,
 * the employee Documents tab, the leave request page ("Titre de congé") and My tasks (document requests).
 *
 * Also here: the pure helpers of the number format (`{YYYY}`, `{YY}`, `{SEQ:n}`) — the Types settings tab previews
 * the next number while the format is typed, without asking the server.
 */
import type { NamePair, UnitRef } from '../employees/employees.models';
import type { Labels, WorkflowProgress } from '../leave/leave.models';

/** The three Phase A types (codes are fixed in code; names, formats and switches are data). */
export type DocumentTypeCode = 'attestation_travail' | 'certificat_travail' | 'titre_conge';
export const DOCUMENT_TYPE_CODES: readonly DocumentTypeCode[] = ['attestation_travail', 'certificat_travail', 'titre_conge'];

/** Documents are printed in French or Arabic only (contract assumption 2). */
export type DocumentLanguage = 'fr' | 'ar';
export const DOCUMENT_LANGUAGES: readonly DocumentLanguage[] = ['fr', 'ar'];

export type DocumentStatus = 'issued' | 'void';
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['issued', 'void'];

/** `GET /documents/types` item. `numberFormat`, `nextNumber`, `defaultSignatoryId` are null for plain readers. */
export interface DocumentTypeView {
  readonly id: string;
  /** One of `DOCUMENT_TYPE_CODES`; kept a `string` so a type added by the API later still renders. */
  readonly code: string;
  readonly labels: Labels;
  readonly languages: readonly DocumentLanguage[];
  readonly selfService: boolean;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly numberFormat: string | null;
  readonly nextNumber: string | null;
  readonly defaultSignatoryId: string | null;
}

export interface DocumentTypeList {
  readonly items: readonly DocumentTypeView[];
}

/** `PUT /documents/types/:id`. `selfService` only for `attestation_travail` (422 elsewhere). */
export interface UpdateDocumentType {
  readonly numberFormat?: string;
  readonly languages?: readonly DocumentLanguage[];
  readonly selfService?: boolean;
  readonly defaultSignatoryId?: string | null;
  readonly active?: boolean;
}

export interface FrAr {
  readonly fr: string;
  readonly ar: string;
}

export interface SignatoryView {
  readonly id: string;
  /** `null` = signs for the whole company. */
  readonly unit: { readonly id: string; readonly code: string; readonly name: string; readonly nameAr: string | null } | null;
  readonly names: FrAr;
  readonly titles: FrAr;
  readonly active: boolean;
  /** Type codes this signatory is the default for. */
  readonly defaultFor: readonly string[];
}

export interface SignatoryList {
  readonly items: readonly SignatoryView[];
}

/** `POST /documents/settings/signatories`. */
export interface NewSignatory {
  readonly orgUnitId: string | null;
  readonly names: FrAr;
  readonly titles: FrAr;
}

/** `PATCH /documents/settings/signatories/:id`. */
export interface SignatoryPatch {
  readonly orgUnitId?: string | null;
  readonly names?: FrAr;
  readonly titles?: FrAr;
  readonly active?: boolean;
}

/** The company letterhead's text fields (`PUT /documents/settings/profile`, camelCase, no logo). */
export interface CompanyProfileFields {
  readonly legalNameFr: string | null;
  readonly legalNameAr: string | null;
  readonly addressFr: string | null;
  readonly addressAr: string | null;
  readonly cityFr: string | null;
  readonly cityAr: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly nif: string | null;
  readonly nis: string | null;
  readonly rc: string | null;
  readonly ai: string | null;
  readonly footerFr: string | null;
  readonly footerAr: string | null;
}

/** `GET /documents/settings/profile` — all nulls when no profile exists yet. */
export interface CompanyProfileView extends CompanyProfileFields {
  readonly hasLogo: boolean;
  /** Every field printed in that language is filled (issuing in it would not answer `document-profile-incomplete`). */
  readonly complete: { readonly fr: boolean; readonly ar: boolean };
}

export interface PersonRef {
  readonly id: string;
  readonly displayName: string;
}

export type DocumentAction = 'void';
export type DocumentWarning = 'leave-cancelled';

/** The employee a document is about (as in employment.md). */
export interface DocumentEmployee {
  /** The employment id (`/employees/:id`). */
  readonly id: string;
  readonly matricule: string;
  readonly person: NamePair;
  readonly unit: UnitRef;
}

export interface IssuedDocumentView {
  readonly id: string;
  readonly number: string;
  readonly type: { readonly code: string; readonly labels: Labels };
  readonly language: DocumentLanguage;
  readonly status: DocumentStatus;
  readonly issueDate: string;
  readonly issuedAt: string;
  readonly issuedBy: PersonRef | null;
  readonly employee: DocumentEmployee;
  readonly leaveRequestId: string | null;
  readonly documentRequestId: string | null;
  readonly signatory: { readonly id: string; readonly names: FrAr };
  readonly sizeBytes: number;
  /** Hex SHA-256 of the stored PDF. */
  readonly sha256: string;
  readonly void: { readonly at: string; readonly by: PersonRef | null; readonly reason: string } | null;
  readonly warnings: readonly DocumentWarning[];
  readonly _actions: readonly DocumentAction[];
}

/** The printed values (contract › Snapshot). Only the fields the detail page shows are typed strictly. */
export interface DocumentSnapshot {
  readonly v: number;
  readonly type: string;
  readonly lang: DocumentLanguage;
  readonly number: string;
  readonly issueDate: string;
  readonly issueDateText: string;
  readonly employee: {
    readonly civility: string;
    readonly fullName: string;
    readonly matricule: string;
    readonly jobTitle: string;
    readonly unitName: string;
    readonly hireDateText: string;
    readonly endDateText: string | null;
  };
  readonly leave?: { readonly typeLabel: string; readonly startText: string; readonly endText: string; readonly days: string; readonly resumptionText: string };
  readonly signatory: { readonly name: string; readonly title: string };
}

/** `GET /documents/:id` = the view + the printed values. */
export interface IssuedDocumentDetail extends IssuedDocumentView {
  readonly snapshot?: DocumentSnapshot;
}

export interface IssuedDocumentPage {
  readonly items: readonly IssuedDocumentView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/**
 * `POST /documents/preview` and `POST /documents`. `employmentId` for attestation/certificat, `leaveRequestId` for the
 * titre de congé (sending the other one is a 422).
 */
export interface IssueBody {
  readonly typeCode: string;
  readonly employmentId?: string;
  readonly leaveRequestId?: string;
  readonly language: DocumentLanguage;
  readonly signatoryId?: string;
  /** One per form fill: a repeat returns the document already issued instead of a second number. */
  readonly clientRequestId?: string;
}

export type DocumentRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type DocumentRequestAction = 'cancel';

export interface DocumentRequestView {
  readonly id: string;
  readonly type: { readonly code: string; readonly labels: Labels };
  readonly language: DocumentLanguage;
  readonly purpose: string | null;
  readonly status: DocumentRequestStatus;
  readonly requestedAt: string;
  /** Same progress block as leave list items (the stepper draws it). */
  readonly workflow: WorkflowProgress & { readonly instanceId?: string };
  readonly document: { readonly id: string; readonly number: string } | null;
  readonly rejectionComment: string | null;
  readonly _actions: readonly DocumentRequestAction[];
}

/** `GET /me/documents`. */
export interface MyDocuments {
  readonly documents: readonly IssuedDocumentView[];
  readonly requests: readonly DocumentRequestView[];
}

/** `POST /me/documents/requests`. */
export interface NewDocumentRequest {
  readonly typeCode: string;
  readonly language: DocumentLanguage;
  readonly purpose?: string;
}

/** `?disposition=` of the PDF endpoints. */
export type PdfDisposition = 'attachment' | 'inline';

// --- Register query ---------------------------------------------------------------------------------------------

export type DocumentStatusFilter = DocumentStatus | 'all';
export const DOCUMENT_STATUS_FILTERS: readonly DocumentStatusFilter[] = ['all', 'issued', 'void'];
export const DOCUMENT_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];

/** `GET /documents` query, fully resolved (the register keeps it in the URL). */
export interface DocumentQuery {
  readonly q: string;
  readonly typeCode: string | null;
  readonly status: DocumentStatusFilter;
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly from: string | null;
  readonly to: string | null;
  /** Not in the register's URL: the employee Documents tab and the leave request page filter by these. */
  readonly employmentId: string | null;
  readonly leaveRequestId: string | null;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_DOCUMENT_QUERY: DocumentQuery = {
  q: '',
  typeCode: null,
  status: 'all',
  unitId: null,
  includeSubUnits: true,
  from: null,
  to: null,
  employmentId: null,
  leaveRequestId: null,
  page: 1,
  pageSize: 25,
};

// --- `_actions` without lint exceptions in templates (the field names are the contract's) -------------------------

export function documentActions(document: Pick<IssuedDocumentView, '_actions'>): readonly DocumentAction[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return document._actions ?? [];
}

export function documentRequestActions(request: Pick<DocumentRequestView, '_actions'>): readonly DocumentRequestAction[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return request._actions ?? [];
}

// --- Number format (contract › Numbering) -----------------------------------------------------------------------

/** Max length of a RENDERED number. */
export const NUMBER_MAX_LENGTH = 40;
const TOKEN = /\{(YYYY|YY|SEQ(?::([1-9]))?)\}/g;
const LITERAL = /^[A-Z0-9/_.-]*$/;

/**
 * Why a format is refused, or `null` when it is valid: literals `[A-Z0-9/_.-]`, tokens `{YYYY}`, `{YY}`, `{SEQ}`,
 * `{SEQ:n}` (n = 1–9), exactly one `{SEQ…}`, at least one year token, ≤ 40 characters once rendered. The API checks the
 * same rules (422 `invalid_format`); this only saves a round trip.
 */
export function numberFormatError(format: string): 'literal' | 'seq' | 'year' | 'length' | null {
  let seqCount = 0;
  let yearCount = 0;
  let seqWidth = 1;
  for (const match of format.matchAll(TOKEN)) {
    if (match[1]?.startsWith('SEQ')) {
      seqCount += 1;
      seqWidth = Number(match[2] ?? 1);
    } else {
      yearCount += 1;
    }
  }
  if (!LITERAL.test(format.replace(TOKEN, ''))) return 'literal';
  if (seqCount !== 1) return 'seq';
  if (yearCount < 1) return 'year';
  if (renderNumber(format, 2026, 10 ** (seqWidth - 1)).length > NUMBER_MAX_LENGTH) return 'length';
  return null;
}

/** A number from a format, a year and a sequence value (`ATT-{YYYY}-{SEQ:5}`, 2026, 42 → `ATT-2026-00042`). */
export function renderNumber(format: string, year: number, seq: number): string {
  return format.replace(TOKEN, (_all, token: string, width: string | undefined) => {
    if (token === 'YYYY') return String(year);
    if (token === 'YY') return String(year % 100).padStart(2, '0');
    return String(seq).padStart(Number(width ?? 1), '0');
  });
}

/**
 * Reads the year and sequence back out of a number rendered with `format` (the API's `nextNumber` with the stored
 * format), so the settings tab can preview the SAME next number under a format being edited. `null` when the number
 * does not match the format.
 */
export function parseNumber(format: string, number: string): { year: number | null; seq: number } | null {
  const groups: string[] = [];
  let pattern = '';
  let last = 0;
  for (const match of format.matchAll(TOKEN)) {
    pattern += escapeRegExp(format.slice(last, match.index));
    const token = match[1] ?? '';
    groups.push(token.startsWith('SEQ') ? 'SEQ' : token);
    pattern += token === 'YYYY' ? '(\\d{4})' : token === 'YY' ? '(\\d{2})' : '(\\d+)';
    last = (match.index ?? 0) + match[0].length;
  }
  pattern += escapeRegExp(format.slice(last));
  const found = new RegExp(`^${pattern}$`).exec(number);
  if (!found) return null;
  let year: number | null = null;
  let seq: number | null = null;
  for (const [i, group] of groups.entries()) {
    const value = Number(found[i + 1]);
    if (group === 'YYYY') year = value;
    else if (group === 'YY') year ??= 2000 + value;
    else seq = value;
  }
  return seq === null ? null : { year, seq };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
