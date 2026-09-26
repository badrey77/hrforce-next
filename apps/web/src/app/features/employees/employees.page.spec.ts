import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ME_FIXTURE, meWith } from '../../../testing/auth-fixtures';
import { listItem, page, UNIT_ANNABA } from '../../../testing/employee-fixtures';
import { ORG_KIND_LIST, SITES } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { EMPLOYEE_SEARCH_DEBOUNCE_MS } from './employees.page';
import { EMPLOYEES_ROUTES } from './employees.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const isList = (r: { url: string }) => r.url === '/api/employees';

describe('EmployeesPage (URL as state)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'employees', children: EMPLOYEES_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    TestBed.inject(Session).set(ME_FIXTURE);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const rows = () => [...el().querySelectorAll('tbody tr')];
  const params = () => router.parseUrl(router.url).queryParams;
  const header = (key: string) => el().querySelector(`[data-sort="${key}"]`) as HTMLButtonElement;

  /** First visit: the list, and the reference data the filter bar needs (kinds for the picker, sites). */
  async function open(url: string, answer = page([listItem()])): Promise<TestRequest> {
    await harness.navigateByUrl(url);
    await settle();
    const req = http.expectOne(isList);
    req.flush(answer);
    http.match('/api/org/kinds').forEach((r) => r.flush(ORG_KIND_LIST));
    http.match((r) => r.url === '/api/org/sites').forEach((r) => r.flush({ items: SITES }));
    await settle();
    return req;
  }

  async function flushList(answer = page([listItem()])): Promise<TestRequest> {
    await settle();
    const req = http.expectOne(isList);
    req.flush(answer);
    await settle();
    return req;
  }

  it('reads every filter from the query params and sends them to the API', async () => {
    const req = await open('/employees?q=ben&siteId=s-cne&status=all&sort=hireDate&dir=desc&page=2&pageSize=50');
    expect(req.request.params.get('q')).toBe('ben');
    expect(req.request.params.get('siteId')).toBe('s-cne');
    expect(req.request.params.get('status')).toBe('all');
    expect(req.request.params.get('sort')).toBe('hireDate');
    expect(req.request.params.get('dir')).toBe('desc');
    expect(req.request.params.get('page')).toBe('2');
    expect(req.request.params.get('pageSize')).toBe('50');

    expect((el().querySelector('#employees-q') as HTMLInputElement).value).toBe('ben');
    expect((el().querySelector('#employees-status') as HTMLSelectElement).value).toBe('all');
    expect((el().querySelector('#employees-site') as HTMLSelectElement).value).toBe('s-cne');
    expect(el().querySelector('th[aria-sort]')?.textContent).toContain("Date d'embauche");
    expect(el().querySelector('th[aria-sort]')?.getAttribute('aria-sort')).toBe('descending');
  });

  it('renders rows (names in Arabic in the Arabic UI) and links to the detail', async () => {
    await open('/employees');
    const cells = () => [...rows()[0]?.querySelectorAll('td') ?? []].map((td) => td.textContent?.trim());
    expect(cells().slice(0, 3)).toEqual(['EMP-0001', 'BENALI Amina', 'Agence Annaba']);
    expect(rows()[0]?.querySelector('a')?.getAttribute('href')).toBe('/employees/e-1');
    expect(el().querySelector('[role="status"]')?.textContent).toContain('1 employé(s)');

    TestBed.inject(LanguageService).use('ar', { remember: false });
    await settle();
    expect(cells().slice(1, 3)).toEqual(['بن علي أمينة', UNIT_ANNABA.nameAr]);
  });

  it('debounces the search and writes it with replaceUrl, resetting the page', async () => {
    await open('/employees?page=3');
    const navigate = vi.spyOn(router, 'navigate');
    const input = el().querySelector('#employees-q') as HTMLInputElement;
    for (const text of ['b', 'be', 'ben']) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    }
    await settle();
    http.expectNone(isList);
    expect(navigate).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, EMPLOYEE_SEARCH_DEBOUNCE_MS + 50));
    const req = await flushList();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0]?.[1]).toMatchObject({ replaceUrl: true, queryParamsHandling: 'merge' });
    expect(params()).toEqual({ q: 'ben' });
    expect(req.request.params.get('q')).toBe('ben');
    expect(req.request.params.get('page')).toBe('1');
  });

  it('a deliberate filter change pushes history (no replaceUrl) and resets the page', async () => {
    await open('/employees?page=2');
    const navigate = vi.spyOn(router, 'navigate');
    const status = el().querySelector('#employees-status') as HTMLSelectElement;
    status.value = 'ended';
    status.dispatchEvent(new Event('change'));
    const req = await flushList();
    expect(navigate.mock.calls[0]?.[1]).toMatchObject({ replaceUrl: false });
    expect(params()).toEqual({ status: 'ended' });
    expect(req.request.params.get('status')).toBe('ended');
  });

  it('toggles the sort on the same column and switches column with ascending order', async () => {
    await open('/employees');
    expect(header('name').closest('th')?.getAttribute('aria-sort')).toBe('ascending');

    header('name').click();
    await flushList();
    expect(params()).toEqual({ dir: 'desc' });
    expect(header('name').closest('th')?.getAttribute('aria-sort')).toBe('descending');

    header('matricule').click();
    const req = await flushList();
    expect(params()).toEqual({ sort: 'matricule' });
    expect(req.request.params.get('dir')).toBe('asc');
    expect(header('name').closest('th')?.hasAttribute('aria-sort')).toBe(false);
  });

  it('pages on the server and changes the page size (back to page 1)', async () => {
    const items = Array.from({ length: 25 }, (_, i) => listItem({ id: `e-${i}`, matricule: `EMP-${i}` }));
    await open('/employees', page(items, 60));
    expect(el().querySelector('.page-of')?.textContent).toContain('Page 1 sur 3');
    expect((el().querySelector('[data-action="prev"]') as HTMLButtonElement).disabled).toBe(true);

    (el().querySelector('[data-action="next"]') as HTMLButtonElement).click();
    const second = await flushList(page(items, 60, 2));
    expect(params()).toEqual({ page: '2' });
    expect(second.request.params.get('page')).toBe('2');

    const size = el().querySelector('#employees-page-size') as HTMLSelectElement;
    size.value = '50';
    size.dispatchEvent(new Event('change'));
    await flushList(page(items, 60, 1, 50));
    expect(params()).toEqual({ pageSize: '50' });
  });

  it('follows the URL when it changes from outside (back/forward, a pasted link)', async () => {
    await open('/employees?q=ben');
    await harness.navigateByUrl('/employees?q=ali&status=ended');
    const req = await flushList();
    expect(req.request.params.get('q')).toBe('ali');
    expect((el().querySelector('#employees-q') as HTMLInputElement).value).toBe('ali');
    expect((el().querySelector('#employees-status') as HTMLSelectElement).value).toBe('ended');
  });

  it('shows the unit from the URL in the picker and "include sub-units" from its param', async () => {
    await harness.navigateByUrl('/employees?unitId=a-annaba&includeSubUnits=false');
    await settle();
    const req = http.expectOne(isList);
    expect(req.request.params.get('includeSubUnits')).toBe('false');
    req.flush(page([]));
    http.match('/api/org/kinds').forEach((r) => r.flush(ORG_KIND_LIST));
    http.match((r) => r.url === '/api/org/sites').forEach((r) => r.flush({ items: SITES }));
    http.expectOne('/api/org/units/a-annaba').flush({
      id: 'a-annaba', kind: 'agency', code: 'AG-ANNABA', name: 'Agence Annaba', site: null, path: [],
      siteInherited: false, createdAt: '2024-01-01', versions: [], _actions: [],
    });
    await settle();
    expect((el().querySelector('#employees-unit') as HTMLInputElement).value).toBe('Agence Annaba (AG-ANNABA)');
    expect((el().querySelector('#employees-sub-units') as HTMLInputElement).checked).toBe(false);
    expect(el().querySelector('[data-state="no-match"]')).not.toBeNull();

    (el().querySelector('[data-action="clear"]') as HTMLButtonElement).click();
    await flushList();
    expect(params()).toEqual({});
  });

  it('empty, error and permission-aware states', async () => {
    TestBed.inject(Session).set(meWith(['employee.read']));
    await open('/employees', page([]));
    expect(el().querySelector('[data-state="empty"]')?.textContent).toContain("Aucun employé n'est encore enregistré.");
    // Without org_unit.read / site.read / employee.create: no picker, no site filter, no "new" button.
    expect(el().querySelector('app-org-unit-picker')).toBeNull();
    expect(el().querySelector('#employees-site')).toBeNull();
    expect(el().querySelector('[data-action="new"]')).toBeNull();

    await harness.navigateByUrl('/employees?status=all');
    await settle();
    http.expectOne(isList).flush({ type: 'about:blank', title: 'Boom', status: 500 }, { status: 500, statusText: 'Error' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('Impossible de charger les employés.');
    (el().querySelector('[role="alert"] button') as HTMLButtonElement).click();
    await flushList();
    expect(el().querySelector('[role="alert"]')).toBeNull();
  });
});
