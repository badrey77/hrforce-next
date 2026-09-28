import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { DOCUMENT_TYPES, documentRequest, issuedDocument, UNIT_ANNABA } from '../../../testing/document-fixtures';
import { PERSON } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { MyDocumentsPage } from './my-documents.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const EMPLOYMENT = { id: 'e-1', matricule: 'EMP-0001', person: PERSON, unit: UNIT_ANNABA, jobTitle: 'Agent', hireDate: '2024-03-01' };

describe('MyDocumentsPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'me/documents', component: MyDocumentsPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    // An employee holding only the documents self-service permission: /me/employment is still asked.
    TestBed.inject(Session).set(meWith(['document.request_self']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(url = '/me/documents', mine = { documents: [issuedDocument()], requests: [documentRequest()] }): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne('/api/documents/types').flush({ items: DOCUMENT_TYPES });
    http.expectOne('/api/me/employment').flush(EMPLOYMENT);
    await settle();
    http.expectOne('/api/me/documents').flush(mine);
    await settle();
    // The approval stepper names steps through LeaveCatalog (shared/workflow-stepper).
    for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
    await settle();
  }

  it('offers only self-service types, sends a request, and reloads the lists', async () => {
    await open();
    const options = [...el().querySelectorAll('#request-type option')].map((o) => o.textContent?.trim());
    expect(options).toEqual(['Attestation de travail']);
    const purpose = el().querySelector('#request-purpose') as HTMLInputElement;
    purpose.value = ' Dossier de prêt ';
    purpose.dispatchEvent(new Event('input'));
    (el().querySelector('[data-action="request"]') as HTMLButtonElement).click();
    const req = http.expectOne('/api/me/documents/requests');
    expect(req.request.body).toEqual({ typeCode: 'attestation_travail', language: 'fr', purpose: 'Dossier de prêt' });
    req.flush(documentRequest());
    await settle();
    expect(el().querySelector('.feedback')?.textContent).toContain('Demande envoyée');
    http.expectOne('/api/me/documents').flush({ documents: [], requests: [] });
    await settle();
  });

  it('explains a pending request (409) above the form', async () => {
    await open();
    (el().querySelector('[data-action="request"]') as HTMLButtonElement).click();
    http
      .expectOne('/api/me/documents/requests')
      .flush({ type: 'urn:hrforce:problem:document-request-pending', title: 'Conflict', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().querySelector('[data-form="request"] .form-error')?.textContent).toContain('déjà une demande en attente');
  });

  it('lists my requests with their stepper, my documents with Open/Download, and highlights ?document=', async () => {
    await open('/me/documents?document=d-1');
    expect(el().querySelector('[data-request="dr-1"] app-workflow-stepper')).not.toBeNull();
    const doc = el().querySelector('[data-document="d-1"]');
    expect(doc?.querySelector('[data-action="open-pdf"]')).not.toBeNull();
    expect(doc?.classList).toContain('highlight');
    expect(doc?.getAttribute('aria-current')).toBe('true');
  });

  it('cancels a pending request after confirmation', async () => {
    await open();
    (el().querySelector('[data-request="dr-1"] [data-action="cancel"]') as HTMLButtonElement).click();
    await settle();
    (el().querySelector('[data-action="confirm-cancel"]') as HTMLButtonElement).click();
    http.expectOne('/api/me/documents/requests/dr-1/cancel').flush(documentRequest({ status: 'cancelled', _actions: [] }));
    await settle();
    http.expectOne('/api/me/documents').flush({ documents: [], requests: [documentRequest({ status: 'cancelled', _actions: [] })] });
    await settle();
    expect(el().querySelector('[data-request="dr-1"] [data-action="cancel"]')).toBeNull();
  });
});
