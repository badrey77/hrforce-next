import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ME_FIXTURE, meWith } from '../../../testing/auth-fixtures';
import { detail, problem, redactedDetail } from '../../../testing/employee-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { enterViewport, installIntersectionObserver } from '../../../testing/intersection-observer';
import { ORG_KIND_LIST, SITES } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import type { OrgUnitSummary } from '../../core/org/org.models';
import { ORG_UNIT_PICKER_DEBOUNCE_MS } from '../../shared/org-unit-picker/org-unit-picker';
import { EMPLOYEES_ROUTES } from './employees.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const URL = '/api/employees/e-1';
const AG_ORAN: OrgUnitSummary = { id: 'a-oran', kind: 'agency', code: 'AG-ORAN', name: 'Agence Oran', site: null, path: [] };

describe('EmployeeDetailPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'employees', children: EMPLOYEES_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(ME_FIXTURE);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const tabs = () => [...el().querySelectorAll('[role="tab"]')].map((b) => b.getAttribute('data-tab'));
  const click = (selector: string) => (el().querySelector(selector) as HTMLElement).click();

  async function open(body: EmployeeDetail = detail()): Promise<void> {
    await harness.navigateByUrl('/employees/e-1');
    await settle();
    http.expectOne(URL).flush(body);
    await settle();
  }

  async function tab(name: string): Promise<void> {
    click(`[data-tab="${name}"]`);
    await settle();
  }

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    input.dispatchEvent(new Event('blur'));
  }

  async function submit(selector = 'form'): Promise<void> {
    el().querySelector(selector)?.dispatchEvent(new Event('submit'));
    await settle();
  }

  /** A write succeeded: the page re-reads the detail. */
  async function expectReload(body: EmployeeDetail = detail()): Promise<void> {
    await settle();
    http.expectOne(URL).flush(body);
    await settle();
  }

  it('shows the header and every tab and button for a full-access user', async () => {
    await open();
    expect(text('h1')).toBe('BENALI Amina');
    expect(text('[data-field="matricule"]')).toBe('EMP-0001');
    expect(text('[data-field="status"]')).toBe('En poste');
    expect(tabs()).toEqual(['identity', 'assignments', 'pay', 'bank', 'history']);
    expect(el().querySelector('[data-action="end"]')).not.toBeNull();
    expect(el().querySelector('[data-action="edit-person"]')).not.toBeNull();

    TestBed.inject(LanguageService).use('ar', { remember: false });
    await settle();
    expect(text('h1')).toBe('بن علي أمينة');
    expect(text('[data-field="unit"]')).toBe('وكالة عنابة');
  });

  it('hides Pay and Bank & NSS when redacted, History without audit.read, and buttons without _actions', async () => {
    TestBed.inject(Session).set(meWith(['employee.read']));
    await open(redactedDetail());
    expect(tabs()).toEqual(['identity', 'assignments']);
    expect(el().querySelector('[data-action]')).toBeNull();
    await tab('assignments');
    expect(el().querySelector('[data-action="assign"]')).toBeNull();
  });

  it('shows the Bank & NSS tab when only one block is readable, with only that block', async () => {
    const { bank: _b, ...rest } = detail();
    await open({ ...rest, _redacted: ['bank'], _actions: ['update_nss'] });
    expect(tabs()).toContain('bank');
    await tab('bank');
    expect(el().querySelector('[data-panel="bank"]')).toBeNull();
    expect(el().querySelector('[data-panel="nss"]')).not.toBeNull();
    expect(el().querySelector('[data-action="edit-nss"]')).not.toBeNull();
  });

  it('edits the identity: sends only what changed, then reloads', async () => {
    await open();
    click('[data-action="edit-person"]');
    await settle();
    fill('person-first-name', 'Amina Z.');
    fill('person-nin', '1');
    await submit();
    http.expectNone(`${URL}/person`);
    expect(text('#person-nin-error')).toBe('18 chiffres attendus.');

    fill('person-nin', '109901234567890123');
    await submit();
    const patch = http.expectOne(`${URL}/person`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ firstName: 'Amina Z.' });
    patch.flush(detail());
    await expectReload();
    expect(text('.feedback')).toBe('Identité mise à jour.');
  });

  it('lists assignments with unit path and adds one with the picker; 409 assignment-date lands on the date', async () => {
    await open();
    await tab('assignments');
    const rows = [...el().querySelectorAll('[data-table="assignments"] tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Direction Générale');
    expect(rows[0]?.textContent).toContain("(site de l'unité)");
    expect(rows[0]?.querySelector('td')?.classList).toContain('nowrap');

    click('[data-action="assign"]');
    await settle();
    http.match('/api/org/kinds').forEach((r) => r.flush(ORG_KIND_LIST));
    http.match((r) => r.url === '/api/org/sites').forEach((r) => r.flush({ items: SITES }));
    const unit = el().querySelector('#assign-unit') as HTMLInputElement;
    unit.value = 'oran';
    unit.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, ORG_UNIT_PICKER_DEBOUNCE_MS + 20));
    http.expectOne((r) => r.url === '/api/org/units').flush({ items: [AG_ORAN] });
    await settle();
    click('[role="option"]');
    await settle();
    fill('assign-job-title', 'Responsable');
    fill('assign-valid-from', '2025-01-01');
    await submit();
    http.expectNone(`${URL}/assignments`);
    expect(text('#assign-valid-from-error')).toBe('La date doit être au plus tôt le 2025-01-02.');

    fill('assign-valid-from', '2026-01-01');
    await submit();
    const post = http.expectOne(`${URL}/assignments`);
    expect(post.request.body).toEqual({ orgUnitId: 'a-oran', siteId: null, jobTitle: 'Responsable', validFrom: '2026-01-01' });
    post.flush(...problem(409, 'assignment-date'));
    await settle();
    expect(text('#assign-valid-from-error')).toContain("La date d'effet doit suivre le début de l'affectation en cours");

    fill('assign-valid-from', '2026-02-01');
    await submit();
    http.expectOne(`${URL}/assignments`).flush(detail());
    await expectReload();
    expect(text('.feedback')).toBe('Nouvelle affectation enregistrée.');
  });

  it('Pay tab: current salary and history formatted, "New salary" sends a 2-decimal string', async () => {
    await open();
    await tab('pay');
    expect(text('[data-field="currentSalary"]')).toMatch(/85\s000,00 DZD/);
    const amounts = [...el().querySelectorAll('[data-table="salary"] td.amount')].map((td) => td.textContent?.trim());
    expect(amounts[1]).toMatch(/72\s000,50 DZD/);

    click('[data-action="new-salary"]');
    await settle();
    fill('salary-amount', '90000');
    fill('salary-valid-from', '2026-01-01');
    await submit();
    const put = http.expectOne(`${URL}/salary`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ baseSalary: '90000.00', validFrom: '2026-01-01' });
    put.flush(detail());
    await expectReload();
  });

  it('Bank & NSS forms: PUT bank and nss; 403 forbidden-field lands on the field', async () => {
    await open();
    await tab('bank');
    expect(text('[data-panel="bank"] dd')).toBe('00400123456789012345');
    click('[data-action="edit-bank"]');
    await settle();
    fill('bank-rib', '0040 0123 4567 8901 2399');
    await submit('[data-panel="bank"] form');
    const bank = http.expectOne(`${URL}/bank`);
    expect(bank.request.body).toEqual({ rib: '00400123456789012399', bankName: 'BNA' });
    bank.flush(...problem(403, 'forbidden-field', [{ field: 'rib', code: 'forbidden', message: '' }]));
    await settle();
    expect(text('#bank-rib-error')).toBe("Vous n'avez pas le droit de renseigner ce champ.");
    click('[data-panel="bank"] .btn.secondary');
    await settle();

    click('[data-action="edit-nss"]');
    await settle();
    fill('nss-number', '1234567890');
    await submit('[data-panel="nss"] form');
    const nss = http.expectOne(`${URL}/nss`);
    expect(nss.request.body).toEqual({ nss: '1234567890' });
    nss.flush(detail());
    await expectReload();
  });

  it('ends the employment through the dialog (reason + date), then reloads; 409 end-date on the date', async () => {
    await open();
    click('[data-action="end"]');
    await settle();
    const dialog = el().querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    await submit('dialog form');
    http.expectNone(`${URL}/end`);
    expect(text('#end-reason-error')).toBe('Ce champ est obligatoire.');

    fill('end-reason', 'resignation');
    fill('end-date', '2026-03-31');
    await submit('dialog form');
    const post = http.expectOne(`${URL}/end`);
    expect(post.request.body).toEqual({ endDate: '2026-03-31', reason: 'resignation' });
    post.flush(...problem(409, 'end-date'));
    await settle();
    expect(text('#end-date-error')).toContain('La date de sortie doit être postérieure');

    fill('end-date', '2026-04-30');
    await submit('dialog form');
    http.expectOne(`${URL}/end`).flush(detail());
    await expectReload(detail({ status: 'ended', endDate: '2026-04-30', endReason: 'resignation', _actions: [] }));
    expect(dialog.open).toBe(false);
    expect(text('[data-field="status"]')).toBe('Sorti');
    expect(text('[data-field="endReason"]')).toBe('Démission');
    expect(el().querySelector('[data-action="end"]')).toBeNull();
  });

  it('History tab shows the employee timeline (subject employee:<id>)', async () => {
    installIntersectionObserver();
    await open();
    await tab('history');
    enterViewport();
    for (let i = 0; i < 60 && !el().querySelector('app-timeline'); i++) await settle();
    await settle();
    const req = http.expectOne((r) => r.url === '/api/audit/timeline');
    expect(req.request.params.get('subject')).toBe('employee:e-1');
    req.flush({ items: [], nextCursor: null });
    await settle();
  });

  it('a 404 reads "not found" without a retry button', async () => {
    await harness.navigateByUrl('/employees/e-1');
    await settle();
    http.expectOne(URL).flush(...problem(404, null));
    await settle();
    expect(text('[role="alert"]')).toBe('Employé introuvable.');
    expect(el().querySelector('[role="alert"] button')).toBeNull();
  });
});
