import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { issuedDocument, problemBlob } from '../../../testing/document-fixtures';
import { installIntersectionObserver, untilDeferredRequest } from '../../../testing/intersection-observer';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { DocumentDetailPage } from './document-detail.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('DocumentDetailPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
    installIntersectionObserver();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'documents/:id', component: DocumentDetailPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['document.read', 'document.void', 'employee.read']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(url = '/documents/d-1', doc = issuedDocument()): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne('/api/documents/d-1').flush(doc);
    await settle();
  }

  it('shows the facts, a short hash and, after issuing, the call to action', async () => {
    await open('/documents/d-1?issued=1');
    expect(el().querySelector('[data-field="number"]')?.textContent).toBe('ATT-2026-00042');
    expect(el().querySelector('[data-field="hash"]')?.textContent).toBe('ab12cd34ef56…');
    expect(el().querySelector('[data-field="hash"]')?.getAttribute('title')).toHaveLength(64);
    expect(el().querySelector('[data-field="signatory"]')?.textContent).toContain('Nadia Rahmani');
    expect(el().querySelector('[data-state="issued"]')?.textContent).toContain('Document ATT-2026-00042 émis');
  });

  it('opens the stored PDF in a tab opened during the click', async () => {
    const tab = { closed: false, opener: {}, close: vi.fn(), location: { href: '' } };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/pdf');
    URL.revokeObjectURL = vi.fn();
    await open();
    (el().querySelector('[data-action="open-pdf"]') as HTMLButtonElement).click();
    const req = http.expectOne((r) => r.url === '/api/documents/d-1/pdf');
    expect(req.request.params.get('disposition')).toBe('inline');
    req.flush(new Blob(['%PDF'], { type: 'application/pdf' }));
    await settle();
    expect(tab.location.href).toBe('blob:http://localhost/pdf');
  });

  it('explains a PDF that is gone (problem read out of the error Blob)', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await open();
    (el().querySelector('[data-action="download-pdf"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.url === '/api/documents/d-1/pdf').flush(problemBlob('not-found', 404), { status: 404, statusText: 'Not Found' });
    await settle();
    await settle();
    expect(el().querySelector('[data-error="pdf"]')?.textContent).toContain('pas disponible');
  });

  it('voids with a required reason, then reloads; no Void button without the server action', async () => {
    await open();
    (el().querySelector('[data-action="void"]') as HTMLButtonElement).click();
    await settle();
    (el().querySelector('[data-action="confirm-void"]') as HTMLButtonElement).click();
    await settle();
    expect(el().querySelector('[data-error="reason"]')).not.toBeNull();
    http.expectNone('/api/documents/d-1/void');

    const textarea = el().querySelector('#void-reason') as HTMLTextAreaElement;
    textarea.value = 'Erreur de langue';
    textarea.dispatchEvent(new Event('input'));
    (el().querySelector('[data-action="confirm-void"]') as HTMLButtonElement).click();
    const req = http.expectOne('/api/documents/d-1/void');
    expect(req.request.body).toEqual({ reason: 'Erreur de langue' });
    req.flush(issuedDocument({ status: 'void' }));
    await settle();
    http.expectOne('/api/documents/d-1').flush(
      issuedDocument({ status: 'void', _actions: [], void: { at: '2026-09-28T10:00:00Z', by: { id: 'u-amina', displayName: 'Amina Benali' }, reason: 'Erreur de langue' } }),
    );
    await settle();
    expect(el().querySelector('[data-state="void"]')?.textContent).toContain('Erreur de langue');
    expect(el().querySelector('[data-action="void"]')).toBeNull();
  });

  it('History tab loads the issued_document timeline', async () => {
    await open();
    (el().querySelector('[data-tab="history"]') as HTMLButtonElement).click();
    const req = await untilDeferredRequest(http, (r) => r.url === '/api/audit/timeline', settle);
    expect(req.request.params.get('subject')).toBe('issued_document:d-1');
    req.flush({ items: [], nextCursor: null });
    await settle();
  });

  it('reads 404 as not found, without a retry', async () => {
    await harness.navigateByUrl('/documents/d-1');
    await settle();
    http.expectOne('/api/documents/d-1').flush({ type: 'about:blank', title: 'Not found', status: 404 }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(el().textContent).toContain('Document introuvable');
    expect(el().querySelector('.form-error button')).toBeNull();
  });
});
