import { HttpClient, type HttpEvent, HttpEventType, type HttpResourceRef, httpResource } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { filter, map, type Observable } from 'rxjs';
import { UPLOAD_HTTP_CLIENT } from '../http/upload-http';
import type { AppLanguage } from '../i18n/languages';
import type { Labels } from '../leave/leave.models';
import {
  type ApplicationDetailView,
  type ApplicationPage,
  type ApplicationPatch,
  type BoardView,
  type CandidateFileView,
  type CandidatePatch,
  type CandidateQuery,
  type CandidateUploadEvent,
  type CandidateView,
  candidateParams,
  type FileKind,
  type MatchQuery,
  type MatchResult,
  type MoveInput,
  type MyOpeningDetailView,
  type MyOpeningList,
  type MySummaryView,
  type NewApplication,
  type NewOpening,
  type NoteView,
  type OpeningDetailView,
  type OpeningPage,
  type OpeningPatch,
  type OpeningQuery,
  openingParams,
  type PolicyInput,
  type PolicyView,
  type ReasonList,
  type ReasonPatch,
  type ReasonView,
  type Stage,
  type SummaryView,
} from './recruitment.models';

export const RECRUITMENT_API_BASE = '/api/recruitment';
export const ME_RECRUITMENT_BASE = '/api/me/recruitment';

const enc = encodeURIComponent;

