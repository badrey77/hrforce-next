import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ADMIN_PERMISSIONS, meWith } from '../../../testing/auth-fixtures';
import { detail, problem } from '../../../testing/employee-fixtures';
import { ORG_KIND_LIST, SITES } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { OrgUnitSummary } from '../../core/org/org.models';
import { ORG_UNIT_PICKER_DEBOUNCE_MS } from '../../shared/org-unit-picker/org-unit-picker';
import { EMPLOYEES_ROUTES } from './employees.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const SENSITIVE_WRITE = ['employee.salary.update', 'employee.bank.update', 'employee.nss.update'];
const AG_ANNABA: OrgUnitSummary = {
  id: 'a-annaba',
  kind: 'agency',
  code: 'AG-ANNABA',
  name: 'Agence Annaba',
  site: null,
  path: [{ id: 'r-est', name: 'Région Est' }],
};

describe('EmployeeCreatePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function setup(permissions: readonly string[]): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'employees', children: EMPLOYEES_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/employees/new');
    await settle();
    http.match('/api/org/kinds').forEach((r) => r.flush(ORG_KIND_LIST));
    http.match((r) => r.url === '/api/org/sites').forEach((r) => r.flush({ items: SITES }));
    await settle();
  }

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const sections = () => [...el().querySelectorAll('fieldset')].map((f) => f.getAttribute('data-section'));
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  }

  async function submit(): Promise<void> {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
  }

  async function pickUnit(): Promise<void> {
    const input = el().querySelector('#new-unit') as HTMLInputElement;
    input.value = 'annaba';
    input.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, ORG_UNIT_PICKER_DEBOUNCE_MS + 20));
    const search = http.expectOne((r) => r.url === '/api/org/units');
    expect(search.request.params.get('asOf')).toBe('2025-02-01'); // the picker follows the hire date
    search.flush({ items: [AG_ANNABA] });
    await settle();
    (el().querySelector('[role="option"]') as HTMLElement).click();
    await settle();
  }

  async function fillRequired(): Promise<void> {
    fill('new-last-name', ' BENALI ');
    fill('new-first-name', 'Amina');
    fill('new-matricule', 'EMP-0042');
    fill('new-hire-date', '2025-02-01');
    fill('new-job-title', 'Chargée de clientèle');
    await settle();
    await pickUnit();
  }

  it('shows the sensitive sections only with the matching .update permission', async () => {
    await setup(['employee.read', 'employee.create', 'employee.salary.update']);
    expect(sections()).toEqual(['identity', 'employment', 'assignment', 'salary']);
  });

  it('without any sensitive .update permission: only the three base sections, and no site select without site.read', async () => {
    await setup(['employee.read', 'employee.create', 'org_unit.read']);
    expect(sections()).toEqual(['identity', 'employment', 'assignment']);
    expect(el().querySelector('#new-site')).toBeNull();
  });

  it('validates on the client: required fields, NIN/RIB/NSS digits, money, bank both-or-neither, birth before hire', async () => {
    await setup([...ADMIN_PERMISSIONS, ...SENSITIVE_WRITE]);
    expect(sections()).toEqual(['identity', 'employment', 'assignment', 'salary', 'bank', 'nss']);
    fill('new-nin', '123');
    fill('new-rib', '0040 0123');
    fill('new-nss', '12');
    fill('new-salary', '85000.123');
    fill('new-matricule', 'emp 1');
    fill('new-birth-date', '2030-01-01');
    await submit();
    http.expectNone('/api/employees');

    expect(text('[role="alert"]')).toBe('Corrigez les champs signalés avant d’enregistrer.');
    expect(text('#new-last-name-error')).toBe('Ce champ est obligatoire.');
    expect(text('#new-nin-error')).toBe('18 chiffres attendus.');
    expect(text('#new-rib-error')).toBe('20 chiffres attendus.');
    expect(text('#new-nss-error')).toBe('10–15 chiffres attendus.');
    expect(text('#new-salary-error')).toBe('Montant positif, 2 décimales au plus.');
    expect(text('#new-matricule-error')).toBe('Format invalide.');
    expect(el().querySelector('[data-error="bankIncomplete"]')).not.toBeNull();
    expect(el().querySelector('[data-error="birthAfterHire"]')).not.toBeNull();
  });

  it('posts the nested form as the contract body (sensitive blocks only when filled) and opens the new employee', async () => {
    await setup([...ADMIN_PERMISSIONS, ...SENSITIVE_WRITE]);
    await fillRequired();
    fill('new-last-name-ar', 'بن علي');
    fill('new-nin', '1099 0123 4567 8901 23');
    fill('new-salary', '85000,5');
    await submit();

    const post = http.expectOne('/api/employees');
    expect(post.request.method).toBe('POST');
    // The nested form is flattened to the API's body; blocks only when filled in.
    expect(post.request.body).toEqual({
      lastName: 'BENALI',
      firstName: 'Amina',
      lastNameAr: 'بن علي',
      firstNameAr: null,
      birthDate: null,
      birthPlace: null,
      sex: null,
      nationality: 'DZ',
      nin: '109901234567890123',
      matricule: 'EMP-0042',
      hireDate: '2025-02-01',
      orgUnitId: 'a-annaba',
      siteId: null,
      jobTitle: 'Chargée de clientèle',
      salary: { baseSalary: '85000.50' },
    });
    post.flush(detail({ id: 'e-42' }), { status: 201, statusText: 'Created' });
    const router = TestBed.inject(Router);
    // The detail page is a lazy chunk: the navigation completes once it has loaded.
    for (let i = 0; i < 150 && router.url !== '/employees/e-42'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      TestBed.tick();
    }
    expect(router.url).toBe('/employees/e-42');
    http.match('/api/employees/e-42').forEach((r) => r.flush(detail({ id: 'e-42' })));
    await settle();
  });

  it('maps 409 matricule-taken and nin-taken onto their fields in the nested groups', async () => {
    await setup(['employee.read', 'employee.create', 'org_unit.read']);
    await fillRequired();
    fill('new-nin', '109901234567890123');
    await submit();
    http
      .expectOne('/api/employees')
      .flush(...problem(409, 'matricule-taken', [{ field: 'matricule', code: 'taken', message: 'taken' }]));
    await settle();
    expect(text('#new-matricule-error')).toBe('Ce matricule est déjà utilisé.');
    expect(el().querySelector('.form-error[role="alert"]')).toBeNull();

    fill('new-matricule', 'EMP-0043'); // a new value clears the server error
    await submit();
    http.expectOne('/api/employees').flush(...problem(409, 'nin-taken'));
    await settle();
    expect(text('#new-nin-error')).toBe('Ce NIN est déjà enregistré pour une autre personne.');
  });

  it('maps 403 forbidden-field onto the sensitive field and forbidden-scope onto the unit picker', async () => {
    await setup([...ADMIN_PERMISSIONS, ...SENSITIVE_WRITE]);
    await fillRequired();
    fill('new-rib', '00400123456789012345');
    fill('new-bank-name', 'BNA');
    await submit();
    http.expectOne('/api/employees').flush(...problem(403, 'forbidden-field', [{ field: 'rib', code: 'forbidden', message: '' }]));
    await settle();
    expect(text('#new-rib-error')).toBe("Vous n'avez pas le droit de renseigner ce champ.");

    fill('new-rib', '');
    fill('new-bank-name', '');
    await submit();
    http.expectOne('/api/employees').flush(...problem(403, 'forbidden-scope'));
    await settle();
    expect(text('#new-unit-error')).toBe("Vous n'avez pas le droit d'affecter un employé à cette unité.");
  });
});
