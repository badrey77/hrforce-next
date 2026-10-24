import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { problem } from '../../../testing/employee-fixtures';
import { EMPLOYEE_VARIABLES, RUBRIQUE_PRIME, RUBRIQUES } from '../../../testing/payroll-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { EmployeeVariables, PayrollLine, PeriodStatus, RubriqueView } from '../../core/payroll/payroll.models';
import { addableRubriques, PayrollEmployeePanel } from './employee-panel';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const URL_DETAIL = '/api/payroll/periods/2026-10/variables/emp-27';
const PANIER: RubriqueView = { ...RUBRIQUE_PRIME, id: 'rub-panier', exportCode: 'IND_PANIER_J', names: { fr: 'Indemnité de panier', ar: 'منحة القفة', en: 'Meal allowance' }, unit: 'days' };
const AVANCE_OFF: RubriqueView = { ...RUBRIQUE_PRIME, id: 'rub-avance', exportCode: 'AVANCE', active: false };
const ALL_RUBRIQUES = [...RUBRIQUES, PANIER, AVANCE_OFF];
const PREPARE = ['payroll.read', 'payroll.prepare'];
const [ANNUAL, REGUL] = EMPLOYEE_VARIABLES.lines as [PayrollLine, PayrollLine];

function fill(root: ParentNode, selector: string, value: string): void {
  const input = root.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  input.dispatchEvent(new Event('blur'));
}

async function submit(form: Element | null): Promise<void> {
  form?.dispatchEvent(new Event('submit'));
  await settle();
}

describe('addableRubriques', () => {
  it('offers active manual rubriques not already on a line of the month; amounts only with salary update', () => {
    const withPanier: EmployeeVariables = {
      ...EMPLOYEE_VARIABLES,
      lines: [...EMPLOYEE_VARIABLES.lines, { ...ANNUAL, rubriqueId: 'rub-panier', source: 'manual', computed: null }],
    };
    expect(addableRubriques(ALL_RUBRIQUES, EMPLOYEE_VARIABLES, '2026-10', false).map((r) => r.id)).toEqual(['rub-panier']);
    expect(addableRubriques(ALL_RUBRIQUES, EMPLOYEE_VARIABLES, '2026-10', true).map((r) => r.id)).toEqual(['rub-prime', 'rub-panier']);
    expect(addableRubriques(ALL_RUBRIQUES, withPanier, '2026-10', true).map((r) => r.id)).toEqual(['rub-prime']);
  });
});

