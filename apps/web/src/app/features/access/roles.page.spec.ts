import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { flushAccessCatalog, ROLE_ADMIN, ROLE_CUSTOM, ROLES } from '../../../testing/access-fixtures';
import { ME_FIXTURE, meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { ACCESS_ROUTES } from './access.routes';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

function conflict(slug: string) {
  return [
    { type: `urn:hrforce:problem:${slug}`, title: 'Conflict', status: 409 },
    { status: 409, statusText: 'Conflict' },
  ] as const;
}

describe('Access › Roles', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
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

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();

  async function open(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    flushAccessCatalog(http);
    await settle();
  }

  function checkbox(code: string): HTMLInputElement {
    return el().querySelector(`#role-perm-${code.replace(/\./g, '\\.')}`) as HTMLInputElement;
  }

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  async function submit(): Promise<void> {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
  }

  describe('list', () => {
    it('shows roles with name, code, system/custom and the number of (sensitive) permissions', async () => {
      await open('/access/roles');

      const cells = (code: string) =>
        [...el().querySelectorAll(`tr[data-role="${code}"] td`)].map((td) => td.textContent?.replace(/\s+/g, ' ').trim());
      expect(cells('admin_rh_central')).toEqual(['Administrateur RH central', 'admin_rh_central', 'Rôle système', '14 3 sensible(s)']);
      expect(cells('GEST-PAIE')).toEqual(['Gestionnaire paie', 'GEST-PAIE', 'Personnalisé', '2 1 sensible(s)']);
      expect(el().querySelector('[data-action="new-role"]')?.getAttribute('href')).toBe('/access/roles/new');
    });

    it('without access.manage_roles: no "New role", the else template explains why', async () => {
      TestBed.inject(Session).set(meWith(['access.read']));
      await open('/access/roles');

      expect(el().querySelector('[data-action="new-role"]')).toBeNull();
      expect(text('[data-note="read-only"]')).toBe('Vous pouvez consulter les rôles, mais pas les modifier.');
    });
  });

  describe('editor', () => {
    it('a system role is read-only: disabled fields and checklist, no save button', async () => {
      await open(`/access/roles/${ROLE_ADMIN.id}`);

      expect(text('h2')).toBe('Administrateur RH central Rôle système');
      expect(text('[data-note="system"]')).toBe('Rôle système : ses permissions ne peuvent pas être modifiées.');
      expect((el().querySelector('#role-name-fr') as HTMLInputElement).disabled).toBe(true);
      expect(checkbox('access.grant').checked).toBe(true);
      expect(checkbox('access.grant').disabled).toBe(true);
      expect(checkbox('employee.medical.read').checked).toBe(false);
      expect(el().querySelector('button[type="submit"]')).toBeNull();
    });

    it('groups the checklist by catalogue group and flags sensitive permissions', async () => {
      await open(`/access/roles/${ROLE_CUSTOM.id}`);

      expect([...el().querySelectorAll('fieldset legend')].map((l) => l.textContent?.trim())).toEqual([
        'Organisation',
        'Accès',
        'Employés',
        'Données sensibles',
      ]);
      const sensitive = el().querySelector('fieldset[data-group="sensitive"]');
      expect(sensitive?.querySelectorAll('.badge.sensitive')).toHaveLength(4);
      expect(el().querySelector('fieldset[data-group="access"] .badge.sensitive')).toBeNull();
    });

    it('edits a custom role: code locked, PATCH names + permissions; role-escalation lands on the checklist', async () => {
      await open(`/access/roles/${ROLE_CUSTOM.id}`);
      expect((el().querySelector('#role-code') as HTMLInputElement).disabled).toBe(true);

      checkbox('employee.bank.read').click();
      fill('role-name-fr', 'Gestionnaire paie et RIB');
      await submit();

      let req = http.expectOne(`/api/access/roles/${ROLE_CUSTOM.id}`);
      expect(req.request.method).toBe('PATCH');
      expect(req.request.body).toEqual({
        names: { fr: 'Gestionnaire paie et RIB', ar: 'مسير الأجور', en: 'Payroll officer' },
        permissions: ['employee.read', 'employee.salary.read', 'employee.bank.read'],
      });
      req.flush(...conflict('role-escalation'));
      await settle();
      expect(text('#role-permissions-error')).toBe('Vous ne pouvez pas ajouter à un rôle des permissions que vous ne détenez pas.');
      expect(el().querySelector('fieldset')?.getAttribute('aria-invalid')).toBe('true');

      checkbox('employee.bank.read').click(); // off…
      checkbox('employee.bank.read').click(); // …and on again: the value changed, the server error is cleared
      await submit();
      http.expectOne(`/api/access/roles/${ROLE_CUSTOM.id}`).flush(...conflict('role-system-immutable'));
      await settle();
      expect(text('form > [role="alert"]')).toBe('Les rôles système ne peuvent pas être modifiés.');

      await submit();
      req = http.expectOne(`/api/access/roles/${ROLE_CUSTOM.id}`);
      req.flush({ ...ROLE_CUSTOM, names: { ...ROLE_CUSTOM.names, fr: 'Gestionnaire paie et RIB' } });
      await settle();
      expect(text('[role="status"]')).toBe('Rôle enregistré.');
      http.expectOne('/api/access/roles').flush({ items: ROLES }); // the catalogue reloads
    });

    it('creates a role: client checks, POST, role-code-taken on the code, then opens the new role', async () => {
      await open('/access/roles/new');
      expect(text('h2')).toBe('Nouveau rôle');

      await submit();
      expect(text('#role-code-error')).toBe('Ce champ est obligatoire.');
      expect(text('#role-permissions-error')).toBe('Ce champ est obligatoire.');
      http.expectNone('/api/access/roles');

      fill('role-code', 'bad code!');
      await settle();
      expect(text('#role-code-error')).toBe('Format de code invalide.');

      fill('role-code', 'AUDIT');
      fill('role-name-fr', 'Auditeur');
      fill('role-name-ar', 'مدقق');
      fill('role-name-en', 'Auditor');
      checkbox('org_unit.read').click();
      checkbox('access.read').click();
      await submit();

      let req = http.expectOne('/api/access/roles');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({
        code: 'AUDIT',
        names: { fr: 'Auditeur', ar: 'مدقق', en: 'Auditor' },
        permissions: ['org_unit.read', 'access.read'],
      });
      req.flush(...conflict('role-code-taken'));
      await settle();
      expect(text('#role-code-error')).toBe('Ce code de rôle est déjà utilisé.');

      fill('role-code', 'AUDIT-2');
      await submit();
      req = http.expectOne('/api/access/roles');
      const created = { id: 'role-audit', code: 'AUDIT-2', names: { fr: 'Auditeur', ar: 'مدقق', en: 'Auditor' }, isSystem: false, permissions: ['org_unit.read', 'access.read'] };
      req.flush(created, { status: 201, statusText: 'Created' });
      await settle();
      http.expectOne((r) => r.url === '/api/access/roles' && r.method === 'GET').flush({ items: [...ROLES, created] });
      await settle();

      expect(TestBed.inject(Router).url).toBe('/access/roles/role-audit?created=AUDIT-2');
      expect(text('[role="status"]')).toBe('Rôle « AUDIT-2 » créé.');
      expect(text('h2')).toBe('Auditeur');
    });

    it('roles/new without access.manage_roles does not match: falls through to roles/:id → "not found"', async () => {
      TestBed.inject(Session).set(meWith(['access.read']));
      await open('/access/roles/new');

      expect(text('[role="alert"]')).toBe('Rôle introuvable.');
    });
  });
});
