/**
 * EmployeeFilesApi — the employee file endpoints (`docs/contracts/documents.md` › Phase B › Endpoints): categories,
 * the files of an employee, upload WITH PROGRESS, download, delete.
 *
 * Same split as the other `*Api` services: page reads are signal-driven `httpResource`s, writes are one-shot
 * Observables the components subscribe to.
 *
 * What is new here — an upload with a progress bar:
 * - **`observe: 'events'` + `reportProgress: true`.** By default `HttpClient` emits ONE value, the parsed body.
 *   `observe: 'events'` makes it emit every `HttpEvent` of the exchange instead: `Sent` (the request left),
 *   `UploadProgress` (`loaded` / `total` bytes of the body, several times), `ResponseHeader`, `DownloadProgress`, and
 *   finally `Response` (the `HttpResponse` with the body). `reportProgress: true` asks the backend to produce the
 *   progress events at all (they cost a change detection each, so they are opt-in).
 * - **Only XMLHttpRequest reports upload progress**, so `upload()` goes through `UPLOAD_HTTP_CLIENT`
 *   (core/http/upload-http.ts), the app's second, XHR-backed client. Everything else here uses the main client.
 * - **`HttpEventType`** is the enum that tells events apart (`event.type === HttpEventType.UploadProgress`); TypeScript
 *   narrows the `HttpEvent<T>` union on it. `upload()` maps the events the UI cares about to a small union of its own
 *   (`UploadEvent`) and drops the rest (`filter`), so components never see HTTP details.
 * - **Cancelling = unsubscribing.** An HttpClient Observable aborts its request when its subscriber unsubscribes
 *   (`xhr.abort()`), so a "Cancel" button is just `subscription.unsubscribe()`.
 * - **Field order in `FormData`.** Text fields are appended BEFORE the file: multipart is a stream, and a server that
 *   handles the file part as it arrives (multer) only knows the fields that came before it.
 * - **Download = `responseType: 'blob'`** as for the PDFs (chapter 18): the bytes go through the interceptors (refresh,
 *   problems) and the component saves them with `BlobFiles`.
 *
 * `…Resource()` methods create an `httpResource`, which itself calls `inject()`: call them from a field initializer.
 */
import { HttpClient, type HttpEvent, HttpEventType, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { filter, map, type Observable } from 'rxjs';
import { UPLOAD_HTTP_CLIENT } from '../http/upload-http';
import type {
  EmployeeFileCategory,
  EmployeeFileCategoryList,
  EmployeeFileCategoryPatch,
  EmployeeFileList,
  EmployeeFileView,
  NewEmployeeFile,
  NewEmployeeFileCategory,
  UploadEvent,
} from './employee-files.models';

export const EMPLOYEE_FILE_CATEGORIES_BASE = '/api/employee-files/categories';
const enc = encodeURIComponent;

export function employeeFilesUrl(employmentId: string): string {
  return `/api/employees/${enc(employmentId)}/files`;
}

/** The multipart body of an upload: text fields first, then the file (see header). */
export function uploadFormData(fields: NewEmployeeFile, file: File): FormData {
  const form = new FormData();
  form.append('categoryId', fields.categoryId);
  form.append('title', fields.title);
  if (fields.documentDate) form.append('documentDate', fields.documentDate);
  if (fields.expiresOn) form.append('expiresOn', fields.expiresOn);
  form.append('file', file, file.name);
  return form;
}

/** One `HttpEvent` of an upload → what the UI shows, or `null` for events it ignores. */
export function toUploadEvent(event: HttpEvent<EmployeeFileView>, size: number): UploadEvent | null {
  switch (event.type) {
    case HttpEventType.Sent:
      return { kind: 'progress', loaded: 0, total: size };
    case HttpEventType.UploadProgress:
      return { kind: 'progress', loaded: event.loaded, total: event.total ?? null };
    case HttpEventType.Response:
      return event.body ? { kind: 'done', file: event.body } : null;
    default:
      return null;
  }
}

@Injectable({ providedIn: 'root' })
export class EmployeeFilesApi {
  private readonly http = inject(HttpClient);
  private readonly uploads = inject(UPLOAD_HTTP_CLIENT);

  // --- Categories -------------------------------------------------------------------------------------------------

  /** `GET /employee-files/categories` (every signed-in user). `enabled` false → no request. */
  categoriesResource(enabled: () => boolean = () => true): HttpResourceRef<EmployeeFileCategoryList | undefined> {
    return httpResource<EmployeeFileCategoryList>(() => (enabled() ? EMPLOYEE_FILE_CATEGORIES_BASE : undefined));
  }

  createCategory(body: NewEmployeeFileCategory): Observable<EmployeeFileCategory> {
    return this.http.post<EmployeeFileCategory>(EMPLOYEE_FILE_CATEGORIES_BASE, body);
  }

  updateCategory(id: string, body: EmployeeFileCategoryPatch): Observable<EmployeeFileCategory> {
    return this.http.put<EmployeeFileCategory>(`${EMPLOYEE_FILE_CATEGORIES_BASE}/${enc(id)}`, body);
  }

  // --- Files of an employee ---------------------------------------------------------------------------------------

  /** `GET /employees/:id/files` — every employment of the person, newest first. `includeDeleted` adds tombstones. */
  filesResource(
    employmentId: () => string | null | undefined,
    includeDeleted: () => boolean = () => false,
  ): HttpResourceRef<EmployeeFileList | undefined> {
    return httpResource<EmployeeFileList>(() => {
      const id = employmentId();
      if (!id) return undefined;
      const params: Record<string, string> = includeDeleted() ? { includeDeleted: 'true' } : {};
      return { url: employeeFilesUrl(id), params };
    });
  }

  /** `POST /employees/:id/files` (multipart) — progress events, then the created file. Unsubscribe to abort. */
  upload(employmentId: string, fields: NewEmployeeFile, file: File): Observable<UploadEvent> {
    return this.uploads
      .post<EmployeeFileView>(employeeFilesUrl(employmentId), uploadFormData(fields, file), {
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        map((event) => toUploadEvent(event, file.size)),
        filter((event): event is UploadEvent => event !== null),
      );
  }

  /** `GET /employees/:id/files/:fileId/content` — the bytes (always an attachment; audited by the API). */
  content(employmentId: string, fileId: string): Observable<Blob> {
    return this.http.get(`${employeeFilesUrl(employmentId)}/${enc(fileId)}/content`, { responseType: 'blob' });
  }

  /** `POST /employees/:id/files/:fileId/delete` `{reason}` → 204 (tombstone; the content is deleted). */
  delete(employmentId: string, fileId: string, reason: string): Observable<void> {
    return this.http.post<void>(`${employeeFilesUrl(employmentId)}/${enc(fileId)}/delete`, { reason });
  }
}
