import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { EmployeesApi, employeeListParams, sortLanguageOf } from './employees-api';
import { DEFAULT_EMPLOYEE_QUERY, type EmployeeQuery } from './employees.models';

describe('employeeListParams', () => {
  it('always sends status, sort, dir, page and pageSize; leaves empty filters out', () => {
    expect(employeeListParams(DEFAULT_EMPLOYEE_QUERY)).toEqual({
      status: 'active',
      sort: 'name',
      dir: 'asc',
      page: '1',
      pageSize: '25',
    });
  });

  it('sends trimmed q, unitId with includeSubUnits, siteId, asOf and paging', () => {
    const query: EmployeeQuery = {
      ...DEFAULT_EMPLOYEE_QUERY,
      q: '  benali ',
      unitId: 'r-est',
      includeSubUnits: false,
      siteId: 's-cne',
      status: 'all',
      asOf: '2025-06-30',
      sort: 'hireDate',
      dir: 'desc',
      page: 3,
      pageSize: 50,
    };
    expect(employeeListParams(query)).toEqual({
      q: 'benali',
      unitId: 'r-est',
      includeSubUnits: 'false',
      siteId: 's-cne',
      status: 'all',
      asOf: '2025-06-30',
      sort: 'hireDate',
      dir: 'desc',
      page: '3',
      pageSize: '50',
    });
  });
});

describe('employeeListParams › lang', () => {
  it('adds lang=ar only for an Arabic sort language', () => {
    expect(employeeListParams(DEFAULT_EMPLOYEE_QUERY, 'ar')['lang']).toBe('ar');
    expect(employeeListParams(DEFAULT_EMPLOYEE_QUERY, null)).not.toHaveProperty('lang');
    expect(sortLanguageOf('ar')).toBe('ar');
    expect(sortLanguageOf('fr')).toBeNull();
    expect(sortLanguageOf('en')).toBeNull();
  });
});

describe('EmployeesApi', () => {
  let api: EmployeesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(EmployeesApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('listResource follows the query signal (sort, page, filters)', () => {
    const query = signal<EmployeeQuery>(DEFAULT_EMPLOYEE_QUERY);
    TestBed.runInInjectionContext(() => api.listResource(query));
    TestBed.tick();
    const first = http.expectOne((r) => r.url === '/api/employees');
    expect(first.request.urlWithParams).toBe('/api/employees?status=active&sort=name&dir=asc&page=1&pageSize=25');
    first.flush({ items: [], total: 0, page: 1, pageSize: 25 });

    query.set({ ...DEFAULT_EMPLOYEE_QUERY, sort: 'matricule', dir: 'desc', page: 2, unitId: 'u-1' });
    TestBed.tick();
    const second = http.expectOne((r) => r.url === '/api/employees');
    expect(second.request.params.get('sort')).toBe('matricule');
    expect(second.request.params.get('dir')).toBe('desc');
    expect(second.request.params.get('page')).toBe('2');
    expect(second.request.params.get('unitId')).toBe('u-1');
    expect(second.request.params.get('includeSubUnits')).toBe('true');
    second.flush({ items: [], total: 0, page: 2, pageSize: 25 });
  });

  it('listResource re-fetches when the sort language changes', () => {
    const lang = signal<'ar' | null>(null);
    TestBed.runInInjectionContext(() => api.listResource(() => DEFAULT_EMPLOYEE_QUERY, lang));
    TestBed.tick();
    expect(http.expectOne((r) => r.url === '/api/employees').request.params.has('lang')).toBe(false);
    lang.set('ar');
    TestBed.tick();
    expect(http.expectOne((r) => r.url === '/api/employees').request.params.get('lang')).toBe('ar');
  });

  it('detailResource is idle without an id, then GETs /employees/:id', () => {
    const id = signal<string | null>(null);
    const res = TestBed.runInInjectionContext(() => api.detailResource(id));
    TestBed.tick();
    http.expectNone((r) => r.url.startsWith('/api/employees'));
    expect(res.status()).toBe('idle');
    id.set('e-1');
    TestBed.tick();
    http.expectOne('/api/employees/e-1').flush({});
  });

  it('writes go to the contract URLs with the contract methods', () => {
    const cases: [() => unknown, string, string][] = [
      [() => firstValueFrom(api.create({ lastName: 'A', firstName: 'B', matricule: 'X', hireDate: '2025-01-01', orgUnitId: 'u', jobTitle: 'J' })), '/api/employees', 'POST'],
      [() => firstValueFrom(api.updatePerson('e-1', { nin: null })), '/api/employees/e-1/person', 'PATCH'],
      [() => firstValueFrom(api.assign('e-1', { orgUnitId: 'u', jobTitle: 'J', validFrom: '2025-01-01' })), '/api/employees/e-1/assignments', 'POST'],
      [() => firstValueFrom(api.end('e-1', { endDate: '2025-12-31', reason: 'resignation' })), '/api/employees/e-1/end', 'POST'],
      [() => firstValueFrom(api.setSalary('e-1', { baseSalary: '1.00', validFrom: '2025-01-01' })), '/api/employees/e-1/salary', 'PUT'],
      [() => firstValueFrom(api.setBank('e-1', { rib: null, bankName: null })), '/api/employees/e-1/bank', 'PUT'],
      [() => firstValueFrom(api.setNss('e-1', { nss: null })), '/api/employees/e-1/nss', 'PUT'],
    ];
    for (const [call, url, method] of cases) {
      void call();
      expect(http.expectOne(url).request.method).toBe(method);
    }
  });
});
