import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { day } from '../../../testing/attendance-fixtures';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { AttendanceApi } from './attendance-api';
import {
  algiersTime,
  correctableDates,
  correctionParams,
  correctionPreview,
  daysBetween,
  DEFAULT_CORRECTION_QUERY,
  DEFAULT_REPORT_QUERY,
  type ReportQuery,
  reportCsvParams,
  reportFileName,
  reportParams,
} from './attendance.models';

describe('attendance Phase B helpers', () => {
  it('Algiers wall-clock time and the correction window', () => {
    expect(algiersTime(Date.parse('2026-09-29T23:30:00Z'))).toBe('00:30');
    expect(daysBetween('2026-08-31', '2026-09-30')).toBe(30);
  });

  it('correctable days: inside the API window, employed, and without a pending request; none without a window', () => {
    const days = [
      day({ date: '2026-08-30' }),
      day({ date: '2026-08-31' }),
      day({ date: '2026-09-28' }),
      day({ date: '2026-09-29', status: 'not_employed' }),
      day({ date: '2026-09-30' }),
    ];
    const window = { from: '2026-08-31', to: '2026-09-30' };
    expect([...correctableDates(days, window, new Set(['2026-09-28']))]).toEqual(['2026-08-31', '2026-09-30']);
    expect(correctableDates(days, null, new Set()).size).toBe(0);
  });

  it('before/after: removed kept in place and marked, added merged by time, void punches ignored', () => {
    const preview = correctionPreview(
      [
        { id: 'a', direction: 'in', localTime: '07:52', status: 'live' },
        { id: 'b', direction: 'in', localTime: '07:55', status: 'live' },
        { id: 'z', direction: 'out', localTime: '09:00', status: 'void' },
      ],
      [
        { position: 0, action: 'void', direction: null, time: null, punch: { id: 'b', direction: 'in', localTime: '07:55' } },
        { position: 1, action: 'add', direction: 'out', time: '16:05', punch: null },
        { position: 2, action: 'add', direction: 'out', time: '12:00', punch: null },
      ],
    );
    expect(preview.before.map((p) => `${p.localTime} ${p.change}`)).toEqual(['07:52 kept', '07:55 kept']);
    expect(preview.after.map((p) => `${p.localTime} ${p.change}`)).toEqual(['07:52 kept', '07:55 removed', '12:00 added', '16:05 added']);
  });

  it('before/after from a summary: a void target the day list does not show is still listed', () => {
    const preview = correctionPreview(
      [{ id: 'a', direction: 'in', localTime: '07:52', status: 'live' }],
      [{ position: 0, action: 'void', direction: null, time: null, punch: { id: 'x', direction: 'out', localTime: '12:01' } }],
    );
    expect(preview.before.map((p) => p.key)).toEqual(['a', 'x']);
    expect(preview.after.find((p) => p.key === 'x')?.change).toBe('removed');
  });

  it('list params: defaults out, pending by default, includeSubUnits only with a unit, employmentId for one employee', () => {
    expect(correctionParams({ ...DEFAULT_CORRECTION_QUERY, employmentId: 'e-30', status: null })).toEqual({ employmentId: 'e-30', page: '1', pageSize: '25' });
    expect(correctionParams(DEFAULT_CORRECTION_QUERY)).toEqual({ status: 'pending', page: '1', pageSize: '25' });
    expect(
      correctionParams({ status: null, unitId: 'r-est', includeSubUnits: false, from: '2026-09-01', to: '2026-09-30', q: ' ben ', page: 2, pageSize: 50 }),
    ).toEqual({ unitId: 'r-est', includeSubUnits: 'false', from: '2026-09-01', to: '2026-09-30', q: 'ben', page: '2', pageSize: '50' });
  });

  it('report params: the month always, the CSV without search or paging, lang fr|ar only', () => {
    const query: ReportQuery = { ...DEFAULT_REPORT_QUERY, unitId: 'r-est', siteId: 's-cne', q: 'ben', page: 3 };
    expect(reportParams(DEFAULT_REPORT_QUERY, '2026-09')).toEqual({ month: '2026-09', page: '1', pageSize: '50' });
    expect(reportParams({ ...query, month: '2026-08' }, '2026-09')).toEqual({
      month: '2026-08',
      unitId: 'r-est',
      includeSubUnits: 'true',
      siteId: 's-cne',
      q: 'ben',
      page: '3',
      pageSize: '50',
    });
    expect(reportCsvParams(query, '2026-09', 'ar')).toEqual({ month: '2026-09', unitId: 'r-est', includeSubUnits: 'true', siteId: 's-cne', lang: 'ar' });
    expect(reportCsvParams(query, '2026-09', 'en')['lang']).toBe('fr');
    expect(reportFileName('2026-09')).toBe('presence-2026-09.csv');
  });
});

describe('AttendanceApi (Phase B)', () => {
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

  it('requests, lists and cancels my corrections', () => {
    api.requestCorrection({ date: '2026-09-28', reason: 'Oubli', changes: [{ action: 'add', direction: 'out', time: '16:00' }] }).subscribe();
    const post = http.expectOne('/api/me/attendance/corrections');
    expect(post.request.method).toBe('POST');
    expect(post.request.body.changes).toEqual([{ action: 'add', direction: 'out', time: '16:00' }]);
    api.cancelMyCorrection('c 1').subscribe();
    expect(http.expectOne('/api/me/attendance/corrections/c%201/cancel').request.method).toBe('POST');

    const enabled = signal(false);
    TestBed.runInInjectionContext(() => api.myCorrectionsResource(enabled));
    TestBed.tick();
    http.expectNone('/api/me/attendance/corrections');
    enabled.set(true);
    TestBed.tick();
    expect(http.expectOne('/api/me/attendance/corrections').request.params.keys()).toEqual([]);
  });

  it('reads the HR list, one correction and the monthly report', () => {
    TestBed.runInInjectionContext(() => {
      api.correctionsResource(() => DEFAULT_CORRECTION_QUERY);
      api.correctionResource(() => 'c-1');
      api.monthlyReportResource(() => DEFAULT_REPORT_QUERY, '2026-09');
    });
    TestBed.tick();
    expect(http.expectOne((r) => r.url === '/api/attendance/corrections').request.params.get('status')).toBe('pending');
    http.expectOne('/api/attendance/corrections/c-1');
    expect(http.expectOne((r) => r.url === '/api/attendance/reports/monthly').request.params.get('month')).toBe('2026-09');
  });

  it('downloads the CSV as a Blob with the filters and the language', async () => {
    const blob = firstValueFrom(api.monthlyReportCsv({ ...DEFAULT_REPORT_QUERY, month: '2026-08' }, '2026-09', 'ar'));
    const req = http.expectOne((r) => r.url === '/api/attendance/reports/monthly.csv');
    expect(req.request.responseType).toBe('blob');
    expect(req.request.params.get('month')).toBe('2026-08');
    expect(req.request.params.get('lang')).toBe('ar');
    expect(req.request.params.has('page')).toBe(false);
    req.flush(new Blob(['﻿matricule;nom\r\n'], { type: 'text/csv' }));
    expect((await blob).type).toBe('text/csv');
  });
});
