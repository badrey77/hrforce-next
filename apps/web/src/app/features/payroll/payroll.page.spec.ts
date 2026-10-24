import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { problem } from '../../../testing/employee-fixtures';
import { CLOSED_PERIOD_SUMMARY, EMPLOYEE_VARIABLES, OPEN_PERIOD, OPEN_PERIOD_SUMMARY, PAYROLL_EMPLOYEE, RUBRIQUES } from '../../../testing/payroll-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import type { EmployeeVariables, PayrollLine, VariablesPage } from '../../core/payroll/payroll.models';
import { PayrollPage } from './payroll.page';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const PERIODS = '/api/payroll/periods';
const RUBRIQUES_URL = '/api/payroll/rubriques';
const variablesUrl = (month: string) => `/api/payroll/periods/${month}/variables`;

const [ANNUAL_LINE] = EMPLOYEE_VARIABLES.lines as [PayrollLine, PayrollLine];

const ADJUSTED: EmployeeVariables = {
  ...EMPLOYEE_VARIABLES,
  employee: { ...PAYROLL_EMPLOYEE, id: 'emp-28', matricule: 'EMP-0028', person: { ...PAYROLL_EMPLOYEE.person, firstName: 'Lina' } },
  payrollCode: null,
  entry: '2026-10-12',
  flags: ['incomplete_days'],
  incompleteDays: 2,
  lines: [{ ...ANNUAL_LINE, value: 2.5, adjusted: true, note: 'corrigé' }],
};

function page(items: readonly EmployeeVariables[] = [EMPLOYEE_VARIABLES, ADJUSTED], total = items.length): VariablesPage {
  return { items, total, page: 1, pageSize: 50 };
}

