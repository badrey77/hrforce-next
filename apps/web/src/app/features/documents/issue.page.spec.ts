import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { DOCUMENT_TYPES, issuedDocument, SIGNATORY_DG, SIGNATORY_EST, UNIT_ANNABA } from '../../../testing/document-fixtures';
import { leaveSummary, PERSON } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { IssuePage } from './issue.page';

@Component({ template: '' })
class Stub {}

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const EMPLOYEE = {
  id: 'e-1',
  matricule: 'EMP-0001',
  person: { ...PERSON, id: 'p-1' },
  unit: UNIT_ANNABA,
  site: null,
  jobTitle: 'Agent',
  hireDate: '2020-01-01',
  endDate: null,
  status: 'active',
  assignments: [],
  endReason: null,
  _redacted: [],
  _actions: [],
};

describe('IssuePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter(
          [
            { path: 'documents/new', component: IssuePage },
            { path: 'documents/:id', component: Stub },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['document.read', 'document.issue', 'leave.read', 'employee.read']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;

  /** Answers the reference data the page asks for, whatever the order. */
  async function answerAll(extra: (req: TestRequest) => boolean = () => false): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await settle();
      for (const req of http.match(() => true)) {
        if (req.cancelled) continue;
        const url = req.request.url;
        if (extra(req)) continue;
        if (url === '/api/documents/types') req.flush({ items: DOCUMENT_TYPES });
        else if (url === '/api/leave/types') req.flush({ items: [] });
        else if (url === '/api/employees/e-1') req.flush(EMPLOYEE);
        else if (url === '/api/documents/signatories') req.flush({ items: [SIGNATORY_EST, SIGNATORY_DG] });
        else if (url === '/api/leave/requests') req.flush({ items: [leaveSummary({ id: 'r-9', status: 'approved', employee: { ...leaveSummary().employee, id: 'e-1' } })], total: 1, page: 1, pageSize: 100 });
      }
    }
  }

  function click(action: string): void {
    (el().querySelector(`[data-action="${action}"]`) as HTMLButtonElement).click();
  }

  it('preselects the first active type, the employee from ?employee=, French and the nearest signatory', async () => {
    await harness.navigateByUrl('/documents/new?employee=e-1');
    await answerAll();
    expect((el().querySelector('#issue-type') as HTMLSelectElement).value).toBe('attestation_travail');
    expect((el().querySelector('#issue-lang-fr') as HTMLInputElement).checked).toBe(true);
    // SIGNATORY_EST is the default for titre_conge only; the nearest (first) one is proposed for an attestation.
    expect((el().querySelector('#issue-signatory') as HTMLSelectElement).value).toBe('s-est');
    expect(el().querySelector('#issue-leave')).toBeNull();
  });

  it('issues with a clientRequestId, reuses it on a retry, and opens the detail page', async () => {
    await harness.navigateByUrl('/documents/new?employee=e-1');
    await answerAll();

    click('issue');
    const first = http.expectOne('/api/documents');
    const body = first.request.body as Record<string, unknown>;
    expect(body).toMatchObject({ typeCode: 'attestation_travail', employmentId: 'e-1', language: 'fr', signatoryId: 's-est' });
    expect(body['leaveRequestId']).toBeUndefined();
    expect(typeof body['clientRequestId']).toBe('string');
    first.flush(null, { status: 0, statusText: 'Unknown Error' });
    await settle();
    expect(el().querySelector('[data-error="form"]')?.textContent).toContain('Impossible de joindre le serveur');

    click('issue');
    const retry = http.expectOne('/api/documents');
    expect((retry.request.body as Record<string, unknown>)['clientRequestId']).toBe(body['clientRequestId']);
    retry.flush(issuedDocument({ id: 'd-7' }));
    await settle();
    expect(TestBed.inject(Router).url).toBe('/documents/d-7?issued=1');
  });

  it('for a titre de congé lists the employee’s approved requests and sends leaveRequestId only', async () => {
    await harness.navigateByUrl('/documents/new?type=titre_conge&employee=e-1&leaveRequest=r-9');
    await answerAll((req) => {
      if (req.request.url !== '/api/leave/requests') return false;
      expect(req.request.params.get('status')).toBe('approved');
      expect(req.request.params.get('q')).toBe('EMP-0001');
      return false;
    });
    expect((el().querySelector('#issue-type') as HTMLSelectElement).value).toBe('titre_conge');
    expect((el().querySelector('#issue-leave') as HTMLSelectElement).value).toBe('r-9');
    expect((el().querySelector('#issue-signatory') as HTMLSelectElement).value).toBe('s-est'); // default for titre

    click('issue');
    const req = http.expectOne('/api/documents');
    expect(req.request.body).toMatchObject({ typeCode: 'titre_conge', leaveRequestId: 'r-9' });
    expect((req.request.body as Record<string, unknown>)['employmentId']).toBeUndefined();
    req.flush(issuedDocument());
    await settle();
  });

  it('explains an incomplete letterhead with the missing fields (preview answers a Blob problem)', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    await harness.navigateByUrl('/documents/new?employee=e-1');
    await answerAll();
    click('preview');
    const req = http.expectOne('/api/documents/preview');
    const problem = JSON.stringify({
      type: 'urn:hrforce:problem:document-profile-incomplete',
      title: 'Conflict',
      status: 409,
      errors: [{ field: 'legalNameAr', code: 'required', message: 'x' }],
    });
    req.flush(new Blob([problem], { type: 'application/problem+json' }), { status: 409, statusText: 'Conflict' });
    await settle();
    await settle();
    const banner = el().querySelector('[data-error="profile-incomplete"]');
    expect(banner?.textContent).toContain('Raison sociale (arabe)');
    expect(banner?.textContent).toContain('administrateur RH central'); // no document.configure: ask the admin
    vi.restoreAllMocks();
  });

  it('puts a business-rule slug on its field', async () => {
    await harness.navigateByUrl('/documents/new?employee=e-1');
    await answerAll();
    click('issue');
    http
      .expectOne('/api/documents')
      .flush({ type: 'urn:hrforce:problem:document-employment-ended', title: 'Conflict', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().querySelector('[data-error="employmentId"]')?.textContent).toContain('certificat de travail');
  });
});
