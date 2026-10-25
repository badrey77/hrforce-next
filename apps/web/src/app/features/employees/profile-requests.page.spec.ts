import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { profileRequest } from '../../../testing/profile-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { DEFAULT_PROFILE_REQUEST_QUERY } from '../../core/profile/profile.models';
import { EMPLOYEES_ROUTES } from './employees.routes';
import { REQUEST_SEARCH_DEBOUNCE_MS } from './profile-requests.page';
import { resolveRequestQuery, toRequestQueryParams } from './profile-requests-state';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const REQUESTS = '/api/profile/requests';

describe('profile request list state', () => {
  it('parses the URL defensively; pending is the default, « all » is explicit', () => {
    expect(resolveRequestQuery({})).toEqual(DEFAULT_PROFILE_REQUEST_QUERY);
    expect(resolveRequestQuery({ status: 'all', section: 'family', page: '2', pageSize: '500', includeSubUnits: 'false', unitId: 'u-1' })).toEqual({
      ...DEFAULT_PROFILE_REQUEST_QUERY,
      status: '',
      section: 'family',
      page: 2,
      includeSubUnits: false,
      unitId: 'u-1',
    });
    expect(resolveRequestQuery({ status: 'nope', section: 'salary' })).toEqual(DEFAULT_PROFILE_REQUEST_QUERY);
    expect(toRequestQueryParams({ status: '', page: 1, section: 'bank', q: '' })).toEqual({ status: 'all', page: null, section: 'bank', q: null });
    expect(toRequestQueryParams({ status: 'pending' })).toEqual({ status: null });
  });
});

describe('ProfileRequestsPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function setup(permissions: readonly string[]): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'employees', children: EMPLOYEES_ROUTES }, { path: '**', children: [] }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
  }

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();

  async function answer(items = [profileRequest()], total = items.length) {
    await settle();
    const req = http.expectOne((r) => r.url === REQUESTS);
    req.flush({ items, total, page: 1, pageSize: 50 });
    await settle();
    return req.request;
  }

  it('is not found without employee.personal.read (the :id route is not tried)', async () => {
    await setup(['employee.read']);
    await harness.navigateByUrl('/employees/profile-requests');
    await settle();
    http.expectNone((r) => r.url.startsWith('/api/employees/'));
    http.expectNone((r) => r.url === REQUESTS);
  });

  it('lists the pending requests by default with employee, section, fields and status; no values in the row', async () => {
    await setup(['employee.read', 'employee.personal.read']);
    await harness.navigateByUrl('/employees/profile-requests');
    const request = await answer();
    expect(request.params.get('status')).toBe('pending');
    expect(request.params.get('pageSize')).toBe('50');
    const row = text('[data-request="pr-1"]') ?? '';
    expect(row).toContain('Haddad');
    expect(row).toContain('EMP-0031');
    expect(row).toContain('Situation familiale');
    expect(row).toContain('Enfants à charge');
    expect(row).toContain('En attente');
    expect(row).not.toContain('Lina');
    expect(el().querySelector('[data-link="employee"]')?.getAttribute('href')).toBe('/employees/emp-31?tab=personal');
    // bank is only offered to bank readers
    expect(el().querySelector('#pr-section option[value="bank"]')).toBeNull();

    (el().querySelector('[data-action="toggle-request"]') as HTMLElement).click();
    await settle();
    expect(el().querySelector('[data-child-diff="added"]')?.textContent).toContain('Lina');
    expect(el().querySelector('[data-link="tasks"]')).not.toBeNull();
  });

  it('keeps the filters in the URL', async () => {
    await setup(['employee.read', 'employee.personal.read', 'employee.bank.read']);
    await harness.navigateByUrl('/employees/profile-requests?status=all&section=bank');
    const first = await answer([]);
    expect(first.params.has('status')).toBe(false);
    expect(first.params.get('section')).toBe('bank');
    expect(text('[data-state="empty"]')).toBe('Aucune demande ne correspond aux filtres.');

    const status = el().querySelector('#pr-status') as HTMLSelectElement;
    status.value = 'rejected';
    status.dispatchEvent(new Event('change'));
    const second = await answer([profileRequest({ status: 'rejected', rejectionComment: 'Pièce illisible' })]);
    expect(second.params.get('status')).toBe('rejected');
    expect(TestBed.inject(Router).url).toContain('status=rejected');

    const search = el().querySelector('#pr-q') as HTMLInputElement;
    search.value = 'Haddad';
    search.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SEARCH_DEBOUNCE_MS + 20));
    const third = await answer();
    expect(third.params.get('q')).toBe('Haddad');

    (el().querySelector('[data-action="clear"]') as HTMLElement).click();
    const fourth = await answer();
    expect(fourth.params.get('status')).toBe('pending');
    expect(fourth.params.has('q')).toBe(false);
  });

  it('shows a load error with retry', async () => {
    await setup(['employee.read', 'employee.personal.read']);
    await harness.navigateByUrl('/employees/profile-requests');
    await settle();
    http.expectOne((r) => r.url === REQUESTS).flush({ type: 'about:blank', title: 'x', status: 500 }, { status: 500, statusText: 'x' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('Impossible de charger les demandes de modification.');
  });
});
