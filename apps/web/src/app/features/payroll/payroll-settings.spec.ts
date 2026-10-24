import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { PAYROLL_SETTINGS, RUBRIQUE_ABSENCE, RUBRIQUE_ANNUAL, RUBRIQUE_LATE, RUBRIQUE_PRIME, RUBRIQUES, SETTINGS_PREVIEW } from '../../../testing/payroll-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { CalendarSettings } from './calendar-settings';
import { FormatSettings } from './format-settings';
import { PayrollSettingsPage } from './payroll-settings.page';
import { moveColumn, normalizeColumns } from './payroll-settings-forms';
import { RubriquesSettings } from './rubriques-settings';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

function configure(permissions: readonly string[] = ['payroll.configure', 'payroll.read']): HttpTestingController {
  TestBed.configureTestingModule({
    imports: [translocoTesting()],
    providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
  });
  TestBed.inject(Session).set(meWith(permissions));
  return TestBed.inject(HttpTestingController);
}

function input(el: HTMLElement, selector: string, value: string): void {
  const field = el.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!field) throw new Error(selector);
  field.value = value;
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input'));
  field.dispatchEvent(new Event('blur'));
  TestBed.tick();
}

function click(el: HTMLElement, selector: string): void {
  const button = el.querySelector<HTMLElement>(selector);
  if (!button) throw new Error(selector);
  button.click();
  TestBed.tick();
}

const problem = (slug: string, status: number, errors?: unknown[]) => ({ type: `urn:hrforce:problem:${slug}`, title: 'Problem', status, ...(errors ? { errors } : {}) });

