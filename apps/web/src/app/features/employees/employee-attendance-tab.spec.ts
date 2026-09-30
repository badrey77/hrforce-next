import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { attendanceProblem, correctionView, day, EMPLOYEE_REF, employeeDays, punch } from '../../../testing/attendance-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { detail } from '../../../testing/employee-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { EmployeeAttendanceTab } from './employee-attendance-tab';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe('EmployeeAttendanceTab', () => {
  let fixture: ComponentFixture<EmployeeAttendanceTab>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const EMPLOYEE = detail({ id: 'e-30' });

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['attendance.read', 'attendance.manage']));
  });

  afterEach(() => http.verify());

  async function open(canManage = true, date: string | null = '2026-08-12'): Promise<void> {
    fixture = TestBed.createComponent(EmployeeAttendanceTab);
    fixture.componentRef.setInput('employee', EMPLOYEE);
    fixture.componentRef.setInput('date', date);
    await settle();
    const days = http.expectOne((r) => r.url === '/api/employees/e-30/attendance/days');
    expect(days.request.params.get('from')).toBe('2026-08-01');
    expect(days.request.params.get('to')).toBe('2026-08-31');
    days.flush(
      employeeDays(
        [
          day({
            date: '2026-08-12',
            final: true,
            punches: [
              punch({ id: 'p-live', workDate: '2026-08-12', _actions: ['void'] }),
              punch({
                id: 'p-void',
                direction: 'out',
                localTime: '08:00',
                workDate: '2026-08-12',
                source: 'manual',
                kiosk: null,
                reason: 'Pointage en double',
                createdBy: { id: 'u-karim', displayName: 'Karim Haddad' },
                status: 'void',
                void: { at: '2026-08-12T10:00:00Z', by: { id: 'u-karim', displayName: 'Karim Haddad' }, reason: 'Erreur de saisie', correctionId: null },
              }),
            ],
          }),
        ],
        canManage,
      ),
    );
    http.expectOne((r) => r.url === '/api/employees/e-30/attendance/schedule').flush({
      items: [
        {
          from: '2026-08-01',
          to: '2026-08-31',
          schedule: { id: 's', code: 'agence', labels: { fr: 'Horaire agence', ar: 'توقيت الوكالة', en: 'Branch' } },
          source: 'site',
          sourceRef: { kind: 'site', id: 's-cne', code: 'CNE', name: 'Constantine' },
          overrides: [],
        },
      ],
    });
    if (canManage) http.match((r) => r.url === '/api/org/sites').forEach((r) => r.flush({ items: [] }));
    // Phase B: the month's correction requests of THIS employment (every status).
    const corrections = http.expectOne((r) => r.url === '/api/attendance/corrections');
    expect(corrections.request.params.get('employmentId')).toBe('e-30');
    expect(corrections.request.params.has('q')).toBe(false);
    expect(corrections.request.params.get('from')).toBe('2026-08-01');
    expect(corrections.request.params.has('status')).toBe(false);
    corrections.flush({
      items: [correctionView({ id: 'c-mine', date: '2026-08-12', employee: { ...EMPLOYEE_REF, id: 'e-30' } })],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    await settle();
  }

  it('starts at the month of the linked date, opens that day, and explains where the schedule comes from', async () => {
    await open();
    expect(el().querySelector('[data-panel="segments"]')?.textContent).toContain('Horaire agence');
    expect(el().querySelector('[data-panel="segments"]')?.textContent).toContain('CNE');
    expect(el().querySelector('[data-day="2026-08-12"] details')?.hasAttribute('open')).toBe(true);
    const voided = el().querySelector('[data-punch="p-void"]');
    expect(voided?.classList).toContain('void');
    expect(voided?.textContent).toContain('Erreur de saisie');
    expect(voided?.querySelector('[data-action="void-punch"]')).toBeNull();
    const corrections = [...el().querySelectorAll('[data-panel="employee-corrections"] [data-correction]')];
    expect(corrections.map((c) => c.getAttribute('data-correction'))).toEqual(['c-mine']);
    expect(corrections[0]?.querySelector('a')?.getAttribute('href')).toBe('/attendance/corrections/c-mine');
    // The Présence tab never offers the employee's own correction button.
    expect(el().querySelector('[data-action="request-correction"]')).toBeNull();
  });

  it('adds a manual punch with a reason, and maps a same-minute conflict to the time field', async () => {
    await open();
    (el().querySelector<HTMLButtonElement>('[data-action="add-punch"]') as HTMLButtonElement).click();
    await settle();
    const dialog = (el().querySelector<HTMLDialogElement>('dialog[aria-labelledby="add-punch-title"]') as HTMLDialogElement);
    expect(dialog.open).toBe(true);
    const time = (dialog.querySelector<HTMLInputElement>('#manual-time') as HTMLInputElement);
    time.value = '08:05';
    time.dispatchEvent(new Event('input'));
    const reason = (dialog.querySelector<HTMLTextAreaElement>('#manual-reason') as HTMLTextAreaElement);
    reason.value = 'Téléphone en panne';
    reason.dispatchEvent(new Event('input'));
    (dialog.querySelector<HTMLButtonElement>('[data-action="confirm-add"]') as HTMLButtonElement).click();
    await settle();
    const conflict = http.expectOne('/api/employees/e-30/attendance/punches');
    expect(conflict.request.body).toEqual({ direction: 'in', date: '2026-08-12', time: '08:05', reason: 'Téléphone en panne' });
    const { body, options } = attendanceProblem(409, 'attendance-punch-exists');
    conflict.flush(body, options);
    await settle();
    expect(dialog.querySelector('#manual-time-error')?.textContent).toContain('Un pointage existe déjà à cette minute.');

    time.value = '08:06';
    time.dispatchEvent(new Event('input'));
    (dialog.querySelector<HTMLButtonElement>('[data-action="confirm-add"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne('/api/employees/e-30/attendance/punches').flush(punch({ id: 'p-new', source: 'manual', workDate: '2026-08-12' }));
    await settle();
    expect(dialog.open).toBe(false);
    expect(el().querySelector('.feedback')?.textContent).toContain('Pointage enregistré.');
    http.expectOne((r) => r.url === '/api/employees/e-30/attendance/days').flush(employeeDays([]));
    http.expectOne((r) => r.url === '/api/employees/e-30/attendance/schedule').flush({ items: [] });
  });

  it('voids a punch after a required reason; self-management is explained', async () => {
    await open();
    (el().querySelector<HTMLButtonElement>('[data-punch="p-live"] [data-action="void-punch"]') as HTMLButtonElement).click();
    await settle();
    const dialog = (el().querySelector<HTMLDialogElement>('dialog[aria-labelledby="void-title"]') as HTMLDialogElement);
    (dialog.querySelector<HTMLButtonElement>('[data-action="confirm-void"]') as HTMLButtonElement).click();
    await settle();
    http.expectNone('/api/attendance/punches/p-live/void');
    expect(dialog.querySelector('#void-reason-error')?.textContent).toContain('Le motif est obligatoire.');

    const reason = (dialog.querySelector<HTMLTextAreaElement>('#void-reason') as HTMLTextAreaElement);
    reason.value = 'Pointage en double';
    reason.dispatchEvent(new Event('input'));
    (dialog.querySelector<HTMLButtonElement>('[data-action="confirm-void"]') as HTMLButtonElement).click();
    const { body, options } = attendanceProblem(409, 'attendance-self-manage');
    http.expectOne('/api/attendance/punches/p-live/void').flush(body, options);
    await settle();
    expect(dialog.querySelector('.form-error')?.textContent).toContain('Vous ne pouvez pas gérer vos propres pointages.');
  });

  it('hides the add button when the API says the caller cannot manage this employee', async () => {
    await open(false);
    expect(el().querySelector('[data-action="add-punch"]')).toBeNull();
  });
});
