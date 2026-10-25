/**
 * ProfileApi — personal details (HR writes on an employee) and the self-service change requests
 * (`docs/contracts/profile-changes.md`). Reads are `httpResource`s (create them from a field initializer), writes
 * one-shot Observables. The request submit is multipart through the XHR client so the form can show upload progress.
 */
import { HttpClient, type HttpEvent, HttpEventType, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { filter, map, type Observable } from 'rxjs';
import { UPLOAD_HTTP_CLIENT } from '../http/upload-http';
import type {
  ContactInput,
  EmergencyInput,
  FamilyInput,
  MyProfileView,
  NewProfileRequest,
  PersonalView,
  ProfileRequestDetail,
  ProfileRequestList,
  ProfileRequestPage,
  ProfileRequestQuery,
  ProfileRequestStatus,
  ProfileRequestView,
  ProfileSettings,
  ProfileUploadEvent,
} from './profile.models';

export const MY_PROFILE_BASE = '/api/me/profile';
export const PROFILE_REQUESTS_BASE = '/api/profile/requests';
export const PROFILE_SETTINGS_URL = '/api/profile/settings';
/** Multipart field names of `POST /me/profile/requests`. */
export const PROFILE_DATA_FIELD = 'data';
export const PROFILE_FILES_FIELD = 'files';

const enc = encodeURIComponent;

/** The multipart body of a request: the JSON `data` field first, then the files (multer reads fields in order). */
export function profileRequestFormData(request: NewProfileRequest, files: readonly File[]): FormData {
  const form = new FormData();
  form.append(PROFILE_DATA_FIELD, JSON.stringify(request));
  for (const file of files) form.append(PROFILE_FILES_FIELD, file, file.name);
  return form;
}

export function toProfileUploadEvent(event: HttpEvent<ProfileRequestView>, size: number): ProfileUploadEvent | null {
  switch (event.type) {
    case HttpEventType.Sent:
      return { kind: 'progress', loaded: 0, total: size };
    case HttpEventType.UploadProgress:
      return { kind: 'progress', loaded: event.loaded, total: event.total ?? null };
    case HttpEventType.Response:
      return event.body ? { kind: 'done', request: event.body } : null;
    default:
      return null;
  }
}

/** Query params of `GET /profile/requests`: empty filters left out, paging always sent. */
export function profileRequestParams(query: ProfileRequestQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.status) params['status'] = query.status;
  if (query.section) params['section'] = query.section;
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.employmentId) params['employmentId'] = query.employmentId;
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

@Injectable({ providedIn: 'root' })
export class ProfileApi {
  private readonly http = inject(HttpClient);
  private readonly uploads = inject(UPLOAD_HTTP_CLIENT);

  // --- Self-service (`profile.request_self`) ------------------------------------------------------------------------

  /** `GET /me/profile`. `enabled` false → no request. */
  myProfileResource(enabled: () => boolean = () => true): HttpResourceRef<MyProfileView | undefined> {
    return httpResource<MyProfileView>(() => (enabled() ? MY_PROFILE_BASE : undefined));
  }

  /** `GET /me/profile/requests?status=` — own requests, newest first. */
  myRequestsResource(
    enabled: () => boolean = () => true,
    status: () => ProfileRequestStatus | '' = () => '',
  ): HttpResourceRef<ProfileRequestList | undefined> {
    return httpResource<ProfileRequestList>(() => {
      if (!enabled()) return undefined;
      const value = status();
      const params: Record<string, string> = value ? { status: value } : {};
      return { url: `${MY_PROFILE_BASE}/requests`, params };
    });
  }

  /** `POST /me/profile/requests` (multipart) — progress events, then the created request. Unsubscribe to abort. */
  submit(request: NewProfileRequest, files: readonly File[] = []): Observable<ProfileUploadEvent> {
    const size = files.reduce((total, file) => total + file.size, 0);
    return this.uploads
      .post<ProfileRequestView>(`${MY_PROFILE_BASE}/requests`, profileRequestFormData(request, files), {
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        map((event) => toProfileUploadEvent(event, size)),
        filter((event): event is ProfileUploadEvent => event !== null),
      );
  }

  cancel(requestId: string): Observable<ProfileRequestView> {
    return this.http.post<ProfileRequestView>(`${MY_PROFILE_BASE}/requests/${enc(requestId)}/cancel`, {});
  }

  /** A file of one's own request (while it exists). */
  myFile(requestId: string, fileId: string): Observable<Blob> {
    return this.http.get(`${MY_PROFILE_BASE}/requests/${enc(requestId)}/files/${enc(fileId)}`, { responseType: 'blob' });
  }

  // --- HR (`employee.personal.read` / task candidates) --------------------------------------------------------------

  requestsResource(query: () => ProfileRequestQuery | undefined): HttpResourceRef<ProfileRequestPage | undefined> {
    return httpResource<ProfileRequestPage>(() => {
      const value = query();
      return value ? { url: PROFILE_REQUESTS_BASE, params: profileRequestParams(value) } : undefined;
    });
  }

  /** `GET /profile/requests/:id` (detail + history). */
  requestResource(id: () => string | null | undefined): HttpResourceRef<ProfileRequestDetail | undefined> {
    return httpResource<ProfileRequestDetail>(() => {
      const value = id();
      return value ? `${PROFILE_REQUESTS_BASE}/${enc(value)}` : undefined;
    });
  }

  request(id: string): Observable<ProfileRequestDetail> {
    return this.http.get<ProfileRequestDetail>(`${PROFILE_REQUESTS_BASE}/${enc(id)}`);
  }

  file(requestId: string, fileId: string): Observable<Blob> {
    return this.http.get(`${PROFILE_REQUESTS_BASE}/${enc(requestId)}/files/${enc(fileId)}`, { responseType: 'blob' });
  }

  // --- Settings (`profile.configure`) -------------------------------------------------------------------------------

  settingsResource(): HttpResourceRef<ProfileSettings | undefined> {
    return httpResource<ProfileSettings>(() => PROFILE_SETTINGS_URL);
  }

  updateSettings(body: ProfileSettings): Observable<ProfileSettings> {
    return this.http.put<ProfileSettings>(PROFILE_SETTINGS_URL, body);
  }

  // --- HR writes on an employee (`employee.personal.update`) --------------------------------------------------------

  updateContact(employmentId: string, body: ContactInput): Observable<PersonalView> {
    return this.http.put<PersonalView>(`/api/employees/${enc(employmentId)}/contact`, body);
  }

  /**
   * `null` removes the emergency contact: the JSON text `null` (that route's parser is non-strict). HttpClient sends
   * NO body for a `null` value, so the text is written out with its content type.
   */
  updateEmergencyContact(employmentId: string, body: EmergencyInput | null): Observable<PersonalView> {
    const url = `/api/employees/${enc(employmentId)}/emergency-contact`;
    if (body === null) return this.http.put<PersonalView>(url, 'null', { headers: { 'Content-Type': 'application/json' } });
    return this.http.put<PersonalView>(url, body);
  }

  /** The full children list: items with `id` updated, without created, missing ones deleted. */
  updateFamily(employmentId: string, body: FamilyInput): Observable<PersonalView> {
    return this.http.put<PersonalView>(`/api/employees/${enc(employmentId)}/family`, body);
  }
}
