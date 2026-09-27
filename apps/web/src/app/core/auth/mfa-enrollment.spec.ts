import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Mock } from 'vitest';
import { ME_FIXTURE, ME_MFA_ON, ME_MFA_REQUIRED } from '../../../testing/auth-fixtures';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { authRefreshInterceptor } from './auth-refresh.interceptor';
import { authGuard } from './auth.guards';
import { enrollmentUrlTree, isEnrollmentRequired, mfaEnrollmentGuard, mfaEnrollmentInterceptor } from './mfa-enrollment';
import { Session } from './session';

@Component({ selector: 'app-stub', changeDetection: ChangeDetectionStrategy.OnPush, template: 'stub' })
class StubPage {}

const ENROLL_403 = [
  { type: 'urn:hrforce:problem:mfa-enrollment-required', title: 'Forbidden', status: 403 },
  { status: 403, statusText: 'Forbidden' },
] as const;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve));
}

describe('two-step sign-in enforcement', () => {
  let loadChildren: Mock<() => Promise<Routes>>;
  let http: HttpTestingController;

  beforeEach(() => {
    loadChildren = vi.fn<() => Promise<Routes>>(() => Promise.resolve<Routes>([{ path: '', component: StubPage }]));
    const signedIn = [authGuard, mfaEnrollmentGuard];
    const routes: Routes = [
      { path: 'login', component: StubPage },
      { path: '', pathMatch: 'full', canMatch: signedIn, component: StubPage },
      { path: 'employees', canMatch: signedIn, loadChildren },
      { path: 'me/security', canMatch: [authGuard], component: StubPage },
      { path: '**', component: StubPage },
    ];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        provideHttpClient(withInterceptors([mfaEnrollmentInterceptor, apiProblemInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  describe('mfaEnrollmentGuard', () => {
    it('sends a user who must enroll to the wizard with the full URL as returnUrl, before the lazy chunk loads', async () => {
      TestBed.inject(Session).set(ME_MFA_REQUIRED);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/employees?q=ali');

      expect(TestBed.inject(Router).url).toBe('/me/security?enroll=1&returnUrl=%2Femployees%3Fq%3Dali');
      expect(loadChildren).not.toHaveBeenCalled();
    });

    it('lets the security page itself through (no redirect loop)', async () => {
      TestBed.inject(Session).set(ME_MFA_REQUIRED);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/me/security');

      expect(TestBed.inject(Router).url).toBe('/me/security');
    });

    it.each([
      ['enrolled', ME_MFA_ON],
      ['a /me without mfa (older API)', ME_FIXTURE],
    ])('lets a user through when %s', async (_label, me) => {
      TestBed.inject(Session).set(me);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/employees');

      expect(TestBed.inject(Router).url).toBe('/employees');
    });

    it('a signed-out visitor still gets /login first (authGuard runs before it)', async () => {
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/employees');

      expect(TestBed.inject(Router).url).toBe('/login?returnUrl=%2Femployees');
    });

    it('enrollmentUrlTree drops unsafe or self-referencing return URLs', () => {
      const router = TestBed.inject(Router);
      expect(router.serializeUrl(enrollmentUrlTree(router, '//evil.example'))).toBe('/me/security?enroll=1');
      expect(router.serializeUrl(enrollmentUrlTree(router, '/me/security?enroll=1'))).toBe('/me/security?enroll=1');
      expect(router.serializeUrl(enrollmentUrlTree(router, '/'))).toBe('/me/security?enroll=1&returnUrl=%2F');
    });
  });

  describe('mfaEnrollmentInterceptor (403 mfa-enrollment-required)', () => {
    it('re-throws, reloads the session and navigates ONCE to the wizard with the current page as returnUrl', async () => {
      TestBed.inject(Session).set(ME_FIXTURE);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/employees');
      const client = TestBed.inject(HttpClient);
      const errors: unknown[] = [];
      client.get('/api/employees').subscribe({ error: (e: unknown) => errors.push(e) });
      client.get('/api/tasks').subscribe({ error: (e: unknown) => errors.push(e) });

      http.expectOne('/api/employees').flush(...ENROLL_403);
      http.expectOne('/api/tasks').flush(...ENROLL_403);
      expect(errors).toHaveLength(2);
      expect(isEnrollmentRequired(errors[0])).toBe(true);

      http.expectOne('/api/me').flush(ME_MFA_REQUIRED); // one reload for both failures
      await settle();

      expect(TestBed.inject(Session).mfaEnrollmentRequired()).toBe(true);
      expect(TestBed.inject(Router).url).toBe('/me/security?enroll=1&returnUrl=%2Femployees');
    });

    it('also catches the 403 that comes back from a request retried after a refresh', async () => {
      TestBed.inject(Session).set(ME_FIXTURE);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/employees');
      TestBed.inject(HttpClient).get('/api/employees').subscribe({ error: () => undefined });

      http.expectOne('/api/employees').flush(null, { status: 401, statusText: 'Unauthorized' });
      http.expectOne('/api/auth/refresh').flush(null, { status: 204, statusText: 'No Content' });
      http.expectOne('/api/employees').flush(...ENROLL_403);
      http.expectOne('/api/me').flush(ME_MFA_REQUIRED);
      await settle();

      expect(TestBed.inject(Router).url).toBe('/me/security?enroll=1&returnUrl=%2Femployees');
    });

    it('leaves the redirect to the guard when the session already says so (keeps the guard\'s returnUrl)', async () => {
      TestBed.inject(Session).set(ME_MFA_REQUIRED);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/employees');
      // a shell call (task count, bell…) fails while / after the guard redirected
      TestBed.inject(HttpClient).get('/api/tasks').subscribe({ error: () => undefined });
      http.expectOne('/api/tasks').flush(...ENROLL_403);
      await settle();

      http.expectNone('/api/me');
      expect(TestBed.inject(Router).url).toBe('/me/security?enroll=1&returnUrl=%2Femployees');
    });

    it('does nothing while already on the security page, and ignores other 403s', async () => {
      TestBed.inject(Session).set(ME_MFA_REQUIRED);
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/me/security');
      const client = TestBed.inject(HttpClient);
      client.get('/api/tasks').subscribe({ error: () => undefined });
      http.expectOne('/api/tasks').flush(...ENROLL_403);
      client.get('/api/x').subscribe({ error: () => undefined });
      http
        .expectOne('/api/x')
        .flush({ type: 'urn:hrforce:problem:forbidden', title: 'x', status: 403 }, { status: 403, statusText: 'Forbidden' });
      await settle();

      http.expectNone('/api/me');
      expect(TestBed.inject(Router).url).toBe('/me/security');
    });
  });
});
