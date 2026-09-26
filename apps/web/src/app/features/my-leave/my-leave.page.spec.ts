import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { BALANCE_2025, BALANCE_2026, conflict, flushLeaveTypes, leaveSummary, MANAGER_THEN_HR, PERSON } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { MyLeavePage } from './my-leave.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const EMPLOYMENT = {
  id: 'e-1',
  matricule: 'EMP-0001',
  person: PERSON,
  unit: { id: 'a-annaba', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة', kind: 'agency' },
  jobTitle: 'Chargée de clientèle',
  hireDate: '2024-03-01',
};

describe('MyLeavePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'me/leave', component: MyLeavePage }]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['leave.request_self']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(requests = [leaveSummary(), leaveSummary({ id: 'r-2', status: 'rejected', workflow: { ...MANAGER_THEN_HR, status: 'rejected', currentStep: null } })]): Promise<void> {
    await harness.navigateByUrl('/me/leave');
    await settle();
    flushLeaveTypes(http);
    http.expectOne('/api/me/employment').flush(EMPLOYMENT);
    await settle();
    http.expectOne((r) => r.url === '/api/me/leave/balances').flush({ asOf: '2026-09-26', items: [BALANCE_2025, BALANCE_2026] });
    http.expectOne('/api/me/leave/requests').flush({ items: requests });
    await settle();
  }

  it('explains a missing link instead of showing the form, and asks nothing else', async () => {
    await harness.navigateByUrl('/me/leave');
    await settle();
    flushLeaveTypes(http);
    http.expectOne('/api/me/employment').flush({ type: 'about:blank', title: 'Not found', status: 404 }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(el().querySelector('[data-state="not-linked"]')?.textContent).toContain("Votre compte n'est lié à aucun dossier employé");
    expect(el().querySelector('app-leave-request-form')).toBeNull();
    http.expectNone((r) => r.url.startsWith('/api/me/leave'));
  });

  it('renders balance cards per type and reference year, in the UI language', async () => {
    await open();
    expect(el().querySelector('[data-field="me"]')?.textContent).toContain('BENALI Amina');
    const card = el().querySelector('app-balance-cards [data-type="t-annual"]');
    expect(card?.querySelector('h3')?.textContent?.trim()).toBe('Congé annuel');
    const years = [...(card?.querySelectorAll('[data-period]') ?? [])];
    expect(years.map((y) => y.getAttribute('data-period'))).toEqual(['2025-07-01', '2026-07-01']);
    expect(years[0]?.textContent).toContain('Année 2025–2026');
    expect(years[1]?.querySelector('.available strong')?.textContent?.trim()).toBe('0');
    expect(years[1]?.querySelector('.available')?.classList).toContain('low');
    expect(years[1]?.textContent).toContain('8,5');

    TestBed.inject(LanguageService).use('ar', { remember: false });
    await settle();
    expect(card?.querySelector('h3')?.textContent?.trim()).toBe('عطلة سنوية');
    expect(years[1]?.textContent).toContain('8,5'); // ar-DZ writes a decimal comma
    TestBed.inject(LanguageService).use('en', { remember: false });
    await settle();
    expect(years[1]?.textContent).toContain('8.5');
  });

  it('lists my requests with a stepper and cancels a pending one after confirmation', async () => {
    await open();
    const cards = [...el().querySelectorAll('[data-request]')];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelectorAll('app-workflow-stepper li')).toHaveLength(2);
    expect(cards[0]?.querySelector('[aria-current="step"]')?.textContent).toContain('RH régionales');
    expect(cards[1]?.querySelector('[data-action="cancel"]')).toBeNull();

    (el().querySelector('[data-request="r-1"] [data-action="cancel"]') as HTMLButtonElement).click();
    await settle();
    expect((el().querySelector('dialog') as HTMLDialogElement).open).toBe(true);
    (el().querySelector('[data-action="confirm-cancel"]') as HTMLButtonElement).click();
    http.expectOne('/api/me/leave/requests/r-1/cancel').flush(leaveSummary({ status: 'cancelled' }));
    await settle();
    expect((el().querySelector('dialog') as HTMLDialogElement).open).toBe(false);
    expect(el().querySelector('.feedback')?.textContent?.trim()).toBe('Demande annulée.');
    http.expectOne((r) => r.url === '/api/me/leave/balances').flush({ items: [] });
    http.expectOne('/api/me/leave/requests').flush({ items: [] });
    await settle();
    expect(el().querySelector('[data-state="empty"]')).not.toBeNull();
  });

  it('switches to the "not linked" message when a submit answers leave-not-linked', async () => {
    await open([]);
    const select = el().querySelector('select') as HTMLSelectElement;
    select.value = 't-annual';
    select.dispatchEvent(new Event('change'));
    el().querySelector('app-leave-request-form form')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectOne('/api/me/leave/requests').flush(...conflict('leave-not-linked'));
    await settle();
    expect(el().querySelector('[data-state="not-linked"]')).not.toBeNull();
    http.expectOne('/api/me/employment').flush({ type: 'about:blank', title: 'Not found', status: 404 }, { status: 404, statusText: 'Not Found' });
    await settle();
    // The form's pending preview (debounced) may have gone out before the form was removed.
    for (const req of http.match('/api/leave/preview')) req.flush({ days: 1, breakdown: { calendarDays: 1, weekendDays: 0, holidays: [] }, balanceAfter: 1 });
  });
});
