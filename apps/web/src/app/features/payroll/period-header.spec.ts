import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { problem } from '../../../testing/employee-fixtures';
import { CLOSED_PERIOD, OPEN_PERIOD } from '../../../testing/payroll-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { PeriodClosing, PeriodView } from '../../core/payroll/payroll.models';
import { PayrollPeriodHeader } from './period-header';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const BASE = '/api/payroll/periods/2026-10';
const [FIRST_CLOSING] = CLOSED_PERIOD.closings as [PeriodClosing];

describe('PayrollPeriodHeader', () => {
  let fixture: ComponentFixture<PayrollPeriodHeader>;
  let http: HttpTestingController;
  let changed: number;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-24T09:00:00Z'), shouldAdvanceTime: true });
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mount(period: PeriodView = OPEN_PERIOD, filter: { unitId: string | null; includeSubUnits: boolean } | null = null): Promise<void> {
    fixture = TestBed.createComponent(PayrollPeriodHeader);
    fixture.componentRef.setInput('period', period);
    fixture.componentRef.setInput('filter', filter);
    changed = 0;
    fixture.componentInstance.changed.subscribe(() => changed++);
    await settle();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const click = (selector: string) => {
    const target = el().querySelector<HTMLElement>(selector);
    if (!target) throw new Error(selector);
    target.click();
  };

  it('shows an open month: cut-off, counts, flags, totals tiles and the actions it allows', async () => {
    await mount();
    expect(text('[data-field="status"]')).toBe('Ouvert');
    expect(text('[data-field="cutoff"]')).toBe('Clôture possible à partir du 20/10/2026');
    expect([...el().querySelectorAll('[data-field="counts"] li')].map((li) => li.textContent?.trim())).toEqual(['Salariés avec variables : 42', 'Lignes : 57', 'Régularisations : 1']);
    expect([...el().querySelectorAll('[data-field="flags"] li')].map((li) => li.textContent?.trim())).toEqual([
      'Congés en attente : 3',
      'Jours incomplets : 12',
      'Salariés sans pointage : 5',
    ]);
    expect(text('.tile[data-rubrique="CG_ANNUEL"]')).toBe('CG_ANNUEL Congé annuel 34,5 j Salariés : 12');
    expect(el().querySelector('[data-action="close"]')).not.toBeNull();
    expect(el().querySelector<HTMLButtonElement>('[data-action="close"]')?.disabled).toBe(false);
    expect(el().querySelector('[data-action="export-draft"]')).not.toBeNull();
    expect(el().querySelector('[data-action="export"]')).toBeNull();
    expect(el().querySelector('[data-action="reopen"]')).toBeNull();
    expect(el().querySelector('[data-field="closings"]')).toBeNull();
  });

  it('disables « Clôturer » before the cut-off date and says when it becomes possible', async () => {
    await mount({ ...OPEN_PERIOD, cutoffDate: '2026-10-28' });
    expect(el().querySelector<HTMLButtonElement>('[data-action="close"]')?.disabled).toBe(true);
    expect(text('#pv-cutoff-hint')).toBe('La clôture sera possible à partir du 28/10/2026.');
  });

  it('closes after a confirmation that repeats the summary and the warnings', async () => {
    await mount();
    click('[data-action="close"]');
    await settle();
    const dialog = el().querySelector('dialog[aria-labelledby="pv-close-title"]') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(text('#pv-close-title')).toBe('Clôturer octobre 2026');
    expect(dialog.querySelector('[data-field="close-warnings"]')?.textContent).toContain('Congés en attente : 3');

    click('[data-action="confirm-close"]');
    await settle();
    const req = http.expectOne(`${BASE}/close`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush(...problem(409, 'payroll-previous-open'));
    await settle();
    expect(text('[data-error="close"]')).toBe('Un mois précédent doit d’abord être clôturé.');
    expect(changed).toBe(0);

    click('[data-action="confirm-close"]');
    await settle();
    http.expectOne(`${BASE}/close`).flush({ ...OPEN_PERIOD, status: 'closed', version: 1 });
    await settle();
    expect(dialog.open).toBe(false);
    expect(text('[data-feedback]')).toBe('Le mois est clôturé.');
    expect(changed).toBe(1);
  });

  it('reopens the latest closed month with a required reason', async () => {
    await mount(CLOSED_PERIOD);
    expect(text('[data-field="status"]')).toBe('Clôturé v1');
    expect(text('[data-field="closed-at"]')).toContain('par Admin RH');
    click('[data-action="reopen"]');
    await settle();
    const textarea = el().querySelector<HTMLTextAreaElement>('#pv-reopen-reason') as HTMLTextAreaElement;
    textarea.value = 'abc';
    textarea.dispatchEvent(new Event('input'));
    el().querySelector('dialog[aria-labelledby="pv-reopen-title"] form')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(text('[data-error="reason"]')).toBe('Veuillez indiquer un motif de 5 à 300 caractères.');
    expect(textarea.getAttribute('aria-invalid')).toBe('true');

    textarea.value = '  Prime oubliée  ';
    textarea.dispatchEvent(new Event('input'));
    el().querySelector('dialog[aria-labelledby="pv-reopen-title"] form')?.dispatchEvent(new Event('submit'));
    await settle();
    const req = http.expectOne('/api/payroll/periods/2026-09/reopen');
    expect(req.request.body).toEqual({ reason: 'Prime oubliée' });
    req.flush(...problem(409, 'payroll-period-not-latest'));
    await settle();
    expect(text('[data-error="reopen"]')).toBe('Seul le dernier mois clôturé peut être rouvert.');

    el().querySelector('dialog[aria-labelledby="pv-reopen-title"] form')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectOne('/api/payroll/periods/2026-09/reopen').flush({ ...CLOSED_PERIOD, status: 'open' });
    await settle();
    expect(text('[data-feedback]')).toBe('Le mois est rouvert.');
    expect(changed).toBe(1);
  });

  it('lists earlier closings with their reopening reason', async () => {
    await mount({
      ...CLOSED_PERIOD,
      version: 2,
      closings: [
        { ...FIRST_CLOSING, reopenedAt: '2026-10-05T08:00:00Z', reopenedBy: { id: 'u-admin', displayName: 'Admin RH' }, reopenReason: 'Prime oubliée' },
        { ...FIRST_CLOSING, version: 2, closedAt: '2026-10-06T08:00:00Z' },
      ],
    });
    expect(text('[data-field="status"]')).toBe('Clôturé v2');
    const items = [...el().querySelectorAll('[data-field="closings"] li')];
    expect(items.map((li) => li.getAttribute('data-version'))).toEqual(['2', '1']);
    expect(items[1]?.textContent).toContain('Prime oubliée');
  });

  it('downloads the file (draft for an open month) and the control report, following the unit filter', async () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(this.download);
    });
    await mount(OPEN_PERIOD, { unitId: 'u-est', includeSubUnits: true });
    expect(el().querySelector('[data-field="files-hint"]')).not.toBeNull();

    click('[data-action="export-draft"]');
    await settle();
    const draft = http.expectOne((r) => r.url === `${BASE}/export`);
    expect(draft.request.params.get('draft')).toBe('true');
    expect(draft.request.params.get('unitId')).toBe('u-est');
    expect(draft.request.params.get('includeSubUnits')).toBe('true');
    expect(draft.request.responseType).toBe('blob');
    draft.flush(new Blob(['x'], { type: 'text/csv' }), { headers: { 'Content-Disposition': 'attachment; filename="variables-paie-2026-10-REG-EST-brouillon.csv"' } });
    await settle();
    expect(createUrl).toHaveBeenCalled();

    click('[data-action="control-ar"]');
    await settle();
    const control = http.expectOne((r) => r.url === `${BASE}/control.csv`);
    expect(control.request.params.get('lang')).toBe('ar');
    control.flush(new Blob(['x'], { type: 'text/csv' }));
    await settle();
    expect(saved).toEqual(['variables-paie-2026-10-REG-EST-brouillon.csv', 'etat-controle-paie-2026-10.csv']);

    click('[data-action="control-fr"]');
    await settle();
    const { 0: body } = problem(403, 'forbidden');
    http
      .expectOne((r) => r.url === `${BASE}/control.csv` && r.params.get('lang') === 'fr')
      .flush(new Blob([JSON.stringify(body)], { type: 'application/problem+json' }), { status: 403, statusText: 'Forbidden' });
    await settle();
    expect(text('[data-error="download"]')).toBe("Vous n'avez pas l'autorisation d'accéder à cette ressource.");
  });

  it('downloads the closed file without the draft flag', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await mount(CLOSED_PERIOD);
    click('[data-action="export"]');
    await settle();
    const req = http.expectOne((r) => r.url === '/api/payroll/periods/2026-09/export');
    expect(req.request.params.has('draft')).toBe(false);
    expect(req.request.params.has('unitId')).toBe(false);
    req.flush(new Blob(['x']));
    await settle();
    expect(el().querySelector('[data-error="download"]')).toBeNull();
  });
});
