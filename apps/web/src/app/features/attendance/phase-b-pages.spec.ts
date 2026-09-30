import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { attendanceProblem, correctionDetail, correctionView, monthlyReport } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { addMonths, algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { CorrectionDetailPage } from './correction-detail.page';
import { CorrectionsPage } from './corrections.page';
import { MonthlyReportPage } from './monthly-report.page';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe('Attendance Phase B HR pages', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter(
          [
            { path: 'attendance/corrections', component: CorrectionsPage },
            { path: 'attendance/corrections/:id', component: CorrectionDetailPage },
            { path: 'attendance/reports', component: MonthlyReportPage },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    TestBed.inject(Session).set(meWith(['attendance.read']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
    vi.restoreAllMocks();
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  it('corrections list: pending by default, filters in the URL (?status=all), rows link to the detail', async () => {
    await harness.navigateByUrl('/attendance/corrections');
    await settle();
    const first = http.expectOne((r) => r.url === '/api/attendance/corrections');
    expect(first.request.params.get('status')).toBe('pending');
    first.flush({ items: [correctionView()], total: 1, page: 1, pageSize: 25 });
    await settle();
    const row = el().querySelector('[data-correction="c-1"]') as HTMLElement;
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/attendance/corrections/c-1');
    expect(row.textContent).toContain('En attente');
    expect(row.querySelector('[data-action="add"]')?.textContent).toContain('16:05');
    // Cards on a phone: every cell names its column.
    expect([...row.querySelectorAll('td')].every((td) => td.hasAttribute('data-label'))).toBe(true);

    const select = el().querySelector<HTMLSelectElement>('#corr-status') as HTMLSelectElement;
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/attendance/corrections?status=all');
    const all = http.expectOne((r) => r.url === '/api/attendance/corrections');
    expect(all.request.params.has('status')).toBe(false);
    all.flush({ items: [], total: 0, page: 1, pageSize: 25 });
    await settle();
    expect(el().querySelector('[data-state="no-match"]')).not.toBeNull();
  });

  it('correction detail: facts, the day before/after, steps with history, and a 404 without retry', async () => {
    await harness.navigateByUrl('/attendance/corrections/c-1');
    await settle();
    http.expectOne('/api/attendance/corrections/c-1').flush(correctionDetail());
    await settle();
    expect(el().querySelector('[data-field="reason"]')?.textContent).toContain('Téléphone oublié');
    const after = [...el().querySelectorAll('[data-panel="correction-preview"] [data-change]')].map((li) => li.getAttribute('data-change'));
    expect(after).toEqual(['removed', 'kept', 'added']);
    expect(el().querySelectorAll('app-workflow-stepper li')).toHaveLength(2);

    await harness.navigateByUrl('/attendance/corrections/c-x');
    await settle();
    const { body, options } = attendanceProblem(404, null);
    http.expectOne('/api/attendance/corrections/c-x').flush(body, options);
    await settle();
    expect(el().textContent).toContain('Demande de correction introuvable.');
    expect(el().querySelector('.form-error button')).toBeNull();
  });

  it('monthly report: month in the URL, totals per employee, CSV downloaded as a Blob in the UI language', async () => {
    const previous = addMonths(algiersToday().slice(0, 7), -1);
    await harness.navigateByUrl(`/attendance/reports?month=${previous}`);
    await settle();
    const page = http.expectOne((r) => r.url === '/api/attendance/reports/monthly');
    expect(page.request.params.get('month')).toBe(previous);
    page.flush(monthlyReport({ month: previous }));
    await settle();
    const row = el().querySelector('[data-employee="e-30"]') as HTMLElement;
    expect(row.textContent).toContain('34 min');
    expect(row.textContent).toContain('150 h 00');
    expect(el().querySelector<HTMLButtonElement>('[data-action="next-month"]')?.disabled).toBe(false);

    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    TestBed.inject(LanguageService).use('ar', { remember: false });
    await settle();
    el().querySelector<HTMLButtonElement>('[data-action="export-csv"]')?.click();
    await settle();
    const csv = http.expectOne((r) => r.url === '/api/attendance/reports/monthly.csv');
    expect(csv.request.params.get('lang')).toBe('ar');
    expect(csv.request.params.get('month')).toBe(previous);
    expect(csv.request.responseType).toBe('blob');
    csv.flush(new Blob(['﻿matricule'], { type: 'text/csv' }));
    await settle();
    expect(createUrl).toHaveBeenCalled();
    expect(clicked).toEqual([`presence-${previous}.csv`]);
  });

  it('monthly report: a refused export (422, too many rows) is explained, the table stays', async () => {
    await harness.navigateByUrl('/attendance/reports');
    await settle();
    const page = http.expectOne((r) => r.url === '/api/attendance/reports/monthly');
    expect(page.request.params.get('month')).toBe(algiersToday().slice(0, 7));
    page.flush(monthlyReport());
    await settle();
    expect(el().querySelector<HTMLButtonElement>('[data-action="next-month"]')?.disabled).toBe(true);
    el().querySelector<HTMLButtonElement>('[data-action="export-csv"]')?.click();
    await settle();
    const { body } = attendanceProblem(422, null, [{ field: 'unitId', code: 'too_many', message: 'too many' }]);
    http
      .expectOne((r) => r.url === '/api/attendance/reports/monthly.csv')
      .flush(new Blob([JSON.stringify(body)], { type: 'application/problem+json' }), { status: 422, statusText: 'Unprocessable' });
    await settle();
    expect(el().querySelector('[data-error="export"]')?.textContent).toContain('plus de 5 000');
    expect(el().querySelector('[data-employee="e-30"]')).not.toBeNull();
  });
});