describe('payroll settings helpers', () => {
  it('keeps the allowed columns and adds the required ones when the layout changes', () => {
    expect(normalizeColumns('per_employee', ['matricule', 'rubrique', 'value', 'period', 'last_name'])).toEqual(['matricule', 'period', 'last_name']);
    expect(normalizeColumns('per_line', ['last_name', 'period'])).toEqual(['matricule', 'last_name', 'period', 'rubrique', 'value']);
    expect(normalizeColumns('per_line', ['matricule', 'matricule', 'rubrique', 'value'])).toEqual(['matricule', 'rubrique', 'value']);
  });

  it('moves a column up or down, never out of the list', () => {
    expect(moveColumn(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveColumn(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveColumn(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveColumn(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('PayrollSettingsPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PayrollSettingsPage>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    http = configure();
    fixture = TestBed.createComponent(PayrollSettingsPage);
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
  });

  it('opens on the rubriques, switches tabs and follows ?tab=', async () => {
    expect(el().querySelector('h1')?.textContent).toContain('Paramètres de la paie');
    expect(el().querySelector('[data-link="back"]')?.getAttribute('href')).toBe('/payroll');
    http.expectOne('/api/payroll/rubriques').flush({ items: RUBRIQUES });
    await settle();
    expect(el().querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab')).toBe('rubriques');

    click(el(), '[data-tab="calendar"]');
    http.expectOne('/api/payroll/settings').flush(PAYROLL_SETTINGS);
    await settle();
    expect(el().querySelector('[data-section="calendar"]')).not.toBeNull();

    fixture.componentRef.setInput('tab', 'format');
    await settle();
    http.expectOne('/api/payroll/settings').flush(PAYROLL_SETTINGS);
    http.expectOne('/api/payroll/settings/preview').flush(SETTINGS_PREVIEW);
    await settle();
    expect(el().querySelector('[data-section="format"]')).not.toBeNull();

    fixture.componentRef.setInput('tab', 'nonsense');
    await settle();
    http.expectOne('/api/payroll/rubriques').flush({ items: [] });
    await settle();
    expect(el().querySelector('[data-empty]')?.textContent).toContain('Aucune rubrique.');
  });
});

describe('RubriquesSettings', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<RubriquesSettings>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    installDialogPolyfill();
    http = configure();
    fixture = TestBed.createComponent(RubriquesSettings);
    await settle();
    http.expectOne('/api/payroll/rubriques').flush({ items: RUBRIQUES });
    await settle();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    fixture.destroy();
    http.verify();
  });

  it('lists every rubrique with its source, leave type, names, unit, state and order', () => {
    const rows = el().querySelectorAll('tbody tr');
    expect(rows.length).toBe(4);
    const annual = el().querySelector('[data-rubrique="CG_ANNUEL"]');
    expect(annual?.textContent).toContain('Congé');
    expect(annual?.querySelector('[data-leave-type]')?.textContent).toContain('Congé annuel');
    expect(annual?.querySelector('li[lang="ar"]')?.textContent).toContain('عطلة سنوية');
    expect(annual?.textContent).toContain('Jours');
    const late = el().querySelector('[data-rubrique="RETARD"]');
    expect(late?.textContent).toContain('Inactive');
    expect(late?.classList.contains('inactive')).toBe(true);
    expect(el().querySelector('[data-rubrique="PRIME_REND"]')?.textContent).toContain('Montant (DA)');
  });

  it('edits a computed rubrique: fixed unit, code, names, order and activation', async () => {
    click(el(), '[data-rubrique="ABS_NJ"] [data-action="edit-rubrique"]');
    const unit = el().querySelector<HTMLSelectElement>('#rub-unit');
    expect(unit?.disabled).toBe(true);
    expect(el().querySelector('#rub-unit option[value="amount"]')).toBeNull();
    expect(el().querySelector('#rub-unit-hint')?.textContent).toContain('suit son origine');
    input(el(), '#rub-code', 'ABS 1');
    expect(el().querySelector('#rub-code-error')?.textContent).toContain('1 à 20 caractères');
    click(el(), '[data-action="save-rubrique"]');
    http.expectNone((r) => r.method === 'PUT');

    input(el(), '#rub-code', '0045');
    input(el(), '#rub-order', '25');
    click(el(), '#rub-active');
    click(el(), '[data-action="save-rubrique"]');
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === `/api/payroll/rubriques/${RUBRIQUE_ABSENCE.id}`);
    expect(put.request.body).toEqual({ exportCode: '0045', names: RUBRIQUE_ABSENCE.names, active: false, sortOrder: 25 });
    put.flush({ ...RUBRIQUE_ABSENCE, exportCode: '0045' });
    await settle();
    http.expectOne('/api/payroll/rubriques').flush({ items: RUBRIQUES });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Paramètres enregistrés.');
    expect(el().querySelector('[data-form="rubrique"]')).toBeNull();
  });

  it('a manual rubrique may change its unit; a code taken by an active rubrique shows on the code', async () => {
    click(el(), '[data-rubrique="PRIME_REND"] [data-action="edit-rubrique"]');
    expect(el().querySelector<HTMLSelectElement>('#rub-unit')?.disabled).toBe(false);
    input(el(), '#rub-unit', 'days');
    input(el(), '#rub-code', 'CG_ANNUEL');
    click(el(), '[data-action="save-rubrique"]');
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === `/api/payroll/rubriques/${RUBRIQUE_PRIME.id}`);
    expect(put.request.body).toMatchObject({ exportCode: 'CG_ANNUEL', unit: 'days' });
    put.flush(problem('payroll-code-taken', 409), { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el().querySelector('#rub-code-error')?.textContent).toContain('déjà utilisé par une rubrique active');
  });

  it('creates a typed rubrique from the dialog', async () => {
    click(el(), '[data-action="new-rubrique"]');
    const dialog = el().querySelector<HTMLDialogElement>('[data-dialog="new-rubrique"]');
    expect(dialog?.open).toBe(true);
    click(el(), '[data-action="create-rubrique"]');
    expect(el().querySelector('#rub-new-code-error')?.textContent).toContain('Ce champ est obligatoire.');
    http.expectNone((r) => r.method === 'POST');

    input(el(), '#rub-new-code', 'IND_PANIER_J');
    input(el(), '#rub-new-name-fr', 'Indemnité de panier');
    input(el(), '#rub-new-name-ar', 'منحة القفة');
    input(el(), '#rub-new-name-en', 'Meal allowance');
    input(el(), '#rub-new-unit', 'days');
    click(el(), '[data-action="create-rubrique"]');
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/payroll/rubriques');
    expect(post.request.body).toEqual({ exportCode: 'IND_PANIER_J', names: { fr: 'Indemnité de panier', ar: 'منحة القفة', en: 'Meal allowance' }, unit: 'days' });
    post.flush({ ...RUBRIQUE_PRIME, id: 'rub-new', exportCode: 'IND_PANIER_J', unit: 'days' });
    await settle();
    http.expectOne('/api/payroll/rubriques').flush({ items: [...RUBRIQUES] });
    await settle();
    expect(dialog?.open).toBe(false);
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Rubrique créée.');
  });

  it('in Arabic', () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    TestBed.tick();
    expect(el().querySelector('[data-rubrique="CG_ANNUEL"] [data-leave-type]')?.textContent).toContain(RUBRIQUE_ANNUAL.leaveType?.labels.ar);
    expect(el().querySelector('[data-rubrique="RETARD"]')?.textContent).toContain('غير نشط');
    expect(RUBRIQUE_LATE.active).toBe(false);
  });
});

describe('FormatSettings', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<FormatSettings>;
  const el = () => fixture.nativeElement as HTMLElement;
  const selected = () => [...el().querySelectorAll('[data-list="selected"] li')].map((li) => li.getAttribute('data-column'));

  beforeEach(async () => {
    http = configure();
    fixture = TestBed.createComponent(FormatSettings);
    await settle();
    http.expectOne('/api/payroll/settings/preview').flush(SETTINGS_PREVIEW);
    http.expectOne('/api/payroll/settings').flush(PAYROLL_SETTINGS);
    await settle();
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
  });

  it('shows the stored format and the preview of the saved settings', () => {
    expect(el().querySelector<HTMLInputElement>('#fmt-layout-per_line')?.checked).toBe(true);
    expect(el().querySelector<HTMLSelectElement>('#fmt-encoding')?.value).toBe('windows1252');
    expect(selected()).toEqual(['matricule', 'rubrique', 'value', 'period']);
    expect(el().querySelector('[data-preview-filename]')?.textContent).toContain('variables-paie-2026-10.csv');
    expect(el().querySelector('[data-preview-sample]')?.textContent).toContain('EMP-0027;CG_ANNUEL;3;10/2026');
    expect(el().querySelector('[data-preview-sample]')?.getAttribute('dir')).toBe('ltr');
  });

  it('orders the columns with up / down, keeps required ones, adds and removes others', () => {
    // Required columns of per_line have no remove button.
    expect(el().querySelector('[data-column="matricule"] [data-action="remove"]')).toBeNull();
    expect(el().querySelector('[data-column="matricule"] [data-action="up"]')?.hasAttribute('disabled')).toBe(true);
    click(el(), '[data-column="period"] [data-action="up"]');
    expect(selected()).toEqual(['matricule', 'rubrique', 'period', 'value']);
    click(el(), '[data-add="last_name"]');
    expect(selected()).toEqual(['matricule', 'rubrique', 'period', 'value', 'last_name']);
    click(el(), '[data-column="period"] [data-action="remove"]');
    expect(selected()).toEqual(['matricule', 'rubrique', 'value', 'last_name']);
    expect(el().querySelector('[data-add="period"]')).not.toBeNull();
  });

  it('switching to one column per rubrique drops the per-line columns', () => {
    click(el(), '#fmt-layout-per_employee');
    expect(selected()).toEqual(['matricule', 'period']);
    expect(el().querySelector('[data-hint="rubrique-columns"]')).not.toBeNull();
    expect(el().querySelector('[data-add="rubrique"]')).toBeNull();
    click(el(), '#fmt-layout-per_line');
    expect(selected()).toEqual(['matricule', 'period', 'rubrique', 'value']);
  });

  it('saves the whole settings with the new format and reloads the preview', async () => {
    input(el(), '#fmt-separator', 'tab');
    input(el(), '#fmt-encoding', 'utf8_bom');
    click(el(), '#fmt-header');
    click(el(), '[data-add="origin_period"]');
    click(el(), '[data-action="save-format"]');
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/payroll/settings');
    expect(put.request.body).toEqual({
      ...PAYROLL_SETTINGS,
      separator: 'tab',
      encoding: 'utf8_bom',
      headerRow: false,
      columns: ['matricule', 'rubrique', 'value', 'period', 'origin_period'],
    });
    put.flush({ ...PAYROLL_SETTINGS, separator: 'tab' });
    await settle();
    http.expectOne('/api/payroll/settings').flush({ ...PAYROLL_SETTINGS, separator: 'tab' });
    http.expectOne('/api/payroll/settings/preview').flush({ ...SETTINGS_PREVIEW, encoding: 'utf8_bom', sample: 'matricule\trubrique\r\n' });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Paramètres enregistrés.');
    expect(el().querySelector('[data-preview-sample]')?.textContent).toContain('matricule\trubrique');
  });

  it('shows the API columns rule next to the columns', async () => {
    click(el(), '[data-action="save-format"]');
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(problem('validation', 422, [{ field: 'columns', code: 'invalid', message: 'columns invalid' }]), { status: 422, statusText: 'Unprocessable' });
    await settle();
    expect(el().querySelector('[data-error="columns"]')?.textContent).toContain('n’est pas valable');
  });

  it('a preview that fails says so and can be retried', async () => {
    click(el(), '[data-action="reload-preview"]');
    http.expectOne('/api/payroll/settings/preview').flush(problem('internal', 500), { status: 500, statusText: 'Error' });
    await settle();
    expect(el().querySelector('[data-preview-error]')).not.toBeNull();
    click(el(), '[data-action="reload-preview"]');
    http.expectOne('/api/payroll/settings/preview').flush(SETTINGS_PREVIEW);
    await settle();
    expect(el().querySelector('[data-preview-error]')).toBeNull();
  });
});

describe('CalendarSettings', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<CalendarSettings>;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    http = configure();
    fixture = TestBed.createComponent(CalendarSettings);
    await settle();
    http.expectOne('/api/payroll/settings').flush({ ...PAYROLL_SETTINGS, cutoffDay: 18 });
    await settle();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    fixture.destroy();
    http.verify();
  });

  it('shows the stored values and checks the bounds before sending', () => {
    expect(el().querySelector<HTMLInputElement>('#cal-cutoffDay')?.value).toBe('18');
    expect(el().querySelector('#cal-cutoffDay-hint')?.textContent).toContain('1 à 28');
    input(el(), '#cal-cutoffDay', '31');
    expect(el().querySelector('#cal-cutoffDay-error')?.textContent).toContain('Entrez un nombre entier entre 1 et 28.');
    input(el(), '#cal-overtimeMinMinutes', '');
    expect(el().querySelector('#cal-overtimeMinMinutes-error')?.textContent).toContain('Ce champ est obligatoire.');
    click(el(), '[data-action="save-calendar"]');
    http.expectNone((r) => r.method === 'PUT');
  });

  it('saves the calendar with the rest of the settings unchanged', async () => {
    input(el(), '#cal-regularizationMonths', '0');
    click(el(), '[data-action="save-calendar"]');
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/payroll/settings');
    expect(put.request.body).toEqual({ ...PAYROLL_SETTINGS, cutoffDay: 18, regularizationMonths: 0 });
    put.flush({ ...PAYROLL_SETTINGS, regularizationMonths: 0 });
    await settle();
    http.expectOne('/api/payroll/settings').flush({ ...PAYROLL_SETTINGS, regularizationMonths: 0 });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Paramètres enregistrés.');
  });

  it('a regional holder learns the settings are company-wide', async () => {
    click(el(), '[data-action="save-calendar"]');
    http.expectOne((r) => r.method === 'PUT').flush(problem('forbidden-scope', 403), { status: 403, statusText: 'Forbidden' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('droit sur toute l’entreprise');
  });

  it('in Arabic', () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    TestBed.tick();
    input(el(), '#cal-cutoffDay', '0');
    expect(el().querySelector('#cal-cutoffDay-error')?.textContent).toContain('يجب إدخال عدد صحيح بين 1 و28.');
  });
});
