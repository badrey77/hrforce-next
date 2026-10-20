import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ADMIN_PERMISSIONS, meWith } from '../../../testing/auth-fixtures';
import { contract, contractList } from '../../../testing/contract-fixtures';
import { detail, problem } from '../../../testing/employee-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { newContractDefaults } from './employee-contracts-tab';
import { addMonths, probationLimit } from './contract-forms';
import { EMPLOYEES_ROUTES } from './employees.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const URL = '/api/employees/e-1';
const CONTRACTS = '/api/employees/e-1/contracts';
const MANAGER = ['manage_contract', 'update', 'assign', 'end'] as const;

function withContract(extra: Partial<EmployeeDetail> = {}): EmployeeDetail {
  return detail({ contract: { type: 'cdd', endDate: '2026-02-28', probationEnd: null }, _actions: [...MANAGER], ...extra });
}

describe('contract helpers', () => {
  it('adds calendar months and bounds probation at 12 months', () => {
    expect(addMonths('2025-02-01', 12)).toBe('2026-02-01');
    expect(addMonths('2024-02-29', 12)).toBe('2025-03-01');
    // the API's rule: before start + 12 months, never after the contract's end
    expect(probationLimit('2025-03-01')).toBe('2026-02-28');
    expect(probationLimit('2025-03-01', '2025-08-31')).toBe('2025-08-31');
    expect(probationLimit('2025-03-01', '2027-01-01')).toBe('2026-02-28');
  });

  it('defaults a new contract from the latest one', () => {
    const latest = contract();
    expect(newContractDefaults('renewal', latest, '2026-01-10')).toEqual({ contractType: 'cdd', startDate: '2026-03-01' });
    expect(newContractDefaults('conversion', latest, '2026-01-10')).toEqual({ contractType: 'cdi', startDate: '2026-03-01' });
    expect(newContractDefaults('amendment', latest, '2026-01-10')).toEqual({ contractType: 'cdd', startDate: '2026-01-10' });
    // A renewal after a CDI suggests a CDD, starting today (a CDI has no end).
    expect(newContractDefaults('renewal', contract({ contractType: 'cdi', endDate: null }), '2026-01-10')).toEqual({ contractType: 'cdd', startDate: '2026-01-10' });
    expect(newContractDefaults('conversion', contract({ contractType: 'cdi', endDate: null }), '2026-01-10')).toEqual({ contractType: '', startDate: '2026-01-10' });
    expect(newContractDefaults('initial', undefined, '2026-01-10', '2024-03-01')).toEqual({ contractType: '', startDate: '2024-03-01' });
    expect(newContractDefaults('amendment', undefined, '2026-01-10')).toEqual({ contractType: '', startDate: '2026-01-10' });
  });
});

