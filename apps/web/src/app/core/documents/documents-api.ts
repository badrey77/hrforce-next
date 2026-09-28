/**
 * DocumentsApi — the one place that knows the Documents endpoints (`docs/contracts/documents.md` › Endpoints).
 *
 * Same split as the other `*Api` services (core/leave/leave-api.ts, core/employees/employees-api.ts): page reads are
 * signal-driven `httpResource`s, writes are one-shot Observables the pages subscribe to.
 *
 * What is new here — BINARY responses:
 * - **`responseType: 'blob'`.** By default `HttpClient` parses the body as JSON. A PDF (or the company logo) is bytes:
 *   `http.get(url, { responseType: 'blob' })` asks for a `Blob` instead, and the method's return type becomes
 *   `Observable<Blob>` (the overloads of `get`/`post` pick the type from the literal `'blob'`, which is why the option
 *   object is written inline). Why fetch the PDF through `HttpClient` at all, instead of pointing a link at
 *   `/api/documents/:id/pdf`? Because the request then goes through our interceptors: an expired 15-minute access
 *   cookie is refreshed and the request retried (core/auth/auth-refresh.interceptor.ts), and a refusal comes back as
 *   a problem we can explain (`document-render-failed`, 404…) instead of a raw JSON page in a new tab.
 * - **Errors of a blob request are blobs too.** With `responseType: 'blob'`, a 409 problem+json body arrives as a
 *   `Blob`, not an object. `apiProblemInterceptor` reads it as text and parses it (core/http/api-problem.interceptor.ts),
 *   so callers get the same `ApiProblemError` as for any JSON call.
 * - **A POST that returns a file.** `POST /documents/preview` renders a specimen PDF from a request body and stores
 *   nothing. It is a one-shot `Observable<Blob>` (not a resource): the user clicks "Preview" and one tab opens.
 * - **`FormData` upload.** `uploadLogo()` PUTs a `FormData` with one `file` field. `HttpClient` detects `FormData` and
 *   lets the browser write `Content-Type: multipart/form-data; boundary=…` itself — setting that header by hand would
 *   drop the boundary and break the upload. XSRF still applies (it is a PUT).
 *
 * `…Resource()` methods create an `httpResource`, which itself calls `inject()`: call them from a field initializer.
 */
import { HttpClient, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CompanyProfileFields,
  CompanyProfileView,
  DocumentQuery,
  DocumentRequestView,
  DocumentTypeList,
  DocumentTypeView,
  IssueBody,
  IssuedDocumentDetail,
  IssuedDocumentPage,
  IssuedDocumentView,
  MyDocuments,
  NewDocumentRequest,
  NewSignatory,
  PdfDisposition,
  SignatoryList,
  SignatoryPatch,
  SignatoryView,
  UpdateDocumentType,
} from './documents.models';

export const DOCUMENTS_API_BASE = '/api/documents';
export const MY_DOCUMENTS_API_BASE = '/api/me/documents';

const enc = encodeURIComponent;

/** Query params of `GET /documents` for a resolved query: empty filters are left out, paging is always sent. */
export function documentListParams(query: DocumentQuery): Record<string, string> {
  const params: Record<string, string> = {};
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.typeCode) params['typeCode'] = query.typeCode;
  if (query.status !== 'all') params['status'] = query.status;
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  if (query.from) params['from'] = query.from;
  if (query.to) params['to'] = query.to;
  if (query.employmentId) params['employmentId'] = query.employmentId;
  if (query.leaveRequestId) params['leaveRequestId'] = query.leaveRequestId;
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

@Injectable({ providedIn: 'root' })
export class DocumentsApi {
  private readonly http = inject(HttpClient);

  // --- Reference data -------------------------------------------------------------------------------------------

  /** `GET /documents/types` (every signed-in user). `enabled` false → no request. */
  typesResource(enabled: () => boolean = () => true): HttpResourceRef<DocumentTypeList | undefined> {
    return httpResource<DocumentTypeList>(() => (enabled() ? `${DOCUMENTS_API_BASE}/types` : undefined));
  }

  /** `GET /documents/signatories?employmentId=` — active signatories covering that employee, nearest first. */
  signatoriesForResource(employmentId: () => string | null | undefined): HttpResourceRef<SignatoryList | undefined> {
    return httpResource<SignatoryList>(() => {
      const id = employmentId();
      return id ? { url: `${DOCUMENTS_API_BASE}/signatories`, params: { employmentId: id } } : undefined;
    });
  }

  // --- Register -------------------------------------------------------------------------------------------------

