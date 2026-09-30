import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { AttendanceApi, type DateRange, presenceParams, teamParams } from './attendance-api';
import { DEFAULT_PRESENCE_QUERY } from './attendance.models';
import { KioskApi } from './kiosk-api';

describe('presenceParams / teamParams', () => {
  it('sends only paging for the default query (today, sort by unit, no filter)', () => {
    expect(presenceParams(DEFAULT_PRESENCE_QUERY)).toEqual({ page: '1', pageSize: '50' });
  });

  it('sends every filter, includeSubUnits only with a unit, lang only for Arabic', () => {
    expect(
      presenceParams(
        { date: '2026-09-28', unitId: 'r-est', includeSubUnits: false, siteId: 's-cne', status: 'late', q: ' ben ', sort: 'name', page: 2, pageSize: 25 },
        'ar',
      ),
    ).toEqual({
      date: '2026-09-28',
      unitId: 'r-est',
      includeSubUnits: 'false',
      siteId: 's-cne',
      status: 'late',
      q: 'ben',
      sort: 'name',
      lang: 'ar',
      page: '2',
      pageSize: '25',
    });
    expect(presenceParams({ ...DEFAULT_PRESENCE_QUERY, includeSubUnits: false }, 'fr')).toEqual({ page: '1', pageSize: '50' });
    expect(teamParams({ date: null, status: 'absent', q: '', page: 1, pageSize: 50 })).toEqual({ status: 'absent', page: '1', pageSize: '50' });
  });
});

describe('AttendanceApi', () => {
  let api: AttendanceApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(AttendanceApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('scans with the token in the BODY, then punches with no body', async () => {
    const scan = firstValueFrom(api.scan('tok'));
    const scanReq = http.expectOne('/api/attendance/scan');
    expect(scanReq.request.method).toBe('POST');
    expect(scanReq.request.body).toEqual({ token: 'tok' });
    scanReq.flush({ kiosk: { labels: { fr: 'a', ar: 'b' }, site: { code: 'X', name: 'Y' } }, scannedAt: 'x', localTime: '07:58', receiptExpiresAt: 'y' });
    await scan;

    const punch = firstValueFrom(api.punchSelf());
    const punchReq = http.expectOne('/api/me/attendance/punches');
    expect(punchReq.request.method).toBe('POST');
    expect(punchReq.request.body).toBeNull();
    punchReq.flush({ duplicate: false });
    await punch;
  });

  it('asks "my days" with the API default (no dates) or a range, and nothing while disabled', () => {
    const range = signal<Partial<DateRange> | undefined>(undefined);
    TestBed.runInInjectionContext(() => api.myDaysResource(range));
    TestBed.tick();
    http.expectNone((r) => r.url === '/api/me/attendance/days');
    range.set({});
    TestBed.tick();
    expect(http.expectOne('/api/me/attendance/days').request.params.keys()).toEqual([]);
    range.set({ from: '2026-09-01', to: '2026-09-29' });
    TestBed.tick();
    const req = http.expectOne((r) => r.url === '/api/me/attendance/days');
    expect(req.request.params.get('from')).toBe('2026-09-01');
    expect(req.request.params.get('to')).toBe('2026-09-29');
  });

  it('builds the per-employee, void and kiosk-management URLs', () => {
    api.addPunch('e 1', { direction: 'in', date: '2026-09-29', time: '08:05', reason: 'Téléphone en panne' }).subscribe();
    expect(http.expectOne('/api/employees/e%201/attendance/punches').request.body).toEqual({
      direction: 'in',
      date: '2026-09-29',
      time: '08:05',
      reason: 'Téléphone en panne',
    });
    api.voidPunch('p-1', 'Pointage en double').subscribe();
    expect(http.expectOne('/api/attendance/punches/p-1/void').request.body).toEqual({ reason: 'Pointage en double' });
    api.newPairingCode('k-1').subscribe();
    expect(http.expectOne('/api/attendance/kiosks/k-1/pairing-code').request.method).toBe('POST');
    api.revokeKiosk('k-1', 'Tablette volée').subscribe();
    expect(http.expectOne('/api/attendance/kiosks/k-1/revoke').request.body).toEqual({ reason: 'Tablette volée' });
    api.endAssignment('a-1', '2026-12-31').subscribe();
    expect(http.expectOne('/api/attendance/schedule-assignments/a-1/end').request.body).toEqual({ validTo: '2026-12-31' });
  });

  it('KioskApi: session, pair and qr under /api/kiosk', () => {
    const kiosk = TestBed.inject(KioskApi);
    kiosk.session().subscribe();
    expect(http.expectOne('/api/kiosk/session').request.method).toBe('GET');
    kiosk.pair('K7M29QXA').subscribe();
    expect(http.expectOne('/api/kiosk/pair').request.body).toEqual({ code: 'K7M29QXA' });
    kiosk.qr().subscribe();
    expect(http.expectOne('/api/kiosk/qr').request.method).toBe('GET');
  });
});