describe('EmployeeDetailPage › contracts', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function setup(permissions: readonly string[] = ADMIN_PERMISSIONS): Promise<void> {
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
  }

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const click = (selector: string) => (el().querySelector(selector) as HTMLElement).click();

  async function open(body: EmployeeDetail = withContract()): Promise<void> {
    await harness.navigateByUrl('/employees/e-1');
    await settle();
    http.expectOne(URL).flush(body);
    await settle();
  }

  async function openTab(list = contractList()): Promise<void> {
    click('[data-tab="contracts"]');
    await settle();
    http.expectOne(CONTRACTS).flush(list);
    await settle();
  }

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    input.dispatchEvent(new Event('blur'));
  }

  async function submit(selector: string): Promise<void> {
    el().querySelector(selector)?.dispatchEvent(new Event('submit'));
    await settle();
  }

  it('shows the current contract in the header, or a warning when none is recorded', async () => {
    await setup();
    await open(withContract({ contract: { type: 'cdd', endDate: '2099-02-28', probationEnd: '2099-01-31' } }));
    expect(text('[data-field="contract"]')).toBe('CDD jusqu’au 2099-02-28 période d’essai jusqu’au 2099-01-31');
  });

  it('warns when an open employment has no contract; a CDI has no end in the header', async () => {
    await setup();
    await open(withContract({ contract: null }));
    expect(el().querySelector('[data-state="no-contract"]')).not.toBeNull();
    expect(text('[data-field="contract"]')).toBe('Contrat non renseigné : aucun contrat ne couvre la date du jour.');
  });

  it('lists the contracts newest first with the current one marked; no write button without manage_contract', async () => {
    await setup();
    await open(withContract({ _actions: [] }));
    await openTab();
    const rows = [...el().querySelectorAll('[data-table="contracts"] tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-contract'))).toEqual(['k-2', 'k-1']);
    expect(text('[data-contract="k-2"]')).toContain('CDD');
    expect(text('[data-contract="k-2"]')).toContain('En cours');
    expect(text('[data-contract="k-2"]')).toContain('Renouvellement');
    expect(text('[data-contract="k-1"]')).toContain('2024-05-31');
    expect(el().querySelector('[data-action="new-contract"]')).toBeNull();
    expect(el().querySelector('[data-action="correct-contract"]')).toBeNull();
    expect(el().querySelector('[data-action="open-decision"]')).toBeNull();
  });

  it('shows the empty state', async () => {
    await setup();
    await open();
    await openTab(contractList([]));
    expect(el().querySelector('[data-state="no-contract"]')).not.toBeNull();
  });

  it('adds a renewal: defaults from the latest contract, client rules, the body, then both lists are read again', async () => {
    await setup();
    await open();
    await openTab();
    click('[data-action="new-contract"]');
    await settle();
    expect((el().querySelector('#contract-type') as HTMLSelectElement).value).toBe('cdd');
    expect((el().querySelector('#contract-start') as HTMLInputElement).value).toBe('2026-03-01');

    fill('contract-probation', '2028-01-01');
    await submit('[data-form="new-contract"]');
    http.expectNone((r) => r.method === 'POST');
    expect(text('#contract-end-error')).toBe('Ce champ est obligatoire.');
    expect(text('#contract-probation-error')).toBe('La période d’essai doit se terminer entre le 2026-03-01 et le 2027-02-28.');

    fill('contract-end', '2027-02-28');
    fill('contract-probation', '');
    fill('contract-reference', ' CT-2026-03 ');
    await submit('[data-form="new-contract"]');
    const post = http.expectOne((r) => r.method === 'POST' && r.url === CONTRACTS);
    expect(post.request.body).toEqual({ kind: 'renewal', contractType: 'cdd', startDate: '2026-03-01', endDate: '2027-02-28', reference: 'CT-2026-03' });
    post.flush(contract({ id: 'k-3', seq: 3 }), { status: 201, statusText: 'Created' });
    await settle();
    http.expectOne(CONTRACTS).flush(contractList());
    http.expectOne(URL).flush(withContract());
    await settle();
    expect(text('.feedback')).toBe('Contrat enregistré.');
  });

  it('a conversion to CDI asks for no end date; 409 contract-overlap lands on the start date', async () => {
    await setup();
    await open();
    await openTab();
    click('[data-action="new-contract"]');
    await settle();
    fill('contract-kind', 'conversion');
    await settle();
    expect((el().querySelector('#contract-type') as HTMLSelectElement).value).toBe('cdi');
    expect(el().querySelector('#contract-end')).toBeNull();
    await submit('[data-form="new-contract"]');
    const post = http.expectOne((r) => r.method === 'POST' && r.url === CONTRACTS);
    expect(post.request.body).toEqual({ kind: 'conversion', contractType: 'cdi', startDate: '2026-03-01' });
    post.flush(...problem(409, 'contract-overlap'));
    await settle();
    expect(text('#contract-start-error')).toBe('Ce contrat chevauche un autre contrat de cet emploi.');
  });

  it('corrects the latest contract: only what changed is sent; contract-not-latest above the form', async () => {
    await setup();
    await open();
    await openTab();
    click('[data-action="correct-contract"]');
    await settle();
    expect((el().querySelector('#correct-end') as HTMLInputElement).value).toBe('2026-02-28');
    await submit('[data-form="correct-contract"]');
    http.expectNone((r) => r.method === 'PATCH');
    expect(text('[data-form="correct-contract"] [role="alert"]')).toBe('Aucune modification à enregistrer.');

    fill('correct-end', '2026-03-31');
    fill('correct-note', 'Prolongé par avenant');
    await submit('[data-form="correct-contract"]');
    const patch = http.expectOne((r) => r.method === 'PATCH' && r.url === `${CONTRACTS}/k-2`);
    expect(patch.request.body).toEqual({ endDate: '2026-03-31', note: 'Prolongé par avenant' });
    patch.flush(...problem(409, 'contract-not-latest'));
    await settle();
    expect(text('[data-form="correct-contract"] [role="alert"]')).toBe('Seul le dernier contrat peut être corrigé.');
  });

  it('opens a contract decision on a fixed-term latest contract; a pending one shows a badge and no button', async () => {
    await setup([...ADMIN_PERMISSIONS, 'deadline.read']);
    await open();
    await openTab();
    click('[data-action="open-decision"]');
    await settle();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === `${CONTRACTS}/k-2/decision`);
    post.flush({ id: 'd-1' }, { status: 201, statusText: 'Created' });
    await settle();
    expect(text('.feedback')).toBe('Décision ouverte : le responsable de l’unité est sollicité, puis les RH.');
    http.expectOne(CONTRACTS).flush(contractList([contract({ pendingDecision: { id: 'd-1', status: 'pending' } })]));
    http.expectOne(URL).flush(withContract());
    await settle();
    expect(el().querySelector('[data-action="open-decision"]')).toBeNull();
    expect(text('[data-badge="decision"]')).toBe('Décision en cours');
    expect(el().querySelector('[data-link="decision"]')?.getAttribute('href')).toBe('/deadlines?kind=contract_end&q=EMP-0001');
  });

  it('shows 409 contract-decision-pending above the table', async () => {
    await setup();
    await open();
    await openTab();
    click('[data-action="open-decision"]');
    await settle();
    http.expectOne((r) => r.method === 'POST' && r.url === `${CONTRACTS}/k-2/decision`).flush(...problem(409, 'contract-decision-pending'));
    await settle();
    expect(text('[data-error="decision"]')).toBe('Une décision est déjà en cours pour ce contrat.');
    http.expectOne(CONTRACTS).flush(contractList());
    await settle();
  });

  it('offers no decision on a CDI', async () => {
    await setup();
    await open(withContract({ contract: { type: 'cdi', endDate: null, probationEnd: null } }));
    await openTab(contractList([contract({ contractType: 'cdi', endDate: null })]));
    expect(el().querySelector('[data-action="open-decision"]')).toBeNull();
    expect(text('[data-contract="k-2"]')).toContain('Sans fin');
  });

  it('names the probation in the header only while it runs; a future hire without a contract today is not warned', async () => {
    await setup();
    await open(withContract({ contract: { type: 'cdi', endDate: null, probationEnd: '2020-05-31' } }));
    expect(text('[data-field="contract"]')).toBe('CDI');
    await harness.navigateByUrl('/employees/e-2');
    await settle();
    http.expectOne('/api/employees/e-2').flush(withContract({ id: 'e-2', status: 'future', contract: null }));
    await settle();
    expect(el().querySelector('[data-state="no-contract"]')).toBeNull();
  });

  it('records the initial contract of an employment without any (starts on the hire date)', async () => {
    await setup();
    await open(withContract({ contract: null }));
    await openTab(contractList([]));
    click('[data-action="new-contract"]');
    await settle();
    const kinds = [...el().querySelectorAll('#contract-kind option')].map((o) => (o as HTMLOptionElement).value);
    expect(kinds).toEqual(['initial']);
    const start = el().querySelector('#contract-start') as HTMLInputElement;
    expect(start.value).toBe('2024-03-01');
    expect(start.readOnly).toBe(true);
    fill('contract-type', 'cdi');
    await submit('[data-form="new-contract"]');
    const post = http.expectOne((r) => r.method === 'POST' && r.url === CONTRACTS);
    expect(post.request.body).toEqual({ kind: 'initial', contractType: 'cdi', startDate: '2024-03-01' });
    post.flush(contract({ id: 'k-1', seq: 1, kind: 'initial' }), { status: 201, statusText: 'Created' });
    await settle();
    http.expectOne(CONTRACTS).flush(contractList());
    http.expectOne(URL).flush(withContract());
    await settle();
  });

  it('offers no renewal after a CDI; the rule codes of a 422 are translated', async () => {
    await setup();
    await open(withContract({ contract: { type: 'cdi', endDate: null, probationEnd: null } }));
    await openTab(contractList([contract({ contractType: 'cdi', endDate: null })]));
    click('[data-action="new-contract"]');
    await settle();
    const kinds = [...el().querySelectorAll('#contract-kind option')].map((o) => (o as HTMLOptionElement).value);
    expect(kinds).toEqual(['conversion', 'amendment']);
    fill('contract-kind', 'amendment');
    await settle();
    fill('contract-type', 'cdi');
    await submit('[data-form="new-contract"]');
    http
      .expectOne((r) => r.method === 'POST' && r.url === CONTRACTS)
      .flush(...problem(422, 'validation-error', [{ field: 'startDate', code: 'must_follow_previous', message: 'The new contract starts after the start of the previous one.' }]));
    await settle();
    expect(text('#contract-start-error')).toContain('La date de début ne suit pas le contrat précédent');
  });

  it('an approved decision shows no « en cours » badge', async () => {
    await setup([...ADMIN_PERMISSIONS, 'deadline.read']);
    await open();
    await openTab(contractList([contract({ pendingDecision: { id: 'd-1', status: 'approved' } })]));
    expect(el().querySelector('[data-badge="decision"]')).toBeNull();
    expect(el().querySelector('[data-link="decision"]')).toBeNull();
  });
});
