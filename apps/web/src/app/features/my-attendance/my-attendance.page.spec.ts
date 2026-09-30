import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { attendanceProblem, day, EMPLOYEE_REF, myDays, punch } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { MyAttendancePage } from './my-attendance.page';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const EMPLOYMENT = { ...EMPLOYEE_REF, jobTitle: 'Chargée de clientèle', hireDate: '2024-03-01', headOf: [] };

const isDays = (url: string) => url === '/api/me/attendance/days';

describe('MyAttendancePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'me/attendance', component: MyAttendancePage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['attendance.punch_self']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(retentionMonths = 60): Promise<void> {
    await harness.navigateByUrl('/me/attendance');
    await settle();
    http.expectOne('/api/me/employment').flush(EMPLOYMENT);
    await settle();
    const requests = http.match((r) => isDays(r.url));
    expect(requests).toHaveLength(2);
    const today = requests.find((r) => !r.request.params.has('from')) as TestRequest;
    const month = requests.find((r) => r.request.params.has('from')) as TestRequest;
    expect(month.request.params.get('from')).toBe(`${algiersToday().slice(0, 7)}-01`);
    expect(month.request.params.get('to')).toBe(algiersToday());
    today.flush(myDays([day()], { retentionMonths }));
    month.flush(
      myDays(
        [
          day({ date: '2026-09-28', status: 'late', final: true, flags: [], punches: [punch({ id: 'p-0', workDate: '2026-09-28' })] }),
          day({ punches: [punch()] }),
        ],
        { retentionMonths },
      ),
    );
    await settle();
  }

  it('shows today (status, arrival, worked so far, schedule) from the API default day', async () => {
    await open();
    const today = el().querySelector('[data-panel="today"]') as HTMLElement;
    expect(today.querySelector('app-day-status')?.textContent?.trim()).toBe('Présent');
    expect(today.querySelector('[data-field="arrival"]')?.textContent?.trim()).toBe('07:52');
    expect(today.querySelector('[data-field="worked"]')?.textContent?.trim()).toBe('1 h 35');
    expect(today.querySelector('[data-field="schedule"]')?.textContent).toContain('07:30–16:00');
  });

  it('lists my month newest first, a row opens on its punches, and the month navigator stops at this month', async () => {
    await open();
    const rows = [...el().querySelectorAll('[data-day]')].map((r) => r.getAttribute('data-day'));
    expect(rows).toEqual(['2026-09-29', '2026-09-28']);
    expect(el().querySelector('[data-day="2026-09-28"] [data-punch="p-0"]')?.textContent).toContain('Agence Annaba — Entrée');
    expect(el().querySelector<HTMLButtonElement>('[data-action="next-month"]')?.disabled).toBe(true);

    (el().querySelector<HTMLButtonElement>('[data-action="prev-month"]') as HTMLButtonElement).click();
    await settle();
    const previous = http.expectOne((r) => isDays(r.url) && r.params.has('from'));
    expect(previous.request.params.get('from')?.endsWith('-01')).toBe(true);
    previous.flush(myDays([]));
    await settle();
    http.expectNone((r) => isDays(r.url) && !r.params.has('from')); // today's card is not reloaded
  });

  it('shows the Law 18-07 notice with the retention in years, or months', async () => {
    await open(60);
    expect(el().querySelector('[data-panel="notice"]')?.textContent).toContain('Les pointages sont conservés 5 ans.');
    expect(el().querySelector('[data-panel="notice"]')?.textContent).toContain('Aucune localisation, photo ni donnée biométrique');
    TestBed.inject(LanguageService).use('ar', { remember: false });
    await settle();
    expect(el().querySelector('[data-panel="notice"]')?.textContent).toContain('تحفظ التسجيلات لمدة 5 سنوات.');
  });

  it('explains a missing link (409 attendance-not-linked) instead of the cards', async () => {
    await harness.navigateByUrl('/me/attendance');
    await settle();
    http.expectOne('/api/me/employment').flush(EMPLOYMENT);
    await settle();
    const { body, options } = attendanceProblem(409, 'attendance-not-linked');
    for (const req of http.match((r) => isDays(r.url))) req.flush(body, options);
    await settle();
    expect(el().querySelector('[data-state="not-linked"]')).not.toBeNull();
    expect(el().querySelector('[data-panel="today"]')).toBeNull();
  });
});