export function toCandidateUploadEvent(event: HttpEvent<CandidateFileView>, size: number): CandidateUploadEvent | null {
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
export class RecruitmentApi {
  private readonly http = inject(HttpClient);
  private readonly uploads = inject(UPLOAD_HTTP_CLIENT);

  // --- Openings ---

  openingsResource(query: () => OpeningQuery | undefined): HttpResourceRef<OpeningPage | undefined> {
    return httpResource<OpeningPage>(() => {
      const value = query();
      return value ? { url: `${RECRUITMENT_API_BASE}/openings`, params: openingParams(value) } : undefined;
    });
  }

  openingResource(id: () => string | undefined): HttpResourceRef<OpeningDetailView | undefined> {
    return httpResource<OpeningDetailView>(() => {
      const value = id();
      return value ? `${RECRUITMENT_API_BASE}/openings/${enc(value)}` : undefined;
    });
  }

  summaryResource(enabled: () => boolean): HttpResourceRef<SummaryView | undefined> {
    return httpResource<SummaryView>(() => (enabled() ? `${RECRUITMENT_API_BASE}/summary` : undefined));
  }

  requestOpening(body: NewOpening): Observable<OpeningDetailView> {
    return this.http.post<OpeningDetailView>(`${RECRUITMENT_API_BASE}/openings`, body);
  }

  updateOpening(id: string, body: OpeningPatch): Observable<OpeningDetailView> {
    return this.http.patch<OpeningDetailView>(`${RECRUITMENT_API_BASE}/openings/${enc(id)}`, body);
  }

  closeOpening(id: string, reason: string): Observable<OpeningDetailView> {
    return this.http.post<OpeningDetailView>(`${RECRUITMENT_API_BASE}/openings/${enc(id)}/close`, { reason });
  }

  reopenOpening(id: string): Observable<OpeningDetailView> {
    return this.http.post<OpeningDetailView>(`${RECRUITMENT_API_BASE}/openings/${enc(id)}/reopen`, null);
  }

  // --- The caller's own openings (requester / head view) ---

  mySummaryResource(enabled: () => boolean): HttpResourceRef<MySummaryView | undefined> {
    return httpResource<MySummaryView>(() => (enabled() ? `${ME_RECRUITMENT_BASE}/summary` : undefined));
  }

  myOpeningsResource(): HttpResourceRef<MyOpeningList | undefined> {
    return httpResource<MyOpeningList>(() => `${ME_RECRUITMENT_BASE}/openings`);
  }

  myOpeningResource(id: () => string | undefined): HttpResourceRef<MyOpeningDetailView | undefined> {
    return httpResource<MyOpeningDetailView>(() => {
      const value = id();
      return value ? `${ME_RECRUITMENT_BASE}/openings/${enc(value)}` : undefined;
    });
  }

  cancelMyOpening(id: string): Observable<MyOpeningDetailView> {
    return this.http.post<MyOpeningDetailView>(`${ME_RECRUITMENT_BASE}/openings/${enc(id)}/cancel`, null);
  }

  myFileContent(applicationId: string, fileId: string): Observable<Blob> {
    return this.http.get(`${ME_RECRUITMENT_BASE}/applications/${enc(applicationId)}/files/${enc(fileId)}/content`, {
      responseType: 'blob',
    });
  }

  // --- Candidates and applications ---

  match(body: MatchQuery): Observable<MatchResult> {
    return this.http.post<MatchResult>(`${RECRUITMENT_API_BASE}/candidates/match`, body);
  }

  candidatesResource(
    query: () => CandidateQuery | undefined,
    lang: () => AppLanguage | null = () => null,
  ): HttpResourceRef<ApplicationPage | undefined> {
    return httpResource<ApplicationPage>(() => {
      const value = query();
      return value ? { url: `${RECRUITMENT_API_BASE}/candidates`, params: candidateParams(value, lang()) } : undefined;
    });
  }

  candidateResource(id: () => string | undefined): HttpResourceRef<CandidateView | undefined> {
    return httpResource<CandidateView>(() => {
      const value = id();
      return value ? `${RECRUITMENT_API_BASE}/candidates/${enc(value)}` : undefined;
    });
  }

  updateCandidate(id: string, body: CandidatePatch): Observable<CandidateView> {
    return this.http.patch<CandidateView>(`${RECRUITMENT_API_BASE}/candidates/${enc(id)}`, body);
  }

  linkPerson(id: string, personId: string | null): Observable<CandidateView> {
    return this.http.put<CandidateView>(`${RECRUITMENT_API_BASE}/candidates/${enc(id)}/person`, { personId });
  }

  eraseCandidate(id: string): Observable<void> {
    return this.http.post<void>(`${RECRUITMENT_API_BASE}/candidates/${enc(id)}/erase`, null);
  }

  addApplication(openingId: string, body: NewApplication): Observable<ApplicationDetailView> {
    return this.http.post<ApplicationDetailView>(`${RECRUITMENT_API_BASE}/openings/${enc(openingId)}/applications`, body);
  }

  boardResource(id: () => string | undefined, includeFinal: () => boolean): HttpResourceRef<BoardView | undefined> {
    return httpResource<BoardView>(() => {
      const value = id();
      if (!value) return undefined;
      const params: Record<string, string> = includeFinal() ? { includeFinal: 'true' } : {};
      return { url: `${RECRUITMENT_API_BASE}/openings/${enc(value)}/board`, params };
    });
  }

  board(id: string, includeFinal: boolean): Observable<BoardView> {
    const params: Record<string, string> = includeFinal ? { includeFinal: 'true' } : {};
    return this.http.get<BoardView>(`${RECRUITMENT_API_BASE}/openings/${enc(id)}/board`, { params });
  }

  applicationResource(id: () => string | undefined): HttpResourceRef<ApplicationDetailView | undefined> {
    return httpResource<ApplicationDetailView>(() => {
      const value = id();
      return value ? `${RECRUITMENT_API_BASE}/applications/${enc(value)}` : undefined;
    });
  }

  updateApplication(id: string, body: ApplicationPatch): Observable<ApplicationDetailView> {
    return this.http.patch<ApplicationDetailView>(`${RECRUITMENT_API_BASE}/applications/${enc(id)}`, body);
  }

  move(id: string, body: MoveInput): Observable<ApplicationDetailView> {
    return this.http.post<ApplicationDetailView>(`${RECRUITMENT_API_BASE}/applications/${enc(id)}/move`, body);
  }

  reopenApplication(id: string, expectedStage: Stage): Observable<ApplicationDetailView> {
    return this.http.post<ApplicationDetailView>(`${RECRUITMENT_API_BASE}/applications/${enc(id)}/reopen`, { expectedStage });
  }

  addNote(applicationId: string, body: string): Observable<NoteView> {
    return this.http.post<NoteView>(`${RECRUITMENT_API_BASE}/applications/${enc(applicationId)}/notes`, { body });
  }

  deleteNote(applicationId: string, noteId: string): Observable<void> {
    return this.http.delete<void>(`${RECRUITMENT_API_BASE}/applications/${enc(applicationId)}/notes/${enc(noteId)}`);
  }

  // --- Candidate files ---

  uploadFile(candidateId: string, fields: { readonly kind: FileKind; readonly title: string }, file: File): Observable<CandidateUploadEvent> {
    const form = new FormData();
    form.append('kind', fields.kind);
    form.append('title', fields.title);
    form.append('file', file, file.name);
    return this.uploads
      .post<CandidateFileView>(`${RECRUITMENT_API_BASE}/candidates/${enc(candidateId)}/files`, form, {
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        map((event) => toCandidateUploadEvent(event, file.size)),
        filter((event): event is CandidateUploadEvent => event !== null),
      );
  }

  fileContent(candidateId: string, fileId: string): Observable<Blob> {
    return this.http.get(`${RECRUITMENT_API_BASE}/candidates/${enc(candidateId)}/files/${enc(fileId)}/content`, {
      responseType: 'blob',
    });
  }

  deleteFile(candidateId: string, fileId: string): Observable<void> {
    return this.http.delete<void>(`${RECRUITMENT_API_BASE}/candidates/${enc(candidateId)}/files/${enc(fileId)}`);
  }

  // --- Settings ---

  policyResource(enabled: () => boolean = () => true): HttpResourceRef<PolicyView | undefined> {
    return httpResource<PolicyView>(() => (enabled() ? `${RECRUITMENT_API_BASE}/policy` : undefined));
  }

  updatePolicy(body: PolicyInput): Observable<PolicyView> {
    return this.http.put<PolicyView>(`${RECRUITMENT_API_BASE}/policy`, body);
  }

  reasonsResource(enabled: () => boolean = () => true): HttpResourceRef<ReasonList | undefined> {
    return httpResource<ReasonList>(() => (enabled() ? `${RECRUITMENT_API_BASE}/rejection-reasons` : undefined));
  }

  createReason(body: { readonly code: string; readonly labels: Labels }): Observable<ReasonView> {
    return this.http.post<ReasonView>(`${RECRUITMENT_API_BASE}/rejection-reasons`, body);
  }

  updateReason(id: string, body: ReasonPatch): Observable<ReasonView> {
    return this.http.put<ReasonView>(`${RECRUITMENT_API_BASE}/rejection-reasons/${enc(id)}`, body);
  }
}
