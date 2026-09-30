import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { attendanceProblem, correctionView, day, EMPLOYEE_REF, MANAGER_THEN_HR_PROGRESS, myDays, punch } from '../../../testing/attendance-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { addDays, algiersToday, type CorrectionView } from '../../core/attendance/attendance.models';
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
const CORRECTIONS = '/api/me/attendance/corrections';

describe('MyAttendancePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
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
    // The workflow stepper names its steps through the leave catalogue (one root request).
    for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(retentionMonths = 60, corrections: readonly CorrectionView[] = [], url = '/me/attendance'): Promise<void> {
    await harness.navigateByUrl(url);
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
    http.expectOne(CORRECTIONS).flush({ items: corrections });
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
    for (const req of http.match((r) => isDays(r.url) || r.url === CORRECTIONS)) req.flush(body, options);
    await settle();
    expect(el().querySelector('[data-state="not-linked"]')).not.toBeNull();
    expect(el().querySelector('[data-panel="today"]')).toBeNull();
  });

  // --- Phase B: corrections ----------------------------------------------------------------------------------------

  /** A month with yesterday (two punches, one to remove) and today. */
  async function openWithYesterday(corrections: readonly CorrectionView[] = []): Promise<string> {
    const yesterday = addDays(algiersToday(), -1);
    await harness.navigateByUrl('/me/attendance');
    await settle();
    http.expectOne('/api/me/employment').flush(EMPLOYMENT);
    await settle();
    for (const req of http.match((r) => isDays(r.url))) {
      req.flush(
        myDays([
          day({
            date: yesterday,
            final: true,
            punches: [punch({ id: 'p-a', workDate: yesterday }), punch({ id: 'p-b', localTime: '07:55', workDate: yesterday })],
          }),
          day({ date: algiersToday(), punches: [] }),
        ]),
      );
    }
    http.expectOne(CORRECTIONS).flush({ items: corrections });
    await settle();
    return yesterday;
  }

  it('requests a correction for a day: remove a duplicate, add the departure, with a reason; the preview shows before/after', async () => {
    const yesterday = await openWithYesterday();
    const button = el().querySelector<HTMLButtonElement>(`[data-day="${yesterday}"] [data-action="request-correction"]`);
    expect(button).not.toBeNull();
    button?.click();
    await settle();
    const dialog = el().querySelector('[data-form="correction"]') as HTMLElement;
    expect(dialog.querySelector('[data-field="rules"]')?.textContent).toContain('30 jours');

    // Submitting nothing: "at least one change" + reason required, no request.
    dialog.querySelector<HTMLButtonElement>('[data-action="submit-correction"]')?.click();
    await settle();
    expect(dialog.querySelector('[data-error="changes"]')?.textContent).toContain('au moins un changement');
    http.expectNone(CORRECTIONS);

    const remove = dialog.querySelector<HTMLInputElement>('#remove-p-b') as HTMLInputElement;
    remove.click();
    dialog.querySelector<HTMLButtonElement>('[data-action="add-row"]')?.click();
    await settle();
    const time = dialog.querySelector<HTMLInputElement>('#add-time-0') as HTMLInputElement;
    time.value = '16:10';
    time.dispatchEvent(new Event('input'));
    const reason = dialog.querySelector<HTMLTextAreaElement>('#correction-reason') as HTMLTextAreaElement;
    reason.value = 'Double scan, départ oublié';
    reason.dispatchEvent(new Event('input'));
    await settle();

    const after = [...dialog.querySelectorAll('[data-panel="correction-preview"] [data-change]')].map((li) => li.getAttribute('data-change'));
    expect(after).toEqual(['kept', 'removed', 'added']);
    expect(dialog.querySelector('[data-change="removed"] del')?.textContent).toContain('07:55');

    dialog.querySelector<HTMLButtonElement>('[data-action="submit-correction"]')?.click();
    await settle();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === CORRECTIONS);
    expect(post.request.body).toEqual({
      date: yesterday,
      reason: 'Double scan, départ oublié',
      changes: [
        { action: 'void', punchId: 'p-b' },
        { action: 'add', direction: 'out', time: '16:10' },
      ],
    });
    post.flush(correctionView({ date: yesterday }), { status: 201, statusText: 'Created' });
    await settle();
    http.expectOne((r) => r.method === 'GET' && r.url === CORRECTIONS).flush({ items: [correctionView({ date: yesterday })] });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Demande de correction envoyée.');
    // One pending request per day: the button is gone, a chip says why.
    expect(el().querySelector(`[data-day="${yesterday}"] [data-action="request-correction"]`)).toBeNull();
    expect(el().querySelector(`[data-day="${yesterday}"] [data-state="correction-pending"]`)).not.toBeNull();
  });

  it('without a correction window (API null), no day offers a correction and the hint says so', async () => {
    await harness.navigateByUrl('/me/attendance');
    await settle();
    http.expectOne('/api/me/employment').flush(EMPLOYMENT);
    await settle();
    for (const req of http.match((r) => isDays(r.url))) {
      req.flush(myDays([day({ date: addDays(algiersToday(), -1), final: true, punches: [punch()] })], { correctionWindow: null }));
    }
    http.expectOne(CORRECTIONS).flush({ items: [] });
    await settle();
    expect(el().querySelector('[data-action="request-correction"]')).toBeNull();
    expect(el().querySelector('[data-field="correction-window"]')?.textContent).toContain('Aucune correction');
  });

  it('maps a 409 pending, and a future or already-recorded time from the API onto the form', async () => {
    const yesterday = await openWithYesterday();
    el().querySelector<HTMLButtonElement>(`[data-day="${yesterday}"] [data-action="request-correction"]`)?.click();
    await settle();
    const dialog = el().querySelector('[data-form="correction"]') as HTMLElement;
    dialog.querySelector<HTMLButtonElement>('[data-action="add-row"]')?.click();
    await settle();
    const time = dialog.querySelector<HTMLInputElement>('#add-time-0') as HTMLInputElement;
    time.value = '16:10';
    time.dispatchEvent(new Event('input'));
    const reason = dialog.querySelector<HTMLTextAreaElement>('#correction-reason') as HTMLTextAreaElement;
    reason.value = 'Départ oublié';
    reason.dispatchEvent(new Event('input'));
    await settle();
    dialog.querySelector<HTMLButtonElement>('[data-action="submit-correction"]')?.click();
    await settle();
    const future = attendanceProblem(422, null, [{ field: 'changes.0.time', code: 'future', message: 'in the future' }]);
    http.expectOne((r) => r.method === 'POST').flush(future.body, future.options);
    await settle();
    expect(dialog.querySelector('#add-time-0-error')?.textContent).toContain('pas encore passée');

    time.value = '16:05';
    time.dispatchEvent(new Event('input'));
    await settle();
    dialog.querySelector<HTMLButtonElement>('[data-action="submit-correction"]')?.click();
    await settle();
    const exists = attendanceProblem(422, null, [{ field: 'changes.0.time', code: 'exists', message: 'exists' }]);
    http.expectOne((r) => r.method === 'POST').flush(exists.body, exists.options);
    await settle();
    expect(dialog.querySelector('#add-time-0-error')?.textContent).toContain('existe déjà');

    dialog.querySelector<HTMLButtonElement>('[data-action="submit-correction"]')?.click();
    await settle();
    // The server error sits on the control until it changes: edit it, then submit again.
    time.value = '16:11';
    time.dispatchEvent(new Event('input'));
    await settle();
    dialog.querySelector<HTMLButtonElement>('[data-action="submit-correction"]')?.click();
    await settle();
    const pending = attendanceProblem(409, 'attendance-correction-pending');
    http.expectOne((r) => r.method === 'POST').flush(pending.body, pending.options);
    await settle();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('déjà en attente');
  });

  it('lists my requests with their status and steps, cancels a pending one, and highlights ?correction=', async () => {
    const approved = correctionView({ id: 'c-2', status: 'approved', _actions: [], workflow: { ...MANAGER_THEN_HR_PROGRESS, status: 'approved', currentStep: null } });
    await open(60, [correctionView(), approved], '/me/attendance?correction=c-2');
    const rows = [...el().querySelectorAll('[data-correction]')];
    expect(rows.map((r) => r.getAttribute('data-correction'))).toEqual(['c-1', 'c-2']);
    expect(rows[0]?.querySelector('.badge')?.textContent?.trim()).toBe('En attente');
    expect(rows[0]?.querySelector('app-workflow-stepper')).not.toBeNull();
    expect(rows[1]?.classList.contains('highlight')).toBe(true);
    expect(rows[1]?.querySelector('[data-action="cancel-correction"]')).toBeNull();

    rows[0]?.querySelector<HTMLButtonElement>('[data-action="cancel-correction"]')?.click();
    await settle();
    el().querySelector<HTMLButtonElement>('[data-action="confirm-cancel-correction"]')?.click();
    await settle();
    http.expectOne(`${CORRECTIONS}/c-1/cancel`).flush(correctionView({ status: 'cancelled', _actions: [] }));
    await settle();
    http.expectOne(CORRECTIONS).flush({ items: [correctionView({ status: 'cancelled', _actions: [] }), approved] });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Demande de correction annulée.');
    expect(el().querySelector('[data-correction="c-1"] .badge')?.textContent?.trim()).toBe('Annulée');
  });
});
