import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ME_AR } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { LANGUAGE_STORAGE_KEY, LanguageService } from '../i18n/language.service';
import { authRefreshInterceptor } from './auth-refresh.interceptor';
import { Session } from './session';
import { initializeSession } from './session-init';

/** Lets awaited promise callbacks run (the second request is sent after the first one resolves). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('initializeSession (app initializer)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('requests the XSRF cookie BEFORE /api/me, and only then loads the session', async () => {
    const done = TestBed.runInInjectionContext(() => initializeSession());

    const csrf = http.expectOne('/api/auth/csrf');
    expect(csrf.request.method).toBe('GET');
    http.expectNone('/api/me'); // not yet: csrf is still pending
    csrf.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    http.expectOne('/api/me').flush(ME_AR);
    await done;

    expect(TestBed.inject(Session).user()?.displayName).toBe('Karim Haddad');
  });

  it('still loads the session when the csrf call fails', async () => {
    const done = TestBed.runInInjectionContext(() => initializeSession());
    http.expectOne('/api/auth/csrf').error(new ProgressEvent('error'), { status: 0, statusText: '' });
    await settle();
    http.expectOne('/api/me').flush(null, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/auth/refresh').flush(null, { status: 401, statusText: 'Unauthorized' });

    await expect(done).resolves.toBeUndefined();
    expect(TestBed.inject(Session).isAuthenticated()).toBe(false);
  });

  it("applies the signed-in account's locale when this device has no stored choice", async () => {
    const done = TestBed.runInInjectionContext(() => initializeSession());
    http.expectOne('/api/auth/csrf').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    http.expectOne('/api/me').flush(ME_AR);
    await done;

    expect(TestBed.inject(LanguageService).current()).toBe('ar');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it('keeps the language chosen on this device', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    TestBed.inject(LanguageService).use('en');
    const done = TestBed.runInInjectionContext(() => initializeSession());
    http.expectOne('/api/auth/csrf').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    http.expectOne('/api/me').flush(ME_AR);
    await done;

    expect(TestBed.inject(LanguageService).current()).toBe('en');
  });
});
