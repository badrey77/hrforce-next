import { XhrFactory } from '@angular/common';
import { HttpEventType, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import { employeeFile, fakeFile, provideUploadsThroughTestingBackend } from '../../../testing/employee-file-fixtures';
import { isApiProblemError } from '../http/api-problem';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { UPLOAD_HTTP_CLIENT } from '../http/upload-http';
import { EmployeeFilesApi, toUploadEvent, uploadFormData } from './employee-files-api';
import type { UploadEvent } from './employee-files.models';

const FIELDS = { categoryId: 'c-diploma', title: 'Licence', documentDate: '2012-06-30', expiresOn: null };

describe('EmployeeFilesApi', () => {
  let api: EmployeeFilesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideUploadsThroughTestingBackend()],
    });
    api = TestBed.inject(EmployeeFilesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('builds the multipart body with the text fields BEFORE the file, empty dates left out', () => {
    const form = uploadFormData(FIELDS, fakeFile('licence.pdf', 'application/pdf'));
    expect([...form.keys()]).toEqual(['categoryId', 'title', 'documentDate', 'file']);
    expect((form.get('file') as File).name).toBe('licence.pdf');
  });

  it('maps HttpEvents to progress / done and ignores the others', () => {
    expect(toUploadEvent({ type: HttpEventType.Sent }, 100)).toEqual({ kind: 'progress', loaded: 0, total: 100 });
    expect(toUploadEvent({ type: HttpEventType.UploadProgress, loaded: 40, total: 100 }, 100)).toEqual({ kind: 'progress', loaded: 40, total: 100 });
    expect(toUploadEvent({ type: HttpEventType.UploadProgress, loaded: 40 }, 100)).toEqual({ kind: 'progress', loaded: 40, total: null });
    expect(toUploadEvent({ type: HttpEventType.DownloadProgress, loaded: 5 }, 100)).toBeNull();
  });

  it('uploads with progress events, then the created file; no Content-Type set by hand', async () => {
    const events = firstValueFrom(api.upload('e-1', FIELDS, fakeFile('licence.pdf', 'application/pdf', 100)).pipe(toArray()));
    const req = http.expectOne('/api/employees/e-1/files');
    expect(req.request.method).toBe('POST');
    expect(req.request.reportProgress).toBe(true);
    expect(req.request.body).toBeInstanceOf(FormData);
    expect(req.request.headers.has('Content-Type')).toBe(false);
    req.event({ type: HttpEventType.UploadProgress, loaded: 50, total: 100 });
    req.event({ type: HttpEventType.UploadProgress, loaded: 100, total: 100 });
    req.flush(employeeFile(), { status: 201, statusText: 'Created' });
    const all: UploadEvent[] = await events;
    expect(all.map((e) => (e.kind === 'progress' ? e.loaded : e.file.id))).toEqual([0, 50, 100, 'f-1']);
  });

  it('aborts the request when the subscriber unsubscribes', () => {
    const subscription = api.upload('e-1', FIELDS, fakeFile('a.pdf', 'application/pdf')).subscribe();
    const req = http.expectOne('/api/employees/e-1/files');
    subscription.unsubscribe();
    expect(req.cancelled).toBe(true);
  });

  it('downloads bytes as a Blob and deletes with a reason', async () => {
    let deleted = false;
    const content = firstValueFrom(api.content('e-1', 'f-1'));
    const req = http.expectOne('/api/employees/e-1/files/f-1/content');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF-1.7'], { type: 'application/pdf' }));
    expect(await (await content).text()).toBe('%PDF-1.7');

    api.delete('e-1', 'f-1', 'Doublon').subscribe(() => (deleted = true));
    const del = http.expectOne('/api/employees/e-1/files/f-1/delete');
    expect(del.request.method).toBe('POST');
    expect(del.request.body).toEqual({ reason: 'Doublon' });
    del.flush(null, { status: 204, statusText: 'No Content' });
    expect(deleted).toBe(true);
  });

  it('turns a 422 of the upload into an ApiProblemError with the file code', async () => {
    const result = lastValueFrom(api.upload('e-1', FIELDS, fakeFile('a.pdf', 'application/pdf')));
    http
      .expectOne('/api/employees/e-1/files')
      .flush(
        { type: 'urn:hrforce:problem:validation', title: 'Unprocessable', status: 422, errors: [{ field: 'file', code: 'too_large', message: 'x' }] },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    const error: unknown = await result.catch((e: unknown) => e);
    expect(isApiProblemError(error) && error.problem.errors?.[0]?.code).toBe('too_large');
  });
});

/**
 * The REAL upload client: an XHR-backed HttpClient in a child injector, with the app's XSRF and interceptors. A fake
 * `XhrFactory` in the root injector stands in for the browser (the child finds it by looking up to its parent).
 */
describe('UPLOAD_HTTP_CLIENT', () => {
  class FakeXhr {
    readonly headers: Record<string, string> = {};
    readonly listeners = new Map<string, ((event: unknown) => void)[]>();
    readonly upload = {
      listeners: new Map<string, ((event: unknown) => void)[]>(),
      addEventListener(type: string, fn: (event: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
      },
      removeEventListener(): void {},
    };
    readonly DONE = 4;
    readyState = 1;
    status = 0;
    statusText = '';
    response: unknown = null;
    responseType = '';
    responseURL = '';
    withCredentials = false;
    timeout = 0;
    method = '';
    url = '';
    body: unknown = null;
    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }
    addEventListener(type: string, fn: (event: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    removeEventListener(): void {}
    send(body: unknown): void {
      this.body = body;
    }
    abort(): void {}
    getAllResponseHeaders(): string {
      return 'content-type: application/json\r\n';
    }
    fire(type: string, event: unknown = {}): void {
      for (const fn of this.listeners.get(type) ?? []) fn(event);
    }
  }

  afterEach(() => {
    document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  });

  it('sends through XMLHttpRequest with the XSRF header and reports upload progress', async () => {
    const xhr = new FakeXhr();
    TestBed.configureTestingModule({ providers: [{ provide: XhrFactory, useValue: { build: () => xhr } }] });
    document.cookie = 'XSRF-TOKEN=token-123';
    const client = TestBed.inject(UPLOAD_HTTP_CLIENT);

    const events: number[] = [];
    const done = new Promise<void>((resolve, reject) =>
      client.post('/api/employees/e-1/files', new FormData(), { reportProgress: true, observe: 'events' }).subscribe({
        next: (event) => events.push(event.type),
        complete: resolve,
        error: reject,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve));
    expect(xhr.method).toBe('POST');
    expect(xhr.headers['X-XSRF-TOKEN']).toBe('token-123');
    expect(xhr.upload.listeners.get('progress')).toHaveLength(1);

    xhr.upload.listeners.get('progress')?.[0]?.({ loaded: 5, total: 10, lengthComputable: true });
    xhr.status = 201;
    xhr.statusText = 'Created';
    xhr.readyState = 4;
    xhr.response = JSON.stringify(employeeFile());
    xhr.fire('load');
    await done;
    expect(events).toEqual([HttpEventType.Sent, HttpEventType.UploadProgress, HttpEventType.Response]);
  });
});
