import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { detail, problem } from '../../../testing/employee-fixtures';
import { ORG_KIND_LIST, SITES } from '../../../testing/org-fixtures';
import { applicationDetail, hirePrefill, KNOWN_PERSON, openingView, recruitmentProblem, UNIT_ANNABA } from '../../../testing/recruitment-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { routes } from '../../app.routes';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';

const HIRER = ['recruitment.read', 'recruitment.manage', 'recruitment.hire', 'employee.read', 'employee.create', 'org_unit.read'];
const PREFILL = '/api/recruitment/applications/a-1/hire-prefill';
const HIRE = '/api/recruitment/applications/a-1/hire';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe('EmployeeHirePage — the hire of a candidate (docs/contracts/recruitment.md › Hire)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  async function setup(permissions: readonly string[] = HIRER): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      // The real route table: the hire URL sits beside `/recruitment` and lands on `/employees/:id`.
      providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
  }

  afterEach(() => {
    // Root stores and pages reached after the hire: not what these tests are about.
    for (const req of http.match((r) => !r.url.startsWith('/api/recruitment/applications/'))) if (!req.cancelled) req.flush({ items: [] });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const value = (selector: string) => (el().querySelector(selector) as HTMLInputElement).value;

  async function one(method: string, url: string): Promise<TestRequest> {
    const wanted = (r: { method: string; url: string }) => r.method === method && r.url === url;
    for (let turn = 0; turn < 200; turn++) {
      const found = http.match(wanted).filter((req) => !req.cancelled);
      if (found.length === 1 && found[0]) return found[0];
      if (found.length > 1) throw new Error(`${found.length} requests for ${method} ${url}, expected one`);
      await settle();
    }
    throw new Error(`No request for ${method} ${url}`);
  }

  function nextNavigation(): Promise<void> {
    return new Promise((resolve) => {
      const subscription = router.events.subscribe((event) => {
        if (event instanceof NavigationEnd) {
          subscription.unsubscribe();
          resolve();
        }
      });
    });
  }

  function fill(id: string, text_: string): void {
    const input = el().querySelector(`#${id}`) as HTMLInputElement;
    input.value = text_;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  }

  /** Opens the hire page and answers the prefill and the form's reference requests (kinds, sites, the preset unit). */
  async function open(prefill = hirePrefill(), url = '/recruitment/applications/a-1/hire'): Promise<void> {
    await harness.navigateByUrl(url);
    (await one('GET', PREFILL)).flush(prefill);
    await settle();
    http.match('/api/org/kinds').forEach((r) => r.flush(ORG_KIND_LIST));
    http.match((r) => r.url === '/api/org/sites').forEach((r) => r.flush({ items: SITES }));
    http.match((r) => r.url.startsWith('/api/org/units/')).forEach((r) => r.flush({ ...UNIT_ANNABA, site: null, path: [{ id: 'r-est', name: 'Région Est' }] }));
    await settle();
  }

  async function submit(): Promise<void> {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
  }

  it('is refused without recruitment.hire or without employee.create (not found, nothing asked)', async () => {
    await setup(['recruitment.read', 'recruitment.hire']);
    await harness.navigateByUrl('/recruitment/applications/a-1/hire');
    await settle();
    expect(el().querySelector('app-employee-hire-page')).toBeNull();
    http.expectNone(PREFILL);
  });

  it('a new person: the create-employee form prefilled from the candidate and the offer, the CV ticked, and the hire body', async () => {
    await setup();
    await open();
    expect(text('[data-panel="hire-banner"]')).toBe('Embauche pour REC-2026-0001 — Chargé(e) de clientèle (Agence Annaba)');
    expect(el().querySelector('[data-action="back"]')?.getAttribute('href')).toBe('/recruitment/candidates/cand-1?application=a-1');
    // The same form as /employees/new, without its own title and back link.
    expect(el().querySelector('app-employee-create-page')).not.toBeNull();
    expect(el().querySelector('app-employee-create-page h1')).toBeNull();
    expect([value('#new-last-name'), value('#new-first-name'), value('#new-last-name-ar'), value('#new-birth-date'), value('#new-nin')]).toEqual(['TESTEUR', 'Nadia', 'تستور', '1995-04-12', '199504120000000017']);
    expect([value('#new-hire-date'), value('#new-job-title')]).toEqual(['2026-11-02', 'Chargé(e) de clientèle']);
    expect(value('#new-unit')).toContain('Agence Annaba');
    // Without the salary block in the prefill and the permission, no salary section.
    expect(el().querySelector('[data-section="salary"]')).toBeNull();

    const boxes = () => [...el().querySelectorAll<HTMLInputElement>('[data-copy-file]')];
    expect(boxes().map((b) => [b.getAttribute('data-copy-file'), b.checked])).toEqual([['f-1', true], ['f-2', false]]);
    boxes()[1]?.click();
    await settle();

    // The form's own rules still apply: no matricule, nothing is sent.
    await submit();
    http.expectNone(HIRE);
    expect(text('#new-matricule-error')).toBe('Ce champ est obligatoire.');

    fill('new-matricule', 'emp-0100');
    await submit();
    const post = await one('POST', HIRE);
    expect(post.request.body).toEqual({
      lastName: 'TESTEUR',
      firstName: 'Nadia',
      lastNameAr: 'تستور',
      firstNameAr: 'نادية',
      birthDate: '1995-04-12',
      birthPlace: 'Annaba',
      sex: 'F',
      nationality: 'DZ',
      nin: '199504120000000017',
      matricule: 'EMP-0100',
      hireDate: '2026-11-02',
      orgUnitId: 'u-annaba',
      siteId: null,
      jobTitle: 'Chargé(e) de clientèle',
      expectedStage: 'offer',
      copyFileIds: ['f-1', 'f-2'],
    });
    const landed = nextNavigation();
    post.flush({ employee: detail({ id: 'e-100' }), application: applicationDetail({ stage: 'hired' }), opening: openingView({ hiredCount: 1 }) }, { status: 201, statusText: 'Created' });
    await landed;
    expect(router.url).toBe('/employees/e-100');
  });

  it('employee problems land on the same fields as on /employees/new; the application stays in « Offre » and the form can be sent again', async () => {
    await setup([...HIRER, 'employee.salary.update']);
    await open(hirePrefill({ salary: { baseSalary: '70000.50' } }));
    expect(value('#new-salary')).toBe('70000.50');
    fill('new-matricule', 'EMP-0001');
    await submit();
    const first = await one('POST', HIRE);
    expect(first.request.body).toMatchObject({ salary: { baseSalary: '70000.50' } });
    const taken = problem(409, 'matricule-taken');
    first.flush(...taken);
    await settle();
    expect(text('#new-matricule-error')).toBe('Ce matricule est déjà utilisé.');
    expect(el().querySelector('[data-error="hire"]')).toBeNull();

    fill('new-matricule', 'EMP-0100');
    await submit();
    const nin = problem(409, 'nin-taken');
    (await one('POST', HIRE)).flush(...nin);
    await settle();
    expect(text('#new-nin-error')).toContain('NIN');

    fill('new-nin', '199504120000000025');
    await submit();
    const scope = problem(403, 'forbidden-scope', [{ field: 'orgUnitId', code: 'forbidden_scope', message: '' }]);
    (await one('POST', HIRE)).flush(...scope);
    await settle();
    expect(text('#new-unit-error')).not.toBe('');
    // Still on the hire page, nothing navigated.
    expect(router.url).toBe('/recruitment/applications/a-1/hire');
    // A long walk through the whole form (prefill, three refusals, the body): slow machines need more than 5 s.
  }, 15_000);

  it('back follows the candidateId of the prefill, whatever the ?candidate= query says', async () => {
    await setup();
    await open(hirePrefill({ candidateId: 'cand-9' }), '/recruitment/applications/a-1/hire?candidate=cand-1');
    expect(el().querySelector('[data-action="back"]')?.getAttribute('href')).toBe('/recruitment/candidates/cand-9?application=a-1');
  });

  it('409 recruitment-stage-changed shows above the form with the way back to the candidate; no post left likewise', async () => {
    await setup();
    await open();
    fill('new-matricule', 'EMP-0100');
    await submit();
    const changed = recruitmentProblem(409, 'recruitment-stage-changed');
    (await one('POST', HIRE)).flush(changed.body, changed.options);
    await settle();
    expect(text('[data-error="hire"]')).toContain('Cette candidature a été modifiée entre-temps. Veuillez actualiser.');
    expect(el().querySelector('[data-error="hire"] a')?.getAttribute('href')).toBe('/recruitment/candidates/cand-1?application=a-1');

    await submit();
    const full = recruitmentProblem(409, 'recruitment-no-post-left');
    (await one('POST', HIRE)).flush(full.body, full.options);
    await settle();
    expect(text('[data-error="hire"]')).toContain('Tous les postes sont pourvus');

    // A chosen file deleted meanwhile: the list is fetched again, the form keeps what was typed.
    await submit();
    const file = recruitmentProblem(422, 'validation', [{ field: 'copyFileIds.0', code: 'not_found' }]);
    (await one('POST', HIRE)).flush(file.body, file.options);
    await settle();
    expect(text('[data-error="hire"]')).toContain('Une pièce choisie n’existe plus');
    (await one('GET', PREFILL)).flush(hirePrefill({ files: [], defaultCopyFileIds: [] }));
    await settle();
    expect(el().querySelector('[data-state="no-files"]')).not.toBeNull();
    expect(value('#new-matricule')).toBe('EMP-0100');
  });

  it('a known person: the identity is read-only as on the rehire page and only personId is sent', async () => {
    await setup();
    await open(
      hirePrefill({
        person: { ...hirePrefill().person, personId: 'p-9', lastName: 'ANCIEN', firstName: 'Test', lastNameAr: null, firstNameAr: null },
        knownPerson: { ...KNOWN_PERSON, linked: true },
      }),
    );
    expect(el().querySelector('app-employee-create-page')).toBeNull();
    expect(el().querySelector('app-rehire-form')).not.toBeNull();
    expect(text('[data-panel="person"]')).toContain('ANCIEN');
    expect(text('[data-panel="previous"]')).toContain('EMP-0099');
    expect(el().querySelector('#new-last-name')).toBeNull();
    // The hire date comes from the offer (it follows the end of the previous employment).
    expect(value('#rehire-hire-date')).toBe('2026-11-02');
    expect(value('#rehire-job-title')).toBe('Chargé(e) de clientèle');

    fill('rehire-matricule', 'emp-0101');
    await submit();
    const post = await one('POST', HIRE);
    expect(post.request.body).toEqual({
      personId: 'p-9',
      matricule: 'EMP-0101',
      hireDate: '2026-11-02',
      orgUnitId: 'u-annaba',
      siteId: null,
      jobTitle: 'Chargé(e) de clientèle',
      expectedStage: 'offer',
      copyFileIds: ['f-1'],
    });
    const employed = recruitmentProblem(409, 'recruitment-person-employed');
    post.flush(employed.body, employed.options);
    await settle();
    expect(text('[data-error="hire"]')).toContain('a déjà un emploi en cours');
  });

  it('a known person still employed: no form; an application that left « Offre »: the message instead of the form', async () => {
    await setup();
    await open(hirePrefill({ person: { ...hirePrefill().person, personId: 'p-9' }, knownPerson: { ...KNOWN_PERSON, linked: true, hasOpenEmployment: true } }));
    expect(el().querySelector('[data-state="person-employed"]')).not.toBeNull();
    expect(el().querySelector('app-rehire-form')).toBeNull();

    await harness.navigateByUrl('/recruitment/applications/a-2/hire');
    const changed = recruitmentProblem(409, 'recruitment-stage-changed');
    (await one('GET', '/api/recruitment/applications/a-2/hire-prefill')).flush(changed.body, changed.options);
    await settle();
    expect(text('[data-error="load"]')).toBe('Cette candidature a été modifiée entre-temps. Veuillez actualiser.');
    expect(el().querySelector('[data-action="back"]')?.getAttribute('href')).toBe('/recruitment/candidates');
    expect(el().querySelector('form')).toBeNull();
  });
});
