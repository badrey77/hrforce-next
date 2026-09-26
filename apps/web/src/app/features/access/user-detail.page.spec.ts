import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { flushAccessCatalog, grant, GRANT_SAMIR, ROLE_CUSTOM, USER_SAMIR } from '../../../testing/access-fixtures';
import { GRANT_ROW, GRANTED } from '../../../testing/audit-fixtures';
import { ADMIN_PERMISSIONS, ME_FIXTURE, meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { installIntersectionObserver, untilDeferredRequest } from '../../../testing/intersection-observer';
import { flushKinds } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { GrantView } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { OrgUnitSummary } from '../../core/org/org.models';
import { ORG_UNIT_PICKER_DEBOUNCE_MS } from '../../shared/org-unit-picker/org-unit-picker';
import { ACCESS_ROUTES } from './access.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const ENDED = grant({ id: 'g-old', userId: 'u-samir', validFrom: '2025-01-01', validTo: '2025-12-31', _actions: [] });
const READ_ONLY = grant({ id: 'g-ro', userId: 'u-samir', _actions: [] });
const AG_ORAN: OrgUnitSummary = {
  id: 'a-oran',
  kind: 'agency',
  code: 'AG-ORAN',
  name: 'Agence Oran',
  site: null,
  path: [{ id: 'r-ouest', name: 'Région Ouest' }],
};

function conflict(slug: string, errors?: { field: string; code: string; message: string }[]) {
  return [
    { type: `urn:hrforce:problem:${slug}`, title: 'Conflict', status: 409, ...(errors ? { errors } : {}) },
    { status: 409, statusText: 'Conflict' },
  ] as const;
}

let harness: RouterTestingHarness;
let http: HttpTestingController;

const el = () => harness.routeNativeElement as HTMLElement;
const isGrants = (r: { url: string }) => r.url === '/api/access/grants';
const SAMIR_URL = '/api/access/users/u-samir';
const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();

async function open(grants: readonly GrantView[] = [GRANT_SAMIR]): Promise<void> {
  await harness.navigateByUrl('/access/users/u-samir');
  await settle();
  http.expectOne(SAMIR_URL).flush(USER_SAMIR);
  const req = http.expectOne(isGrants);
  expect(req.request.params.get('userId')).toBe('u-samir');
  expect(req.request.params.has('includeEnded')).toBe(false);
  req.flush({ items: grants });
  flushAccessCatalog(http);
  flushKinds(http);
  await settle();
}

function rowCells(id: string): string[] {
  return [...el().querySelectorAll(`tr[data-grant="${id}"] td`)].map((td) => td.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

function fill(id: string, value: string, event = 'input'): void {
  const input = el().querySelector(`#${id}`) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event(event));
}

async function submit(form: Element | null | undefined): Promise<void> {
  form?.dispatchEvent(new Event('submit'));
  await settle();
}

const dialog = () => el().querySelector('dialog') as HTMLDialogElement;

async function openDialog(): Promise<void> {
  await open();
  (el().querySelector('tr[data-grant="g-samir"] [data-action="end"]') as HTMLButtonElement).click();
  await settle();
}

async function openForm(): Promise<HTMLFormElement> {
  await open();
  (el().querySelector('[data-action="add-grant"]') as HTMLButtonElement).click();
  await settle();
  return el().querySelector('app-grant-form form') as HTMLFormElement;
}

async function pickUnit(): Promise<void> {
  fill('grant-unit', 'Oran');
  // Generous margin: with `shouldAdvanceTime` the faked Date.now() (read by debounceTime) moves in 20 ms steps and can
  // lag real time by up to one step, so the debounce may fire a little after DEBOUNCE_MS of real time.
  await new Promise((resolve) => setTimeout(resolve, ORG_UNIT_PICKER_DEBOUNCE_MS + 100));
  http.expectOne((r) => r.url === '/api/org/units').flush({ items: [AG_ORAN] });
  await settle();
  (el().querySelector('app-org-unit-picker [role="option"]') as HTMLElement).click();
  await settle();
}

function chooseRole(name: string): void {
  const select = el().querySelector('#grant-role') as HTMLSelectElement;
  select.selectedIndex = [...select.options].findIndex((o) => o.textContent?.trim() === name);
  select.dispatchEvent(new Event('change'));
}

describe('Access › User detail', () => {
  beforeEach(async () => {
    // Fake only Date ("today"), and let it advance with real time: RxJS debounceTime compares scheduler.now().
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 26, 10)); // "today" = 2026-09-26
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'access', children: ACCESS_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(ME_FIXTURE);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  describe('history tab (audit.read)', () => {
    it('hidden without audit.read: the grants show without tabs', async () => {
      TestBed.inject(Session).set(meWith(ADMIN_PERMISSIONS.filter((code) => code !== 'audit.read')));
      await open();
      expect(el().querySelector('[role="tablist"]')).toBeNull();
      expect(el().querySelector('tr[data-grant="g-samir"]')).not.toBeNull();
    });

    it('with audit.read: History loads the member\'s timeline (deferred), naming roles and units the page knows', async () => {
      installIntersectionObserver();
      await open();
      expect(el().querySelector('[data-tab="details"]')?.getAttribute('aria-selected')).toBe('true');

      (el().querySelector('[data-tab="history"]') as HTMLButtonElement).click();
      await settle();
      // `@defer (on viewport)`: the placeholder is "seen", the chunk loads, the timeline sends its request
      const req = await untilDeferredRequest(http, (r) => r.url === '/api/audit/timeline', settle);
      expect(req.request.params.get('subject')).toBe('user:u-samir');
      req.flush({ items: [GRANTED, GRANT_ROW], nextCursor: null });
      await settle();

      expect(text('[data-entry="e:7"] [data-kind="event"]')).toBe('Rôle « Lecture » attribué sur Région Ouest à partir du 1 oct. 2026');
      expect(text('[data-entry="c:40"] [data-field="role_id"] .after')).toBe('Lecture');
      // The grants table is only hidden (projected content), still in the DOM.
      expect(el().querySelector('tr[data-grant="g-samir"]')).not.toBeNull();
    });
  });

  describe('grants table', () => {
    it('shows the member and their grants: role, unit (kind, name, code), sub-units, dates, granted by, End', async () => {
      await open();

      expect(text('h2')).toBe('Samir Belkacem');
      expect(text('.facts')).toContain('lecture.ouest@demo.dz');
      expect(rowCells('g-samir')).toEqual(['Lecture', 'Région Région Ouest (REG-OUEST)', 'Oui', '2026-01-01', 'Sans fin', 'Amina Benali', 'Terminer']);
    });

    it('"End" follows the server\'s _actions', async () => {
      await open([GRANT_SAMIR, READ_ONLY]);

      expect(el().querySelector('tr[data-grant="g-samir"] [data-action="end"]')).not.toBeNull();
      expect(el().querySelector('tr[data-grant="g-ro"] [data-action="end"]')).toBeNull();
    });

    it('"Show ended grants" re-fetches with includeEnded=true; ended rows are muted and flagged', async () => {
      await open();
      const toggle = el().querySelector('#grants-ended') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await settle();

      const req = http.expectOne(isGrants);
      expect(req.request.params.get('includeEnded')).toBe('true');
      req.flush({ items: [GRANT_SAMIR, ENDED] });
      await settle();

      expect(el().querySelector('tr[data-grant="g-old"]')?.classList).toContain('ended');
      expect(rowCells('g-old')[0]).toBe('Lecture Terminée');
      expect(rowCells('g-old')[4]).toBe('2025-12-31');
    });

    it('an unknown (or invisible) member: GET /access/users/:id answers 404 → "not found", no retry', async () => {
      await harness.navigateByUrl('/access/users/u-ghost');
      await settle();
      http
        .expectOne('/api/access/users/u-ghost')
        .flush({ type: 'about:blank', title: 'Not Found', status: 404 }, { status: 404, statusText: 'Not Found' });
      http.expectOne(isGrants).flush({ items: [] });
      flushAccessCatalog(http);
      flushKinds(http);
      await settle();

      expect(text('[role="alert"]')).toBe('Utilisateur introuvable.');
      expect(el().querySelector('[role="alert"] button')).toBeNull();
      expect(el().querySelector('table')).toBeNull();
    });

    it('another error offers a retry that fetches the member again', async () => {
      await harness.navigateByUrl('/access/users/u-samir');
      await settle();
      http.expectOne(SAMIR_URL).flush({ type: 'about:blank', title: 'Boom', status: 500 }, { status: 500, statusText: 'Error' });
      http.expectOne(isGrants).flush({ items: [] });
      flushAccessCatalog(http);
      flushKinds(http);
      await settle();

      expect(text('[role="alert"] p')).toBe('Impossible de charger les utilisateurs.');
      (el().querySelector('[role="alert"] button') as HTMLButtonElement).click();
      await settle();
      http.expectOne(SAMIR_URL).flush(USER_SAMIR);
      await settle();
      expect(text('h2')).toBe('Samir Belkacem');
    });
  });

  describe('end-grant dialog (native <dialog>, viewChild)', () => {
    it('opens modal with today as default and the grant named; Cancel closes it', async () => {
      await openDialog();

      expect(dialog().open).toBe(true);
      expect(dialog().textContent).toContain('Rôle « Lecture » sur « Région Ouest ».');
      expect((el().querySelector('#end-valid-to') as HTMLInputElement).value).toBe('2026-09-26');

      [...dialog().querySelectorAll('button')].find((b) => b.textContent?.includes('Annuler'))?.click();
      await settle();
      expect(dialog().open).toBe(false);
      expect(dialog().querySelector('form')).toBeNull(); // (close) cleared the grant
    });

    it('validates the date against the grant (≥ start) before sending', async () => {
      await openDialog();
      fill('end-valid-to', '2025-12-31');
      await submit(dialog().querySelector('form'));

      expect(text('#end-valid-to-error')).toBe('La date de fin ne peut pas précéder le début de l’attribution.');
      http.expectNone((r) => r.url.endsWith('/end'));
    });

    it('rejects a date after the current end of a bounded grant', async () => {
      const bounded = grant({ id: 'g-b', userId: 'u-samir', validTo: '2026-12-31' });
      await open([bounded]);
      (el().querySelector('tr[data-grant="g-b"] [data-action="end"]') as HTMLButtonElement).click();
      await settle();
      fill('end-valid-to', '2027-01-15');
      await submit(dialog().querySelector('form'));

      expect(text('#end-valid-to-error')).toBe('La date de fin ne peut pas dépasser la fin actuelle de l’attribution.');
    });

    it('maps 409 grant-dates to the field and grant-self to the dialog; success closes, reloads, confirms', async () => {
      await openDialog();
      fill('end-valid-to', '2026-10-01');
      await submit(dialog().querySelector('form'));

      let req = http.expectOne('/api/access/grants/g-samir/end');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ validTo: '2026-10-01' });
      req.flush(...conflict('grant-dates'));
      await settle();
      expect(text('#end-valid-to-error')).toBe('Cette date de fin n’est pas acceptée pour cette attribution.');
      expect(dialog().open).toBe(true);

      // A field error from the server blocks re-submitting until the field is edited (validators re-run).
      await submit(dialog().querySelector('form'));
      http.expectNone('/api/access/grants/g-samir/end');
      fill('end-valid-to', '2026-10-01');
      await submit(dialog().querySelector('form'));
      http.expectOne('/api/access/grants/g-samir/end').flush(...conflict('grant-self'));
      await settle();
      expect(text('dialog [role="alert"]')).toBe('Vous ne pouvez pas terminer vos propres attributions.');

      await submit(dialog().querySelector('form'));
      req = http.expectOne('/api/access/grants/g-samir/end');
      req.flush({ ...GRANT_SAMIR, validTo: '2026-10-01', _actions: [] });
      await settle();

      expect(dialog().open).toBe(false);
      expect(text('[role="status"]')).toBe('Attribution du rôle « Lecture » terminée.');
      http.expectOne(isGrants).flush({ items: [{ ...GRANT_SAMIR, validTo: '2026-10-01', _actions: [] }] });
      http.expectOne(SAMIR_URL).flush(USER_SAMIR);
    });
  });

  describe('add-grant form', () => {
    it('"Attribuer un rôle" needs access.grant (structural directive)', async () => {
      TestBed.inject(Session).set(meWith(['access.read', 'org_unit.read']));
      await open();
      expect(el().querySelector('[data-action="add-grant"]')).toBeNull();

      TestBed.inject(Session).set(ME_FIXTURE);
      await settle();
      expect(el().querySelector('[data-action="add-grant"]')).not.toBeNull();
    });

    it('defaults: sub-units checked, from = today, to empty; required fields are checked client-side', async () => {
      const form = await openForm();

      expect((el().querySelector('#grant-descendants') as HTMLInputElement).checked).toBe(true);
      expect((el().querySelector('#grant-from') as HTMLInputElement).value).toBe('2026-09-26');
      expect((el().querySelector('#grant-to') as HTMLInputElement).value).toBe('');
      expect([...(el().querySelector('#grant-role') as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual([
        'Choisir un rôle',
        'Administrateur RH central',
        'Lecture',
        'Gestionnaire paie',
      ]);

      await submit(form);
      expect(text('#grant-role-error')).toBe('Ce champ est obligatoire.');
      expect(text('#grant-unit-error')).toBe('Ce champ est obligatoire.');
      http.expectNone('/api/access/grants');
    });

    it('cross-field validator: "to" must be after "from" (like the API: [from, to) must not be empty)', async () => {
      const form = await openForm();
      fill('grant-from', '2026-10-01');
      fill('grant-to', '2026-09-01');
      await submit(form);

      expect(text('#grant-to-error')).toBe('La date de fin doit être postérieure à la date de début.');
      expect(el().querySelector('#grant-to')?.getAttribute('aria-invalid')).toBe('true');

      fill('grant-to', '2026-10-01'); // equal is refused too (the API answers grant-dates)
      await settle();
      expect(text('#grant-to-error')).toBe('La date de fin doit être postérieure à la date de début.');

      fill('grant-to', '2026-10-02');
      await settle();
      expect(el().querySelector('#grant-to-error')).toBeNull();
    });

    it('sends the grant; maps each 409 slug to its field or to the form', async () => {
      const form = await openForm();
      chooseRole('Gestionnaire paie');
      await pickUnit();
      (el().querySelector('#grant-descendants') as HTMLInputElement).click();
      fill('grant-to', '2026-12-31');
      await submit(form);

      let req = http.expectOne('/api/access/grants');
      expect(req.request.body).toEqual({
        userId: 'u-samir',
        roleId: ROLE_CUSTOM.id,
        orgUnitId: 'a-oran',
        includeDescendants: false,
        validFrom: '2026-09-26',
        validTo: '2026-12-31',
      });

      req.flush(...conflict('grant-escalation', [{ field: 'roleId', code: 'escalation', message: 'x' }]));
      await settle();
      expect(text('#grant-role-error')).toBe('Vous ne détenez pas toutes les permissions de ce rôle sur cette unité.');
      expect(form.querySelector('[role="alert"]')).toBeNull();

      chooseRole('Gestionnaire paie'); // editing the field clears its server error
      await submit(form);
      http.expectOne('/api/access/grants').flush(...conflict('grant-dates', [{ field: 'validTo', code: 'x', message: 'x' }]));
      await settle();
      expect(text('#grant-to-error')).toBe('Dates invalides pour cette attribution.');

      fill('grant-to', '2026-12-31');
      await submit(form);
      http.expectOne('/api/access/grants').flush(...conflict('grant-self'));
      await settle();
      expect(text('app-grant-form [role="alert"]')).toBe('Vous ne pouvez pas vous attribuer un rôle à vous-même.');

      await submit(form);
      http
        .expectOne('/api/access/grants')
        .flush(...conflict('grant-user-not-member', [{ field: 'userId', code: 'x', message: 'x' }]));
      await settle();
      expect(text('app-grant-form [role="alert"]')).toBe('Cet utilisateur n’est pas membre de la société.');

      await submit(form);
      http.expectOne('/api/access/grants').flush(...conflict('grant-out-of-scope'));
      await settle();
      expect(text('#grant-unit-error')).toBe('Cette unité est en dehors du périmètre où vous pouvez attribuer des rôles.');
      expect(el().querySelector('#grant-unit')?.getAttribute('aria-invalid')).toBe('true');

      await pickUnit();
      await submit(form);
      http.expectOne('/api/access/grants').flush(...conflict('grant-duplicate', [{ field: 'roleId', code: 'x', message: 'x' }]));
      await settle();
      expect(text('#grant-role-error')).toBe('Cet utilisateur a déjà ce rôle sur cette unité pour une période qui se chevauche.');

      chooseRole('Gestionnaire paie');
      await submit(form);
      req = http.expectOne('/api/access/grants');
      const created = grant({ id: 'g-new', userId: 'u-samir', role: { id: ROLE_CUSTOM.id, code: ROLE_CUSTOM.code, names: ROLE_CUSTOM.names } });
      req.flush(created, { status: 201, statusText: 'Created' });
      await settle();

      expect(el().querySelector('app-grant-form')).toBeNull();
      expect(text('[role="status"]')).toBe('Rôle « Gestionnaire paie » attribué.');
      http.expectOne(isGrants).flush({ items: [GRANT_SAMIR, created] });
      http.expectOne(SAMIR_URL).flush(USER_SAMIR);
    });
  });
});
