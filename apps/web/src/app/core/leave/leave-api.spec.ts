import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { LeaveApi, leaveListParams } from './leave-api';
import { DEFAULT_LEAVE_QUERY, type LeavePreviewRequest } from './leave.models';

describe('leaveListParams', () => {
  it('sends only paging for the default query (status "all" is the absence of a filter)', () => {
    expect(leaveListParams(DEFAULT_LEAVE_QUERY)).toEqual({ page: '1', pageSize: '25' });
  });

  it('sends every filter the contract lists, q trimmed, includeSubUnits only with a unit', () => {
    expect(
      leaveListParams({
        q: ' benali ',
        status: 'pending',
        unitId: 'r-est',
        includeSubUnits: false,
        typeId: 't-annual',
        from: '2026-07-01',
        to: '2026-12-31',
        page: 2,
        pageSize: 50,
      }),
    ).toEqual({
      q: 'benali',
      status: 'pending',
      unitId: 'r-est',
      includeSubUnits: 'false',
      typeId: 't-annual',
      from: '2026-07-01',
      to: '2026-12-31',
      page: '2',
      pageSize: '50',
    });
  });
});

describe('LeaveApi', () => {
  let api: LeaveApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(LeaveApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('previewResource POSTs the body, stays idle without one, and cancels a superseded request', () => {
    const body = signal<LeavePreviewRequest | undefined>(undefined);
    const preview = TestBed.runInInjectionContext(() => api.previewResource(body));
    TestBed.tick();
    http.expectNone('/api/leave/preview');
    expect(preview.status()).toBe('idle');

    body.set({ leaveTypeId: 't', startDate: '2026-10-01', endDate: '2026-10-02' });
    TestBed.tick();
    const first = http.expectOne('/api/leave/preview');
    expect(first.request.method).toBe('POST');
    expect(first.request.body).toEqual({ leaveTypeId: 't', startDate: '2026-10-01', endDate: '2026-10-02' });

    body.set({ leaveTypeId: 't', startDate: '2026-10-01', endDate: '2026-10-05', employmentId: 'e-1' });
    TestBed.tick();
    const second = http.expectOne('/api/leave/preview');
    expect(first.cancelled).toBe(true);
    expect(second.request.body).toMatchObject({ employmentId: 'e-1', endDate: '2026-10-05' });
    second.flush({ days: 5, breakdown: { calendarDays: 5, weekendDays: 0, holidays: [] }, balanceAfter: 3 });
  });

  it('holidaysResource sends the year; myBalancesResource waits until enabled', () => {
    const year = signal(2026);
    const enabled = signal(false);
    TestBed.runInInjectionContext(() => {
      api.holidaysResource(year);
      api.myBalancesResource(enabled);
    });
    TestBed.tick();
    expect(http.expectOne((r) => r.url === '/api/leave/holidays').request.params.get('year')).toBe('2026');
    http.expectNone('/api/me/leave/balances');
    enabled.set(true);
    TestBed.tick();
    http.expectOne('/api/me/leave/balances').flush({ items: [] });
  });

  it('listResource follows the query signal', () => {
    const query = signal(DEFAULT_LEAVE_QUERY);
    TestBed.runInInjectionContext(() => api.listResource(query));
    TestBed.tick();
    http.expectOne((r) => r.url === '/api/leave/requests').flush({ items: [], total: 0, page: 1, pageSize: 25 });
    query.set({ ...DEFAULT_LEAVE_QUERY, status: 'approved', page: 3 });
    TestBed.tick();
    const req = http.expectOne((r) => r.url === '/api/leave/requests');
    expect(req.request.params.get('status')).toBe('approved');
    expect(req.request.params.get('page')).toBe('3');
    req.flush({ items: [], total: 0, page: 3, pageSize: 25 });
  });

  it('writes go to the contract URLs with the contract methods', () => {
    const request = { leaveTypeId: 't', startDate: '2026-10-01', endDate: '2026-10-01' };
    const holiday = { date: '2026-11-01', labels: { fr: 'a', ar: 'b', en: 'c' }, approximate: false };
    const cases: [() => unknown, string, string][] = [
      [() => firstValueFrom(api.requestSelf(request)), '/api/me/leave/requests', 'POST'],
      [() => firstValueFrom(api.cancelMine('r-1')), '/api/me/leave/requests/r-1/cancel', 'POST'],
      [() => firstValueFrom(api.requestOnBehalf('e-1', request)), '/api/employees/e-1/leave/requests', 'POST'],
      [() => firstValueFrom(api.adjust('e-1', { leaveTypeId: 't', periodStart: '2026-07-01', days: -1, note: 'x' })), '/api/employees/e-1/leave/adjustments', 'POST'],
      [() => firstValueFrom(api.updateType('t-1', { labels: holiday.labels, accrualDaysPerMonth: null, maxDaysPerYear: null, maxDaysPerRequest: null, requiresDocument: false, active: true })), '/api/leave/types/t-1', 'PUT'],
      [() => firstValueFrom(api.createHoliday(holiday)), '/api/leave/holidays', 'POST'],
      [() => firstValueFrom(api.updateHoliday('h-1', holiday)), '/api/leave/holidays/h-1', 'PUT'],
      [() => firstValueFrom(api.deleteHoliday('h-1')), '/api/leave/holidays/h-1', 'DELETE'],
      [() => firstValueFrom(api.updatePolicy({ referenceStartMonth: 7, weekendDays: [5, 6] })), '/api/leave/policy', 'PUT'],
    ];
    for (const [call, url, method] of cases) {
      void call();
      expect(http.expectOne(url).request.method).toBe(method);
    }
  });
});