describe('PayrollEmployeePanel', () => {
  let fixture: ComponentFixture<PayrollEmployeePanel>;
  let http: HttpTestingController;
  let closed: number;
  let changed: number;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function mount(
    permissions: readonly string[] = PREPARE,
    view: EmployeeVariables = EMPLOYEE_VARIABLES,
    status: PeriodStatus | null = 'open',
  ): Promise<void> {
    TestBed.inject(Session).set(meWith(permissions));
    fixture = TestBed.createComponent(PayrollEmployeePanel);
    fixture.componentRef.setInput('month', '2026-10');
    fixture.componentRef.setInput('employeeId', 'emp-27');
    fixture.componentRef.setInput('status', status);
    fixture.componentRef.setInput('rubriques', ALL_RUBRIQUES);
    closed = 0;
    changed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.componentInstance.changed.subscribe(() => changed++);
    await settle();
    http.expectOne(URL_DETAIL).flush(view);
    await settle();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const line = (code: string) => el().querySelector(`[data-line="${code}"]`) as HTMLElement;

  it('opens as a dialog with the employee, links, flags and every line', async () => {
    await mount();
    expect(el().querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(text('#pe-title')).toBe('Benali Amine');
    expect(el().querySelector('[data-link="employee"]')?.getAttribute('href')).toBe('/employees/emp-27');
    expect(el().querySelector('[data-link="attendance"]')?.getAttribute('href')).toBe('/employees/emp-27?tab=attendance&date=2026-10-01');
    expect(text('[data-flag="pending_leave"]')).toBe('Congé en attente');
    expect(text('[data-line="CG_ANNUEL"] [data-field="computed"]')).toBe('Calculé : 3 j');
    expect(text('[data-line="ABS_NJ"] [data-field="origin"]')).toBe('Régul. 09/2026');
    expect(line('CG_ANNUEL').querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe('3');
    expect(line('ABS_NJ').querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe('-1');
    // not adjusted: nothing to revert
    expect(line('CG_ANNUEL').querySelector('[data-action="revert-line"]')).toBeNull();
    expect(el().querySelector<HTMLInputElement>('#pe-code')?.value).toBe('P-0027');
  });

  it('saves HR\'s value and note (comma decimals); a régularisation line names its origin month', async () => {
    await mount();
    const annual = line('CG_ANNUEL');
    fill(annual, 'input[inputmode="decimal"]', '2,5');
    fill(annual, '.note-field input', '  demi-journée  ');
    await submit(annual.querySelector('form'));
    const put = http.expectOne(`${URL_DETAIL}/lines`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ rubriqueId: 'rub-annual', value: 2.5, note: 'demi-journée' });
    const saved: EmployeeVariables = { ...EMPLOYEE_VARIABLES, lines: [{ ...ANNUAL, value: 2.5, adjusted: true, note: 'demi-journée' }, REGUL] };
    put.flush(saved);
    await settle();
    expect(text('[data-feedback]')).toBe('La ligne est enregistrée.');
    expect(changed).toBe(1);
    expect(line('CG_ANNUEL').querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe('2,5');
    expect(text('[data-line="CG_ANNUEL"] [data-field="adjusted"]')).toBe('Ajusté');

    const regul = line('ABS_NJ');
    fill(regul, 'input[inputmode="decimal"]', '0');
    await submit(regul.querySelector('form'));
    const put2 = http.expectOne(`${URL_DETAIL}/lines`);
    expect(put2.request.body).toEqual({ rubriqueId: 'rub-abs', originMonth: '2026-09', value: 0, note: null });
    put2.flush(...problem(409, 'payroll-period-closed'));
    await settle();
    expect(text('[data-line="ABS_NJ"] [data-error="line"]')).toBe('Ce mois est clôturé.');
  });

  it('refuses a value that is not a number with two decimals at most, without asking the server', async () => {
    await mount();
    const annual = line('CG_ANNUEL');
    fill(annual, 'input[inputmode="decimal"]', '1,234');
    await submit(annual.querySelector('form'));
    expect(text('[data-line="CG_ANNUEL"] [data-error="value"]')).toBe('Veuillez saisir un nombre (deux décimales au plus).');
    expect(annual.querySelector('input[inputmode="decimal"]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('« Revenir au calcul » removes HR\'s value of a régularisation line by its origin month', async () => {
    const adjusted: EmployeeVariables = { ...EMPLOYEE_VARIABLES, lines: [ANNUAL, { ...REGUL, value: 0.5, adjusted: true }] };
    await mount(PREPARE, adjusted);
    const regul = line('ABS_NJ');
    expect(regul.querySelector('[data-action="revert-line"]')?.textContent?.trim()).toBe('Revenir au calcul');
    (regul.querySelector('[data-action="revert-line"]') as HTMLButtonElement).click();
    await settle();
    const del = http.expectOne((r) => r.url === `${URL_DETAIL}/lines/rub-abs`);
    expect(del.request.method).toBe('DELETE');
    expect(del.request.params.get('originMonth')).toBe('2026-09');
    del.flush(EMPLOYEE_VARIABLES);
    await settle();
    expect(changed).toBe(1);
  });

  it('adds a manual rubrique; amount rubriques are offered only with employee.salary.update', async () => {
    await mount();
    const options = [...el().querySelectorAll<HTMLOptionElement>('#pe-add-rubrique option')].map((o) => o.value);
    expect(options).toEqual(['', 'rub-panier']);
    const form = el().querySelector('[data-form="add-line"]');
    await submit(form);
    expect(text('[data-error="rubriqueId"]')).toBe('Veuillez choisir une rubrique.');
    fill(el(), '#pe-add-rubrique', 'rub-panier');
    fill(el(), '#pe-add-value', '4');
    await settle();
    expect(text('label[for="pe-add-value"]')).toBe('Valeur (j)');
    await submit(form);
    const put = http.expectOne(`${URL_DETAIL}/lines`);
    expect(put.request.body).toEqual({ rubriqueId: 'rub-panier', value: 4, note: null });
    put.flush(...problem(422, null, [{ field: 'rubriqueId', code: 'inactive', message: 'inactive' }]));
    await settle();
    expect(text('[data-error="add"]')).toBe('Cette rubrique n’est plus active.');
  });

  it('offers amounts with salary update and shows the manual line with « Retirer la ligne »', async () => {
    const manual: EmployeeVariables = {
      ...EMPLOYEE_VARIABLES,
      lines: [{ rubriqueId: 'rub-prime', exportCode: 'PRIME_REND', names: RUBRIQUE_PRIME.names, unit: 'amount', source: 'manual', originMonth: '2026-10', computed: null, value: 15000, adjusted: true, note: null }],
    };
    await mount([...PREPARE, 'employee.salary.read', 'employee.salary.update'], manual);
    expect(text('[data-line="PRIME_REND"] [data-field="computed"]')).toBe('Saisie manuelle');
    expect(line('PRIME_REND').querySelector('[data-action="revert-line"]')?.textContent?.trim()).toBe('Retirer la ligne');
    const options = [...el().querySelectorAll<HTMLOptionElement>('#pe-add-rubrique option')].map((o) => o.value);
    expect(options).toEqual(['', 'rub-panier']);
  });

  it('shows an amount line read-only to someone who can read but not update salaries', async () => {
    const manual: EmployeeVariables = {
      ...EMPLOYEE_VARIABLES,
      lines: [{ rubriqueId: 'rub-prime', exportCode: 'PRIME_REND', names: RUBRIQUE_PRIME.names, unit: 'amount', source: 'manual', originMonth: '2026-10', computed: null, value: 15000, adjusted: true, note: 'T3' }],
    };
    await mount([...PREPARE, 'employee.salary.read'], manual);
    expect(line('PRIME_REND').querySelector('form')).toBeNull();
    expect(text('[data-line="PRIME_REND"] [data-field="value"]')).toBe('Valeur 15 000 DA');
  });

  it('is read-only for a closed month and without payroll.prepare', async () => {
    await mount(PREPARE, EMPLOYEE_VARIABLES, 'closed');
    expect(text('[data-state="read-only"]')).toBe('Ce mois est clôturé : consultation seule.');
    expect(el().querySelector('[data-line] form')).toBeNull();
    expect(el().querySelector('[data-form="add-line"]')).toBeNull();
    expect(text('[data-line="CG_ANNUEL"] [data-field="value"]')).toBe('Valeur 3 j');
    fixture.destroy();

    await mount(['payroll.read'], { ...EMPLOYEE_VARIABLES, _actions: [] });
    expect(text('[data-state="read-only"]')).toBe('Consultation seule.');
    expect(el().querySelector('[data-form="code"]')).toBeNull();
    expect(text('[data-field="code"]')).toBe('P-0027');
  });

  it('sets and clears the payroll matricule; a code already used is shown on the field', async () => {
    await mount();
    fill(el(), '#pe-code', 'bad code!');
    await submit(el().querySelector('[data-form="code"]'));
    expect(text('[data-error="code"]')).toBe('Lettres, chiffres, _ . - seulement, 20 caractères au plus.');

    fill(el(), '#pe-code', 'P-0099');
    await submit(el().querySelector('[data-form="code"]'));
    const put = http.expectOne('/api/payroll/employee-codes/emp-27');
    expect(put.request.body).toEqual({ code: 'P-0099' });
    put.flush(...problem(409, 'payroll-matricule-taken'));
    await settle();
    expect(text('[data-error="code"]')).toBe('Ce matricule paie est déjà utilisé par un autre salarié.');

    fill(el(), '#pe-code', '');
    await submit(el().querySelector('[data-form="code"]'));
    const clear = http.expectOne('/api/payroll/employee-codes/emp-27');
    expect(clear.request.body).toEqual({ code: null });
    clear.flush({ employeeId: 'emp-27', code: null });
    await settle();
    expect(text('[data-feedback]')).toBe('Le matricule paie est retiré : le matricule sera exporté.');
    expect(changed).toBe(1);
  });

  it('closes on « Fermer » and explains an employee out of scope', async () => {
    TestBed.inject(Session).set(meWith(PREPARE));
    fixture = TestBed.createComponent(PayrollEmployeePanel);
    fixture.componentRef.setInput('month', '2026-10');
    fixture.componentRef.setInput('employeeId', 'emp-27');
    closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await settle();
    http.expectOne(URL_DETAIL).flush(...problem(404, null));
    await settle();
    expect(text('[role="alert"] p')).toBe('Ce salarié n’est pas dans votre périmètre.');
    (el().querySelector('[data-action="close-panel"]') as HTMLButtonElement).click();
    await settle();
    expect(closed).toBe(1);
  });
});
