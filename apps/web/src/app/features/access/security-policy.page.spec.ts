import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { flushAccessCatalog } from '../../../testing/access-fixtures';
import { ADMIN_PERMISSIONS, ME_FIXTURE, meWith } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { SecurityPolicy } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { ACCESS_ROUTES } from './access.routes';

@Component({ selector: 'app-not-found-stub', changeDetection: ChangeDetectionStrategy.OnPush, template: 'not found' })
class NotFoundStub {}

const POLICY: SecurityPolicy = { mfaEnforced: false, mfaRequiredPermissions: ['access.grant', 'employee.salary.read'] };

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('Access › Security policy', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'access', children: ACCESS_ROUTES }, { path: '**', component: NotFoundStub }], withComponentInputBinding()),
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
  const checkbox = (code: string) => el().querySelector(`#policy-perm-${code.replace(/\./g, '\\.')}`) as HTMLInputElement;

  async function open(): Promise<void> {
    await harness.navigateByUrl('/access/security');
    await settle();
    http.expectOne({ method: 'GET', url: '/api/access/security-policy' }).flush(POLICY);
    await settle();
    flushAccessCatalog(http); // the checklist (and so the catalogue) appears with the loaded policy
    await settle();
  }

  it('shows the enforce switch and the permission checklist (the role editor control) filled from the API', async () => {
    await open();

    expect(el().querySelector('[data-tab="security"]')?.getAttribute('aria-current')).toBe('page');
    expect((el().querySelector('#policy-enforced') as HTMLInputElement).checked).toBe(false);
    expect(checkbox('access.grant').checked).toBe(true);
    expect(checkbox('employee.salary.read').checked).toBe(true);
    expect(checkbox('employee.read').checked).toBe(false);
  });

  it('saves the policy with PUT, confirms and reloads the session', async () => {
    await open();
    (el().querySelector('#policy-enforced') as HTMLInputElement).click();
    checkbox('access.manage_roles').click();
    await settle();
    (el().querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();

    const req = http.expectOne({ method: 'PUT', url: '/api/access/security-policy' });
    expect(req.request.body).toEqual({
      mfaEnforced: true,
      mfaRequiredPermissions: ['access.grant', 'access.manage_roles', 'employee.salary.read'],
    });
    req.flush(req.request.body as SecurityPolicy);
    await settle();
    http.expectOne('/api/me').flush(ME_FIXTURE);
    await settle();

    expect(el().querySelector('.feedback')?.textContent?.trim()).toBe('Politique de sécurité enregistrée.');
    expect((el().querySelector('#policy-enforced') as HTMLInputElement).checked).toBe(true);
  });

  it('shows a save error at form level', async () => {
    await open();
    (el().querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    http
      .expectOne('/api/access/security-policy')
      .flush({ type: 'urn:hrforce:problem:forbidden', title: 'x', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await settle();

    expect(el().querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      "Vous n'avez pas l'autorisation d'accéder à cette ressource.",
    );
  });

  it('without access.manage_roles: no tab, and the route does not match (404)', async () => {
    TestBed.inject(Session).set(meWith(ADMIN_PERMISSIONS.filter((code) => code !== 'access.manage_roles')));
    await harness.navigateByUrl('/access/roles');
    await settle();
    flushAccessCatalog(http);
    await settle();
    expect(el().querySelector('app-access-nav a[href="/access/roles"]')).not.toBeNull();
    expect(el().querySelector('[data-tab="security"]')).toBeNull();

    await harness.navigateByUrl('/access/security');
    await settle();
    http.expectNone('/api/access/security-policy');
    expect(el().textContent).toBe('not found');
  });
});
