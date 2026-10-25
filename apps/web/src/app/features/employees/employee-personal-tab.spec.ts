import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ADMIN_PERMISSIONS, meWith } from '../../../testing/auth-fixtures';
import { detail, problem, redactedDetail } from '../../../testing/employee-fixtures';
import { personalView, profileRequest } from '../../../testing/profile-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { todayIso } from '../../core/date/iso-date';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { ageOn } from '../../core/profile/profile.models';
import { EMPLOYEES_ROUTES } from './employees.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const URL = '/api/employees/e-1';
const REQUESTS = '/api/profile/requests';
const PERMISSIONS = [...ADMIN_PERMISSIONS, 'employee.personal.read', 'employee.personal.update'];

function withPersonal(extra: Partial<EmployeeDetail> = {}): EmployeeDetail {
  return detail({ personal: personalView(), _actions: ['update', 'update_personal'], ...extra });
}

describe('EmployeeDetailPage › Coordonnées et famille', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'employees', children: EMPLOYEES_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(PERMISSIONS));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const click = (selector: string) => {
    const target = el().querySelector<HTMLElement>(selector);
    if (!target) throw new Error(selector);
    target.click();
  };

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`) as HTMLInputElement | HTMLSelectElement;
    if (!input) throw new Error(id);
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
    input.dispatchEvent(new Event('blur'));
  }

  async function submit(selector: string): Promise<void> {
    el().querySelector(selector)?.dispatchEvent(new Event('submit'));
    await settle();
  }

  async function open(body: EmployeeDetail = withPersonal(), requests = [profileRequest({ employee: { ...profileRequest().employee, id: 'e-1' } })]): Promise<void> {
    await harness.navigateByUrl('/employees/e-1?tab=personal');
    await settle();
    http.expectOne(URL).flush(body);
    await settle();
    if (body.personal) {
      const list = http.expectOne((r) => r.url === REQUESTS);
      expect(list.request.params.get('employmentId')).toBe('e-1');
      expect(list.request.params.has('status')).toBe(false);
      list.flush({ items: requests, total: requests.length, page: 1, pageSize: 100 });
      await settle();
    }
  }

  it('is a tab only when the detail carries the personal block', async () => {
    await harness.navigateByUrl('/employees/e-1');
    await settle();
    http.expectOne(URL).flush(redactedDetail({ _redacted: ['salary', 'bank', 'nss', 'personal'] }));
    await settle();
    expect(el().querySelector('[data-tab="personal"]')).toBeNull();
  });

  it('shows contact, emergency contact, family and children with their age, without edit buttons for read-only HR', async () => {
    await open(withPersonal({ _actions: [] }));
    expect(text('[data-tab="personal"]')).toBe('Coordonnées et famille');
    expect(text('[data-field="mobilePhone"]')).toBe('+213 555 12 34 56');
    expect(text('[data-field="wilaya"]')).toBe('23 — Annaba');
    expect(text('[data-field="relationship"]')).toBe('Conjoint(e)');
    expect(text('[data-field="maritalStatus"]')).toBe('Marié(e)');
    const age = ageOn('2020-03-14', todayIso());
    expect(text('[data-child="ch-1"] [data-field="age"]')).toContain(`${age} an(s)`);
    expect(text('[data-child="ch-1"] [data-field="dependent"]')).toBe('À charge');
    expect(el().querySelector('[data-action="edit-contact"]')).toBeNull();
    expect(el().querySelector('[data-action="edit-family"]')).toBeNull();
  });

  it('edits the contact details: client checks, then PUT with blanks as null', async () => {
    await open();
    click('[data-action="edit-contact"]');
    await settle();
    expect(el().querySelector<HTMLSelectElement>('#contact-wilaya')?.value).toBe('23');
    fill('contact-mobile', '12-34');
    fill('contact-postal', '230');
    await submit('[data-form="contact"]');
    expect(text('#contact-mobile-error')).toBe('Numéro invalide : 8 à 20 chiffres, « + » et espaces acceptés.');
    expect(text('#contact-postal-error')).toBe('Le code postal compte 5 chiffres.');
    http.expectNone((r) => r.url === `${URL}/contact`);

    fill('contact-mobile', '+213 555 00 11 22');
    fill('contact-postal', '23000');
    fill('contact-email', '');
    await submit('[data-form="contact"]');
    const put = http.expectOne(`${URL}/contact`);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({
      mobilePhone: '+213 555 00 11 22',
      otherPhone: null,
      personalEmail: null,
      addressLine: '12 rue des Jasmins',
      commune: 'Annaba',
      wilayaCode: '23',
      postalCode: '23000',
    });
    put.flush(personalView());
    await settle();
    http.expectOne(URL).flush(withPersonal());
    await settle();
    expect(text('[data-feedback]')).toBe('Coordonnées enregistrées.');
    expect(el().querySelector('[data-form="contact"]')).toBeNull();
  });

  it('shows a 422 of the contact on its field and an ended employment above the form', async () => {
    await open();
    click('[data-action="edit-contact"]');
    await settle();
    await submit('[data-form="contact"]');
    http.expectOne(`${URL}/contact`).flush(...problem(422, 'validation-error', [{ field: 'personalEmail', code: 'invalid_email', message: 'Invalid e-mail' }]));
    await settle();
    expect(text('#contact-email-error')).toBe('Adresse e-mail invalide.');
    // the server's error stays on the field until it is changed
    fill('contact-email', 'samir@example.dz');
    await submit('[data-form="contact"]');
    http.expectOne(`${URL}/contact`).flush(...problem(409, 'employment-ended'));
    await settle();
    expect(text('[data-form="contact"] .form-error')).toContain('emploi');
  });

  it('wants the emergency contact complete, and removing it sends null', async () => {
    await open();
    click('[data-action="edit-emergency"]');
    await settle();
    fill('emergency-phone', '');
    await submit('[data-form="emergency"]');
    expect(el().querySelector('[data-error="emergency-incomplete"]')).not.toBeNull();
    http.expectNone((r) => r.url === `${URL}/emergency-contact`);

    click('[data-action="clear-emergency"]');
    await settle();
    const put = http.expectOne(`${URL}/emergency-contact`);
    expect(put.request.body).toBe('null');
    put.flush(personalView({ emergencyContact: null }));
    await settle();
    http.expectOne(URL).flush(withPersonal({ personal: personalView({ emergencyContact: null }) }));
    await settle();
    expect(text('[data-feedback]')).toBe('Personne à prévenir supprimée.');
    expect(el().querySelector('[data-state="no-emergency"]')).not.toBeNull();
  });

  it('edits the family with children added, changed and removed in one PUT; server paths reach the child rows', async () => {
    await open();
    click('[data-action="edit-family"]');
    await settle();
    expect(el().querySelectorAll('[data-child]').length).toBe(1);
    click('[data-action="add-child"]');
    await settle();
    expect(el().querySelectorAll('fieldset[data-child]').length).toBe(2);
    await submit('[data-form="family"]');
    // the new row is empty: required fields
    expect(text('#child-1-name-error')).toBeTruthy();
    fill('child-1-name', 'Lina');
    fill('child-1-birth', '2099-01-01');
    await submit('[data-form="family"]');
    expect(text('#child-1-birth-error')).toBe('La date ne peut pas être dans le futur.');
    fill('child-1-birth', '2025-09-01');
    fill('child-0-name', 'Yanis Amine');
    fill('family-status', 'divorced');
    await submit('[data-form="family"]');
    const put = http.expectOne(`${URL}/family`);
    expect(put.request.body).toEqual({
      maritalStatus: 'divorced',
      maritalStatusSince: '2018-06-30',
      spouseEmployed: 'no',
      children: [
        { id: 'ch-1', firstName: 'Yanis Amine', birthDate: '2020-03-14', sex: 'M', dependent: true },
        { firstName: 'Lina', birthDate: '2025-09-01', sex: null, dependent: true },
      ],
    });
    put.flush(...problem(422, 'validation-error', [{ field: 'children.1.birthDate', code: 'future_date', message: 'In the future' }]));
    await settle();
    expect(text('#child-1-birth-error')).toBe('La date ne peut pas être dans le futur.');

    click('[data-child="1"] [data-action="remove-child"]');
    await settle();
    expect(el().querySelectorAll('fieldset[data-child]').length).toBe(1);
    await submit('[data-form="family"]');
    const second = http.expectOne(`${URL}/family`);
    expect((second.request.body as { children: unknown[] }).children).toHaveLength(1);
    second.flush(personalView());
    await settle();
    http.expectOne(URL).flush(withPersonal());
    await settle();
    expect(text('[data-feedback]')).toBe('Situation familiale enregistrée.');
  });

  it('caps the children at 15', async () => {
    const children = Array.from({ length: 15 }, (_, i) => ({ id: `ch-${i}`, firstName: `E${i}`, birthDate: '2015-01-01', sex: null, dependent: true }));
    await open(withPersonal({ personal: personalView({ family: { ...personalView().family, children } }) }));
    click('[data-action="edit-family"]');
    await settle();
    expect(el().querySelector<HTMLButtonElement>('[data-action="add-child"]')?.disabled).toBe(true);
  });

  it('lists the employee’s change requests with the before → after on demand', async () => {
    await open();
    const row = text('[data-request="pr-1"]');
    expect(row).toContain('Situation familiale');
    expect(row).toContain('Enfants à charge');
    expect(row).toContain('En attente');
    click('[data-request="pr-1"] [data-action="toggle-request"]');
    await settle();
    expect(el().querySelector('[data-child-diff="added"]')?.textContent).toContain('Lina');
    expect(el().querySelector('[data-file="pf-1"] a')?.getAttribute('href')).toBe('/api/profile/requests/pr-1/files/pf-1');
  });

  it('says when there is no request', async () => {
    await open(withPersonal(), []);
    expect(el().querySelector('[data-state="no-requests"]')).not.toBeNull();
  });
});
