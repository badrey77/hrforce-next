import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, inject, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { assignment, SSO_DEMO } from '../../../testing/sso-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { AccessUser } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { SsoApi } from '../../core/sso/sso-api';
import { UserAppsSection } from './user-apps-section';

const AGENT: AccessUser = { id: 'u-agent', email: 'agent.annaba@demo.dz', displayName: 'Nadia Agent', status: 'active', grants: [] };
const SELF: AccessUser = { id: 'u-amina', email: 'rh.admin@demo.dz', displayName: 'Amina Benali', status: 'active', grants: [] };

/** Like the user page: the host owns the resource and passes it down. */
@Component({
  imports: [UserAppsSection],
  template: `<app-user-apps-section [user]="user()" [assignments]="assignments" />`,
})
class Host {
  readonly user = input.required<AccessUser>();
  readonly assignments = inject(SsoApi).assignmentsResource(() => ({ userId: this.user().id }));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe('UserAppsSection (Access › user › Applications)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function render(user: AccessUser, permissions: readonly string[]) {
    TestBed.inject(Session).set(meWith(permissions));
    const fixture = TestBed.createComponent(Host);
    fixture.componentRef.setInput('user', user);
    await settle();
    http.expectOne((r) => r.url === '/api/sso/assignments' && r.params.get('userId') === user.id).flush({ items: [assignment()] });
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists app, role and date; assigns a role of a chosen app; removes after an inline confirmation', async () => {
    const el = await render(AGENT, ['sso.read', 'sso.assign']);
    expect(el.querySelector('tr[data-assignment="as-1"]')?.textContent).toContain('Démo SSO');
    expect(el.querySelector('tr[data-assignment="as-1"]')?.textContent).toContain('Opérateur');

    el.querySelector<HTMLButtonElement>('[data-action="assign-app"]')?.click();
    await settle();
    http.expectOne('/api/sso/clients').flush({ items: [SSO_DEMO] });
    await settle();
    const app = el.querySelector<HTMLSelectElement>('#user-app-client');
    if (app) {
      app.value = SSO_DEMO.id;
      app.dispatchEvent(new Event('change'));
    }
    await settle();
    const role = el.querySelector<HTMLSelectElement>('#user-app-role');
    expect([...(role?.options ?? [])].map((o) => o.value)).toEqual(['', 'ar-operator', 'ar-supervisor']);
    if (role) {
      role.value = 'ar-supervisor';
      role.dispatchEvent(new Event('change'));
    }
    el.querySelector('form[data-form="user-app"]')?.dispatchEvent(new Event('submit'));
    await settle();
    const post = http.expectOne('/api/sso/assignments');
    expect(post.request.body).toEqual({ userId: 'u-agent', roleId: 'ar-supervisor' });
    post.flush(assignment({ id: 'as-2' }), { status: 201, statusText: 'Created' });
    await settle();
    http.expectOne((r) => r.url === '/api/sso/assignments').flush({ items: [assignment()] });
    await settle();

    el.querySelector<HTMLButtonElement>('[data-action="remove-app"]')?.click();
    await settle();
    el.querySelector<HTMLButtonElement>('[data-action="confirm-remove-app"]')?.click();
    await settle();
    http.expectOne('/api/sso/assignments/as-1').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    http.expectOne((r) => r.url === '/api/sso/assignments').flush({ items: [] });
    await settle();
    expect(el.querySelector('[data-state="no-apps"]')).not.toBeNull();
  });

  it('on your own page: no Assign and no Remove (separation of duties)', async () => {
    const el = await render(SELF, ['sso.read', 'sso.assign']);
    expect(el.querySelector('[data-action="assign-app"]')).toBeNull();
    expect(el.querySelector('[data-action="remove-app"]')).toBeNull();
  });

  it('read-only with sso.read alone', async () => {
    const el = await render(AGENT, ['sso.read']);
    expect(el.querySelector('[data-action="assign-app"]')).toBeNull();
  });
});
