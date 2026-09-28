import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { isApiProblemError } from '../http/api-problem';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { DocumentsApi, documentListParams } from './documents-api';
import { DEFAULT_DOCUMENT_QUERY } from './documents.models';

describe('DocumentsApi', () => {
  let api: DocumentsApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(DocumentsApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sends only the filters that are set, and always the paging', () => {
    expect(documentListParams(DEFAULT_DOCUMENT_QUERY)).toEqual({ page: '1', pageSize: '25' });
    expect(
      documentListParams({ ...DEFAULT_DOCUMENT_QUERY, q: ' ATT ', typeCode: 'titre_conge', status: 'void', unitId: 'u-1', includeSubUnits: false, leaveRequestId: 'r-1' }),
    ).toEqual({ q: 'ATT', typeCode: 'titre_conge', status: 'void', unitId: 'u-1', includeSubUnits: 'false', leaveRequestId: 'r-1', page: '1', pageSize: '25' });
  });

  it('fetches a PDF as a Blob with the disposition', async () => {
    const result = firstValueFrom(api.pdf('d-1', 'inline'));
    const req = http.expectOne((r) => r.url === '/api/documents/d-1/pdf');
    expect(req.request.params.get('disposition')).toBe('inline');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF-1.7'], { type: 'application/pdf' }));
    const blob = await result;
    expect(blob.type).toBe('application/pdf');
    expect(await blob.text()).toBe('%PDF-1.7');
  });

  it('turns a problem+json error of a blob request into an ApiProblemError with its slug', async () => {
    const result = firstValueFrom(api.preview({ typeCode: 'attestation_travail', employmentId: 'e-1', language: 'ar' }));
    const req = http.expectOne('/api/documents/preview');
    expect(req.request.method).toBe('POST');
    const body = JSON.stringify({ type: 'urn:hrforce:problem:document-profile-incomplete', title: 'Conflict', status: 409, errors: [{ field: 'legalNameAr', code: 'required', message: 'x' }] });
    req.flush(new Blob([body], { type: 'application/problem+json' }), { status: 409, statusText: 'Conflict' });
    const error: unknown = await result.catch((e: unknown) => e);
    expect(isApiProblemError(error)).toBe(true);
    if (!isApiProblemError(error)) return;
    expect(error.problem.type).toBe('urn:hrforce:problem:document-profile-incomplete');
    expect(error.problem.errors?.[0]?.field).toBe('legalNameAr');
  });

  it('uploads the logo as multipart FormData without setting Content-Type by hand', () => {
    api.uploadLogo(new Blob(['png'], { type: 'image/png' }), 'logo.png').subscribe();
    const req = http.expectOne('/api/documents/settings/profile/logo');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toBeInstanceOf(FormData);
    expect((req.request.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(req.request.headers.has('Content-Type')).toBe(false);
    req.flush({});
  });
});