describe('PayrollPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  async function setup(permissions: readonly string[] = ['payroll.read', 'payroll.prepare', 'payroll.export', 'payroll.close']): Promise<void> {
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-24T09:00:00Z'), shouldAdvanceTime: true });
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'payroll', component: PayrollPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
    vi.useRealTimers();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();

  /** Opens `url`, answers the month list and the rubriques, then the period and its variables. */
  async function open(url = '/payroll', body: VariablesPage = page(), month = '2026-10'): Promise<TestRequest> {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne((r) => r.url === PERIODS).flush({ items: [{ ...OPEN_PERIOD_SUMMARY, month: '2026-08' }, CLOSED_PERIOD_SUMMARY, OPEN_PERIOD_SUMMARY] });
    http.expectOne(RUBRIQUES_URL).flush({ items: RUBRIQUES });
    await settle();
    http.expectOne(`${PERIODS}/${month}`).flush(month === '2026-10' ? OPEN_PERIOD : { ...OPEN_PERIOD, month });
    const req = http.expectOne((r) => r.url === variablesUrl(month));
    req.flush(body);
    await settle();
    return req;
  }

  it('opens the latest open month by default, with the month bar, the header and the variables', async () => {
    await setup();
    const req = await open();
    expect(req.request.params.get('page')).toBe('1');
    expect(req.request.params.get('pageSize')).toBe('50');
    expect(req.request.params.has('unitId')).toBe(false);
    expect(el().querySelector('[data-month="2026-10"]')?.getAttribute('aria-current')).toBe('true');
    expect(text('[data-month="2026-09"] [data-field="status"]')).toBe('Clôturé v1');
    expect(text('[data-month="2026-10"] [data-field="status"]')).toBe('Ouvert');
    expect(el().querySelector<HTMLButtonElement>('[data-month="2026-11"]')?.disabled).toBe(true);
    expect(el().querySelector<HTMLButtonElement>('[data-action="next-year"]')?.disabled).toBe(true);
    expect(text('h2[data-field="month"]')).toBe('Mois de octobre 2026');
    expect(text('[data-field="cutoff"]')).toBe('Clôture possible à partir du 20/10/2026');
    expect(text('[data-rubrique="CG_ANNUEL"].tile')).toContain('34,5 j');
    expect(text('[data-section="variables"] [role="status"]')).toBe('Salariés : 2');
  });

  it('shows the lines as compact chips: régularisations named, adjusted lines marked, flags in words', async () => {
    await setup();
    await open();
    const first = el().querySelector('[data-employee="emp-27"]') as HTMLElement;
    const chips = [...first.querySelectorAll('.line-chip')].map((c) => c.textContent?.replace(/\s+/g, ' ').trim());
    expect(chips).toEqual(['CG_ANNUEL 3 j', 'Régul. 09/2026 ABS_NJ −1 j']);
    expect(first.querySelector('.line-chip.regularization')).not.toBeNull();
    expect(first.querySelector('[data-field="payroll-code"]')?.textContent).toContain('P-0027');
    expect(first.querySelector('[data-flag="pending_leave"]')?.textContent?.trim()).toBe('Congé en attente');
    const second = el().querySelector('[data-employee="emp-28"]') as HTMLElement;
    expect(second.querySelector('.line-chip.adjusted')?.textContent).toContain('Ajusté');
    expect(second.querySelector('.line-chip')?.textContent).toContain('2,5 j');
    expect(second.querySelector('[data-flag="incomplete_days"]')?.textContent?.trim()).toBe('Jours incomplets : 2');
    expect(second.querySelector('[data-flag="entry"]')?.textContent?.trim()).toBe('Entrée le 12/10');
  });

  it('reads its filters from the URL and sends them to the API', async () => {
    await setup();
    const req = await open('/payroll?month=2026-09&q=ben&rubriqueId=rub-abs&filter=regularization&page=2&pageSize=25', page(), '2026-09');
    const params = req.request.params;
    expect(params.get('q')).toBe('ben');
    expect(params.get('rubriqueId')).toBe('rub-abs');
    expect(params.get('filter')).toBe('regularization');
    expect(params.get('page')).toBe('2');
    expect(params.get('pageSize')).toBe('25');
    expect(el().querySelector<HTMLSelectElement>('#pv-rubrique')?.value).toBe('rub-abs');
    expect(el().querySelector<HTMLSelectElement>('#pv-filter')?.value).toBe('regularization');
    expect(el().querySelector('[data-month="2026-09"]')?.getAttribute('aria-current')).toBe('true');
  });

  it('writes the filters and the month to the URL; « Effacer les filtres » resets them', async () => {
    await setup();
    await open();
    const filter = el().querySelector<HTMLSelectElement>('#pv-filter') as HTMLSelectElement;
    filter.value = 'flagged';
    filter.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/payroll?filter=flagged');
    http.expectOne((r) => r.url === variablesUrl('2026-10') && r.params.get('filter') === 'flagged').flush(page([]));
    await settle();
    expect(text('[data-state="empty"]')).toBe('Aucun salarié ne correspond aux filtres.');

    el().querySelector<HTMLButtonElement>('[data-action="clear"]')?.click();
    await settle();
    expect(router.url).toBe('/payroll');
    http.expectOne((r) => r.url === variablesUrl('2026-10')).flush(page());
    await settle();

    el().querySelector<HTMLButtonElement>('[data-month="2026-09"]')?.click();
    await settle();
    expect(router.url).toBe('/payroll?month=2026-09');
    http.expectOne(`${PERIODS}/2026-09`).flush({ ...OPEN_PERIOD, ...CLOSED_PERIOD_SUMMARY, _actions: ['export'] });
    http.expectOne((r) => r.url === variablesUrl('2026-09')).flush(page());
    await settle();
    expect(el().querySelector('[data-month="2026-09"]')?.getAttribute('aria-current')).toBe('true');
  });

  it('switches the year shown by the month bar without changing the month', async () => {
    await setup();
    await open();
    el().querySelector<HTMLButtonElement>('[data-action="prev-year"]')?.click();
    await settle();
    expect(text('[data-field="year"]')).toBe('2025');
    const req = http.expectOne((r) => r.url === PERIODS);
    expect(req.request.params.get('year')).toBe('2025');
    req.flush({ items: [{ ...CLOSED_PERIOD_SUMMARY, month: '2025-12' }] });
    await settle();
    expect(text('[data-month="2025-12"] [data-field="status"]')).toBe('Clôturé v1');
    expect(el().querySelector<HTMLButtonElement>('[data-month="2025-12"]')?.disabled).toBe(false);
    expect(text('h2[data-field="month"]')).toBe('Mois de octobre 2026');
  });

  it('opens the employee panel from a row (`?employee=`), keyboard reachable', async () => {
    await setup();
    await open();
    const button = el().querySelector<HTMLButtonElement>('[data-employee="emp-27"] [data-action="open-employee"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe('Benali Amine');
    button.click();
    await settle();
    expect(router.url).toBe('/payroll?employee=emp-27');
    http.expectOne(`${variablesUrl('2026-10')}/emp-27`).flush(EMPLOYEE_VARIABLES);
    await settle();
    expect(el().querySelector('dialog[data-panel]')?.hasAttribute('open')).toBe(true);
    expect(el().querySelector('[data-employee="emp-27"]')?.classList.contains('selected')).toBe(true);

    el().querySelector<HTMLButtonElement>('[data-action="close-panel"]')?.click();
    await settle();
    expect(router.url).toBe('/payroll');
  });

  it('asks for Arabic names in Arabic and links the settings for payroll.configure only', async () => {
    await setup(['payroll.read', 'payroll.configure']);
    TestBed.inject(LanguageService).use('ar', { remember: false });
    const req = await open();
    expect(req.request.params.get('lang')).toBe('ar');
    expect(text('h1')).toBe('متغيرات الأجر');
    expect(el().querySelector('[data-action="settings"]')?.getAttribute('href')).toBe('/payroll/settings');
  });

  it('explains a refused list and retries', async () => {
    await setup(['payroll.read']);
    await harness.navigateByUrl('/payroll?month=2026-10');
    await settle();
    http.expectOne((r) => r.url === PERIODS).flush({ items: [OPEN_PERIOD_SUMMARY] });
    http.expectOne(RUBRIQUES_URL).flush({ items: RUBRIQUES });
    http.expectOne(`${PERIODS}/2026-10`).flush(OPEN_PERIOD);
    http.expectOne((r) => r.url === variablesUrl('2026-10')).flush(...problem(403, 'forbidden'));
    await settle();
    expect(text('[data-section="variables"] [role="alert"] p')).toBe("Vous n'avez pas l'autorisation d'accéder à cette ressource.");
    expect(el().querySelector('[data-action="settings"]')).toBeNull();
    el().querySelector<HTMLButtonElement>('[data-section="variables"] [role="alert"] button')?.click();
    await settle();
    http.expectOne((r) => r.url === variablesUrl('2026-10')).flush(page([], 0));
    await settle();
    expect(text('[data-state="empty"]')).toBe('Aucune variable pour ce mois.');
  });
});
