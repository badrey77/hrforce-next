import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Mock } from 'vitest';
import { ME_LECTURE, meWith } from '../../../testing/auth-fixtures';
import { authGuard } from './auth.guards';
import { permissionGuard } from './permission.guard';
import { Session } from './session';

@Component({ selector: 'app-stub', changeDetection: ChangeDetectionStrategy.OnPush, template: 'stub' })
class StubPage {}

@Component({ selector: 'app-missing', changeDetection: ChangeDetectionStrategy.OnPush, template: 'not found' })
class MissingPage {}

async function go(url: string): Promise<RouterTestingHarness> {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return harness;
}

describe('permissionGuard', () => {
  let loadChildren: Mock<() => Promise<Routes>>;

  beforeEach(() => {
    loadChildren = vi.fn<() => Promise<Routes>>(() => Promise.resolve<Routes>([{ path: '', component: StubPage }]));
    const routes: Routes = [
      { path: 'login', component: StubPage },
      // Code from route data…
      { path: 'access', canMatch: [authGuard, permissionGuard()], data: { permission: 'access.read' }, loadChildren },
      // …or from the factory's argument (closure).
      { path: 'roles/new', canMatch: [permissionGuard('access.manage_roles')], component: StubPage },
      // Any of several codes (a feature whose children need different permissions); an empty list fails closed.
      { path: 'leave', canMatch: [permissionGuard()], data: { permission: ['leave.read', 'leave.configure'] }, component: StubPage },
      { path: 'nothing', canMatch: [permissionGuard([])], component: StubPage },
      // No code anywhere: fails closed.
      { path: 'broken', canMatch: [permissionGuard()], component: StubPage },
      { path: '**', component: MissingPage },
    ];
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('lets a user holding the permission (from route data) through and loads the feature', async () => {
    TestBed.inject(Session).set(meWith(['access.read']));
    await go('/access');

    expect(TestBed.inject(Router).url).toBe('/access');
    expect(loadChildren).toHaveBeenCalledTimes(1);
  });

  it('without the permission the route does not match: 404 page, and the chunk is never requested', async () => {
    TestBed.inject(Session).set(ME_LECTURE);
    const harness = await go('/access');

    expect(TestBed.inject(Router).url).toBe('/access'); // `**` keeps the URL
    expect(harness.routeNativeElement?.textContent).toBe('not found');
    expect(loadChildren).not.toHaveBeenCalled();
  });

  it('signed out: authGuard (first in the array) wins with its /login redirect', async () => {
    await go('/access');

    expect(TestBed.inject(Router).url).toBe('/login?returnUrl=%2Faccess');
    expect(loadChildren).not.toHaveBeenCalled();
  });

  it('reads the code from the factory argument', async () => {
    TestBed.inject(Session).set(meWith(['access.read']));
    const harness = await go('/roles/new');
    expect(harness.routeNativeElement?.textContent).toBe('not found');

    TestBed.inject(Session).set(meWith(['access.read', 'access.manage_roles']));
    await harness.navigateByUrl('/login');
    await harness.navigateByUrl('/roles/new');
    expect(harness.routeNativeElement?.textContent).toBe('stub');
  });

  it('an array means "any of": one code is enough, none → 404, an empty list denies', async () => {
    TestBed.inject(Session).set(meWith(['leave.configure']));
    const harness = await go('/leave');
    expect(harness.routeNativeElement?.textContent).toBe('stub');

    TestBed.inject(Session).set(meWith(['employee.read']));
    await harness.navigateByUrl('/login');
    await harness.navigateByUrl('/leave');
    expect(harness.routeNativeElement?.textContent).toBe('not found');

    TestBed.inject(Session).set(meWith(['leave.read', 'leave.configure']));
    await harness.navigateByUrl('/nothing');
    expect(harness.routeNativeElement?.textContent).toBe('not found');
  });

  it('denies when no permission code is configured', async () => {
    TestBed.inject(Session).set(meWith(['access.read', 'org_unit.read']));
    const harness = await go('/broken');

    expect(harness.routeNativeElement?.textContent).toBe('not found');
  });
});
