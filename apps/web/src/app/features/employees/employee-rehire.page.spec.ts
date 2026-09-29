import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { detail, problem, UNIT_ANNABA } from '../../../testing/employee-fixtures';
import { ORG_KIND_LIST, SITES } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { EMPLOYEES_ROUTES } from './employees.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

/** An employment that ended on 2025-06-30 (resignation): its person can be rehired. */
const ENDED: EmployeeDetail = detail({ endDate: '2025-06-30', endReason: 'resignation', status: 'ended', _actions: [] });
const REHIRER = ['employee.read', 'employee.create', 'employee.salary.update', 'site.read', 'org_unit.read'];

describe('EmployeeRehirePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function setup(permissions: readonly string[] = REHIRER): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'employees', children: EMPLOYEES_ROUTES }, { path: '**', children: [] }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
  }

  /** Opens the page and answers the reference requests (the previous employment, kinds, sites, the preset unit). */
  async function open(previous: EmployeeDetail = ENDED): Promise<void> {
    await harness.navigateByUrl('/employees/e-1/rehire');
    await settle();
    http.expectOne('/api/employees/e-1').flush(previous);
    await settle();
    http.match('/api/org/kinds').forEach((r) => r.flush(ORG_KIND_LIST));
    http.match((r) => r.url === '/api/org/sites').forEach((r) => r.flush({ items: SITES }));
    http
      .match((r) => r.url.startsWith('/api/org/units/'))
      .forEach((r) => r.flush({ ...UNIT_ANNABA, site: null, path: [{ id: 'r-est', name: 'Région Est' }] }));
    await settle();
  }

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const input = (id: string) => el().querySelector(`#${id}`) as HTMLInputElement;

  function fill(id: string, value: string): void {
    input(id).value = value;
    input(id).dispatchEvent(new Event('input'));
    input(id).dispatchEvent(new Event('blur'));
  }

  async function submit(): Promise<void> {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
  }

  it('shows the identity read-only and prefills the new employment from the previous one', async () => {
    await setup();
    await open();
    expect(text('h1')).toBe('Réembaucher BENALI Amina');
    // Identity is shown, not editable: no identity inputs at all.
    expect(text('[data-panel="person"]')).toContain('109901234567890123');
    expect(el().querySelector('#new-last-name, [formcontrolname="lastName"]')).toBeNull();
    expect(text('[data-panel="previous"]')).toContain('EMP-0001');
    expect(text('[data-panel="previous"]')).toContain('Démission');
    // Hire date: the day after the end (in the past here → today would be later, so today).
    expect(input('rehire-hire-date').min).toBe('2025-07-01');
    expect(input('rehire-hire-date').value >= '2025-07-01').toBe(true);
    expect(input('rehire-job-title').value).toBe('Chargée de clientèle');
    expect(el().querySelector('[data-section="salary"]')).not.toBeNull();
  });

  it('posts personId + the new employment only (no person fields), matricule upper-cased, then opens the new employee', async () => {
    await setup();
    await open();
    fill('rehire-matricule', 'emp-0100');
    fill('rehire-hire-date', '2025-09-01');
    fill('rehire-salary', '90000');
    expect(input('rehire-matricule').value).toBe('EMP-0100');
    await submit();

    const post = http.expectOne('/api/employees');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual({
      personId: 'p-1',
      matricule: 'EMP-0100',
      hireDate: '2025-09-01',
      orgUnitId: 'a-annaba',
      siteId: null,
      jobTitle: 'Chargée de clientèle',
      salary: { baseSalary: '90000.00' },
    });
    post.flush(detail({ id: 'e-9' }), { status: 201, statusText: 'Created' });
    const router = TestBed.inject(Router);
    for (let i = 0; i < 150 && router.url !== '/employees/e-9'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      TestBed.tick();
    }
    expect(router.url).toBe('/employees/e-9');
    http.match('/api/employees/e-9').forEach((r) => r.flush(detail({ id: 'e-9' })));
    await settle();
  });

  it('refuses a hire date on or before the previous end on the client', async () => {
    await setup();
    await open();
    fill('rehire-matricule', 'EMP-0100');
    fill('rehire-hire-date', '2025-06-30');
    await submit();
    http.expectNone('/api/employees');
    expect(text('#rehire-hire-date-error')).toContain('2025-07-01');
  });

  it('maps the API problems: employment-open above the form, hire-date and matricule-taken on their fields', async () => {
    await setup();
    await open();
    fill('rehire-matricule', 'EMP-0100');
    fill('rehire-hire-date', '2025-09-01');

    await submit();
    http
      .expectOne('/api/employees')
      .flush(...problem(409, 'employment-open', [{ field: 'personId', code: 'employment-open', message: 'open' }]));
    await settle();
    expect(text('[role="alert"]')).toBe('Cette personne a déjà un emploi en cours.');

    await submit();
    http.expectOne('/api/employees').flush(...problem(409, 'hire-date', [{ field: 'hireDate', code: 'hire-date', message: 'overlap' }]));
    await settle();
    expect(text('#rehire-hire-date-error')).toBe("La date d'embauche doit suivre la fin de l'emploi précédent de cette personne.");

    fill('rehire-hire-date', '2025-10-01');
    await submit();
    http
      .expectOne('/api/employees')
      .flush(...problem(409, 'matricule-taken', [{ field: 'matricule', code: 'taken', message: 'taken' }]));
    await settle();
    expect(text('#rehire-matricule-error')).toBe('Ce matricule est déjà utilisé.');

    fill('rehire-matricule', 'EMP-0101');
    await submit();
    http
      .expectOne('/api/employees')
      .flush(...problem(422, null, [{ field: 'personId', code: 'not_found', message: 'The person does not exist.' }]));
    await settle();
    expect(text('[role="alert"]')).toBe('Employé introuvable.');
  });

  it('an employment without an end date offers no form', async () => {
    await setup();
    await open(detail());
    expect(el().querySelector('form')).toBeNull();
    expect(text('[data-state="open"]')).toContain("Cet emploi n'est pas terminé");
  });

  it('a person who already has an open employment gets a message, not the form', async () => {
    await setup();
    await open({ ...ENDED, person: { ...ENDED.person, hasOpenEmployment: true } });
    expect(el().querySelector('form')).toBeNull();
    expect(text('[data-state="person-employed"]')).toContain('a déjà un emploi en cours');
  });

  it('without employee.create the route does not match', async () => {
    await setup(['employee.read']);
    await harness.navigateByUrl('/employees/e-1/rehire');
    await settle();
    http.expectNone('/api/employees/e-1');
    expect(harness.routeNativeElement?.querySelector('form') ?? null).toBeNull(); // the catch-all route, not the form
  });
});
