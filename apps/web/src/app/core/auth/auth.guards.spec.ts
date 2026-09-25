import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Mock } from 'vitest';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { authGuard, guestGuard } from './auth.guards';
import { Session } from './session';

@Component({ selector: 'app-stub', changeDetection: ChangeDetectionStrategy.OnPush, template: 'stub' })
class StubPage {}

describe('authGuard / guestGuard', () => {
  let loadChildren: Mock<() => Promise<Routes>>;

  beforeEach(() => {
    loadChildren = vi.fn<() => Promise<Routes>>(() => Promise.resolve<Routes>([{ path: '', component: StubPage }]));
    const routes: Routes = [
      { path: 'login', canMatch: [guestGuard], component: StubPage },
      { path: '', pathMatch: 'full', canMatch: [authGuard], component: StubPage },
      { path: 'organization', canMatch: [authGuard], loadChildren },
      { path: '**', component: StubPage },
    ];
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('sends a signed-out visitor to /login with the full URL as returnUrl', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/organization?asOf=2025-01-31');

    const router = TestBed.inject(Router);
    expect(router.url).toBe('/login?returnUrl=%2Forganization%3FasOf%3D2025-01-31');
  });

  it('canMatch stops the navigation BEFORE the lazy feature chunk is requested', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/organization');

    expect(loadChildren).not.toHaveBeenCalled();
  });

  it('protects the home page too', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/');

    expect(TestBed.inject(Router).url).toBe('/login?returnUrl=%2F');
  });

  it('lets a signed-in user through', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/organization');

    expect(TestBed.inject(Router).url).toBe('/organization');
    expect(loadChildren).toHaveBeenCalledTimes(1);
  });

  it('guestGuard sends a signed-in user from /login to home', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login?returnUrl=%2Forganization');

    expect(TestBed.inject(Router).url).toBe('/');
  });

  it('guestGuard lets a signed-out visitor see /login', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/login');

    expect(TestBed.inject(Router).url).toBe('/login');
  });
});
