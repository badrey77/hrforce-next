import { HttpHeaders, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { EMPLOYEE_VARIABLES, OPEN_PERIOD, PAYROLL_SETTINGS, SETTINGS_PREVIEW } from '../../../testing/payroll-fixtures';
import { PayrollApi } from './payroll-api';
import {
  columnsProblem,
  DEFAULT_VARIABLES_QUERY,
  exportFilterParams,
  filenameFromDisposition,
  monthKey,
  variablesParams,
} from './payroll.models';

describe('payroll models', () => {
  it('sends paging always and the other filters only when set', () => {
    expect(variablesParams(DEFAULT_VARIABLES_QUERY)).toEqual({ page: '1', pageSize: '50' });
    expect(
      variablesParams({ ...DEFAULT_VARIABLES_QUERY, unitId: 'u-1', includeSubUnits: false, q: ' Benali ', rubriqueId: 'r-1', filter: 'adjusted', page: 2 }, 'ar'),
    ).toEqual({ unitId: 'u-1', includeSubUnits: 'false', q: 'Benali', rubriqueId: 'r-1', filter: 'adjusted', lang: 'ar', page: '2', pageSize: '50' });
    expect(variablesParams(DEFAULT_VARIABLES_QUERY, 'fr')).not.toHaveProperty('lang');
  });

  it('sends the unit filter of a file only with a unit', () => {
    expect(exportFilterParams(null)).toEqual({});
    expect(exportFilterParams({ unitId: null, includeSubUnits: true })).toEqual({});
    expect(exportFilterParams({ unitId: 'u-1', includeSubUnits: true })).toEqual({ unitId: 'u-1', includeSubUnits: 'true' });
  });

  it('reads the file name of a Content-Disposition header', () => {
    expect(filenameFromDisposition('attachment; filename="variables-paie-2026-10-RE.csv"', 'x')).toBe('variables-paie-2026-10-RE.csv');
    expect(filenameFromDisposition("attachment; filename=\"a.csv\"; filename*=UTF-8''%C3%A9tat.csv", 'x')).toBe('état.csv');
    expect(filenameFromDisposition('attachment; filename=plain.txt', 'x')).toBe('plain.txt');
    expect(filenameFromDisposition('attachment; filename="../evil.csv"', 'x')).toBe('.._evil.csv');
    expect(filenameFromDisposition(null, 'fallback.csv')).toBe('fallback.csv');
    expect(filenameFromDisposition('attachment', 'fallback.csv')).toBe('fallback.csv');
  });

  it('checks export columns as the API does', () => {
    expect(columnsProblem('per_line', ['matricule', 'rubrique', 'value', 'period'])).toBeNull();
    expect(columnsProblem('per_line', [])).toBe('required');
    expect(columnsProblem('per_line', ['rubrique', 'value'])).toBe('missing_matricule');
    expect(columnsProblem('per_line', ['matricule', 'rubrique'])).toBe('missing_rubrique_value');
    expect(columnsProblem('per_line', ['matricule', 'matricule'])).toBe('invalid');
    expect(columnsProblem('per_employee', ['matricule', 'rubrique'])).toBe('invalid');
    expect(columnsProblem('per_employee', ['matricule', 'last_name'])).toBeNull();
  });

  it('cuts a date to its month', () => {
    expect(monthKey('2026-10-01')).toBe('2026-10');
    expect(monthKey('2026-10')).toBe('2026-10');
  });
});

describe('PayrollApi', () => {
  let http: HttpTestingController;
  let api: PayrollApi;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(PayrollApi);
  });

  afterEach(() => http.verify());

  it('reads periods, a period, variables and one employee as resources', () => {
    const injector = TestBed.inject(Injector);
    const month = signal<string | null>(null);
    runInInjectionContext(injector, () => {
      api.periodsResource(() => 2026);
      api.periodResource(() => month());
      api.variablesResource(() => month(), () => DEFAULT_VARIABLES_QUERY, () => 'ar');
      api.employeeVariablesResource(() => month(), () => 'emp-27');
    });
    TestBed.tick();
    http.expectOne((r) => r.url === '/api/payroll/periods' && r.params.get('year') === '2026').flush({ items: [] });
    http.expectNone('/api/payroll/periods/2026-10');
    month.set('2026-10');
    TestBed.tick();
    http.expectOne('/api/payroll/periods/2026-10').flush(OPEN_PERIOD);
    http.expectOne((r) => r.url === '/api/payroll/periods/2026-10/variables' && r.params.get('lang') === 'ar').flush({ items: [], total: 0, page: 1, pageSize: 50 });
    http.expectOne('/api/payroll/periods/2026-10/variables/emp-27').flush(EMPLOYEE_VARIABLES);
  });

  it('periods without a year use the API default', () => {
    runInInjectionContext(TestBed.inject(Injector), () => api.periodsResource(() => null));
    TestBed.tick();
    http.expectOne((r) => r.url === '/api/payroll/periods' && !r.params.has('year')).flush({ items: [] });
  });

  it('writes lines, codes, closes and reopens', () => {
    api.putLine('2026-10', 'emp-27', { rubriqueId: 'r-1', originMonth: '2026-09', value: 2.5, note: 'vu' }).subscribe();
    const put = http.expectOne('/api/payroll/periods/2026-10/variables/emp-27/lines');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ rubriqueId: 'r-1', originMonth: '2026-09', value: 2.5, note: 'vu' });
    put.flush(EMPLOYEE_VARIABLES);

    api.deleteLine('2026-10', 'emp-27', 'r-1', '2026-09').subscribe();
    const del = http.expectOne((r) => r.url === '/api/payroll/periods/2026-10/variables/emp-27/lines/r-1');
    expect(del.request.method).toBe('DELETE');
    expect(del.request.params.get('originMonth')).toBe('2026-09');
    del.flush(EMPLOYEE_VARIABLES);

    api.deleteLine('2026-10', 'emp-27', 'r-2').subscribe();
    const del2 = http.expectOne('/api/payroll/periods/2026-10/variables/emp-27/lines/r-2');
    expect(del2.request.params.has('originMonth')).toBe(false);
    del2.flush(EMPLOYEE_VARIABLES);

    api.setEmployeeCode('emp-27', null).subscribe();
    const code = http.expectOne('/api/payroll/employee-codes/emp-27');
    expect(code.request.method).toBe('PUT');
    expect(code.request.body).toEqual({ code: null });
    code.flush({ employeeId: 'emp-27', code: null });

    api.close('2026-10').subscribe();
    const close = http.expectOne('/api/payroll/periods/2026-10/close');
    expect(close.request.method).toBe('POST');
    expect(close.request.body).toEqual({});
    close.flush(OPEN_PERIOD);

    api.reopen('2026-09', 'Congé tardif').subscribe();
    const reopen = http.expectOne('/api/payroll/periods/2026-09/reopen');
    expect(reopen.request.body).toEqual({ reason: 'Congé tardif' });
    reopen.flush(OPEN_PERIOD);
  });

  it('downloads the export and the control report as Blobs named by the API', async () => {
    const exported = firstValueFrom(api.exportFile('2026-10', { unitId: 'u-1', includeSubUnits: true }, true));
    const req = http.expectOne((r) => r.url === '/api/payroll/periods/2026-10/export');
    expect(req.request.responseType).toBe('blob');
    expect(req.request.params.get('draft')).toBe('true');
    expect(req.request.params.get('unitId')).toBe('u-1');
    req.flush(new Blob(['a;b']), { headers: new HttpHeaders({ 'Content-Disposition': 'attachment; filename="variables-paie-2026-10-RE-brouillon.csv"' }) });
    const file = await exported;
    expect(file.filename).toBe('variables-paie-2026-10-RE-brouillon.csv');
    expect(file.blob.size).toBe(3);

    const plain = firstValueFrom(api.exportFile('2026-09'));
    const req2 = http.expectOne('/api/payroll/periods/2026-09/export');
    expect(req2.request.params.keys()).toEqual([]);
    req2.flush(new Blob(['x']));
    expect((await plain).filename).toBe('variables-paie-2026-09.csv');

    const control = firstValueFrom(api.controlReport('2026-09', 'ar'));
    const req3 = http.expectOne((r) => r.url === '/api/payroll/periods/2026-09/control.csv');
    expect(req3.request.params.get('lang')).toBe('ar');
    req3.flush(new Blob(['x']), { headers: new HttpHeaders({ 'Content-Disposition': 'attachment; filename="controle.csv"' }) });
    expect((await control).filename).toBe('controle.csv');
  });

  it('reads and saves settings, the preview and rubriques', () => {
    runInInjectionContext(TestBed.inject(Injector), () => {
      api.settingsResource();
      api.rubriquesResource(() => false);
    });
    TestBed.tick();
    http.expectOne('/api/payroll/settings').flush(PAYROLL_SETTINGS);
    http.expectNone('/api/payroll/rubriques');

    api.updateSettings(PAYROLL_SETTINGS).subscribe();
    const put = http.expectOne('/api/payroll/settings');
    expect(put.request.method).toBe('PUT');
    put.flush(PAYROLL_SETTINGS);

    api.getPreview().subscribe();
    http.expectOne('/api/payroll/settings/preview').flush(SETTINGS_PREVIEW);

    api.getRubriques().subscribe();
    http.expectOne('/api/payroll/rubriques').flush({ items: [] });

    api.createRubrique({ exportCode: 'AVANCE', names: { fr: 'Avance', ar: 'تسبيق', en: 'Advance' }, unit: 'amount' }).subscribe();
    const post = http.expectOne('/api/payroll/rubriques');
    expect(post.request.method).toBe('POST');
    post.flush({});

    api.updateRubrique('r 1', { active: false }).subscribe();
    const upd = http.expectOne('/api/payroll/rubriques/r%201');
    expect(upd.request.method).toBe('PUT');
    expect(upd.request.body).toEqual({ active: false });
    upd.flush({});
  });
});