  listResource(query: () => DocumentQuery | undefined): HttpResourceRef<IssuedDocumentPage | undefined> {
    return httpResource<IssuedDocumentPage>(() => {
      const value = query();
      return value ? { url: DOCUMENTS_API_BASE, params: documentListParams(value) } : undefined;
    });
  }

  detailResource(id: () => string | null | undefined): HttpResourceRef<IssuedDocumentDetail | undefined> {
    return httpResource<IssuedDocumentDetail>(() => {
      const value = id();
      return value ? `${DOCUMENTS_API_BASE}/${enc(value)}` : undefined;
    });
  }

  /** `POST /documents` → 201 (or 200 when `clientRequestId` replays an earlier issue). */
  issue(body: IssueBody): Observable<IssuedDocumentView> {
    return this.http.post<IssuedDocumentView>(DOCUMENTS_API_BASE, body);
  }

  /** `POST /documents/preview` → a specimen PDF (no number consumed, nothing stored). */
  preview(body: IssueBody): Observable<Blob> {
    return this.http.post(`${DOCUMENTS_API_BASE}/preview`, body, { responseType: 'blob' });
  }

  /** `GET /documents/:id/pdf` — the stored bytes (a voided document stays downloadable here: it is the record). */
  pdf(id: string, disposition: PdfDisposition = 'attachment'): Observable<Blob> {
    return this.http.get(`${DOCUMENTS_API_BASE}/${enc(id)}/pdf`, { params: { disposition }, responseType: 'blob' });
  }

  void(id: string, reason: string): Observable<IssuedDocumentView> {
    return this.http.post<IssuedDocumentView>(`${DOCUMENTS_API_BASE}/${enc(id)}/void`, { reason });
  }

  // --- Settings (`document.configure`) --------------------------------------------------------------------------

  profileResource(): HttpResourceRef<CompanyProfileView | undefined> {
    return httpResource<CompanyProfileView>(() => `${DOCUMENTS_API_BASE}/settings/profile`);
  }

  updateProfile(body: CompanyProfileFields): Observable<CompanyProfileView> {
    return this.http.put<CompanyProfileView>(`${DOCUMENTS_API_BASE}/settings/profile`, body);
  }

  /** The current logo as bytes (404 when none). */
  logo(): Observable<Blob> {
    return this.http.get(`${DOCUMENTS_API_BASE}/settings/profile/logo`, { responseType: 'blob' });
  }

  uploadLogo(file: Blob, fileName = 'logo'): Observable<CompanyProfileView> {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.http.put<CompanyProfileView>(`${DOCUMENTS_API_BASE}/settings/profile/logo`, form);
  }

  deleteLogo(): Observable<void> {
    return this.http.delete<void>(`${DOCUMENTS_API_BASE}/settings/profile/logo`);
  }

  /** Every signatory, inactive ones included. */
  settingsSignatoriesResource(): HttpResourceRef<SignatoryList | undefined> {
    return httpResource<SignatoryList>(() => `${DOCUMENTS_API_BASE}/settings/signatories`);
  }

  createSignatory(body: NewSignatory): Observable<SignatoryView> {
    return this.http.post<SignatoryView>(`${DOCUMENTS_API_BASE}/settings/signatories`, body);
  }

  updateSignatory(id: string, body: SignatoryPatch): Observable<SignatoryView> {
    return this.http.patch<SignatoryView>(`${DOCUMENTS_API_BASE}/settings/signatories/${enc(id)}`, body);
  }

  updateType(id: string, body: UpdateDocumentType): Observable<DocumentTypeView> {
    return this.http.put<DocumentTypeView>(`${DOCUMENTS_API_BASE}/types/${enc(id)}`, body);
  }

  // --- Self-service (`document.request_self`) -------------------------------------------------------------------

  myDocumentsResource(enabled: () => boolean): HttpResourceRef<MyDocuments | undefined> {
    return httpResource<MyDocuments>(() => (enabled() ? MY_DOCUMENTS_API_BASE : undefined));
  }

  requestSelf(body: NewDocumentRequest): Observable<DocumentRequestView> {
    return this.http.post<DocumentRequestView>(`${MY_DOCUMENTS_API_BASE}/requests`, body);
  }

  cancelMine(id: string): Observable<DocumentRequestView> {
    return this.http.post<DocumentRequestView>(`${MY_DOCUMENTS_API_BASE}/requests/${enc(id)}/cancel`, {});
  }

  /** My own issued (not void) document's bytes. */
  myPdf(id: string, disposition: PdfDisposition = 'attachment'): Observable<Blob> {
    return this.http.get(`${MY_DOCUMENTS_API_BASE}/${enc(id)}/pdf`, { params: { disposition }, responseType: 'blob' });
  }
}
