import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { isApiProblemError } from '../http/api-problem';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { AuthApi } from './auth-api';
import { authRefreshInterceptor } from './auth-refresh.interceptor';
import { Session } from './session';

const REFRESH = '/api/auth/refresh';
const unauthorized = { status: 401, statusText: 'Unauthorized' };
const problem401 = { type: 'urn:hrforce:problem:unauthenticated', title: 'Unauthorized', status: 401 };

describe('authRefreshInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;
  let session: Session;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        // Same order as app.config.ts: the problem interceptor is the outer one.
        provideHttpClient(withInterceptors([apiProblemInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
    session = TestBed.inject(Session);
    session.set(ME_FIXTURE);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    controller.verify();
    document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  it('refreshes ONCE for three concurrent 401s, then retries each request once', async () => {
    const results = ['/api/a', '/api/b', '/api/c'].map((url) => firstValueFrom(http.get<{ url: string }>(url)));

    for (const url of ['/api/a', '/api/b', '/api/c']) {
      controller.expectOne(url).flush(problem401, unauthorized);
    }
    // Three 401s are pending on one refresh: exactly one POST went out.
    const refresh = controller.expectOne(REFRESH);
    expect(refresh.request.method).toBe('POST');
    refresh.flush(null, { status: 204, statusText: 'No Content' });

    for (const url of ['/api/a', '/api/b', '/api/c']) {
      controller.expectOne(url).flush({ url });
    }
    await expect(Promise.all(results)).resolves.toEqual([{ url: '/api/a' }, { url: '/api/b' }, { url: '/api/c' }]);
    expect(session.isAuthenticated()).toBe(true);
  });

  it('starts a new refresh for a 401 that arrives after the previous refresh finished', async () => {
    const first = firstValueFrom(http.get('/api/a'));
    controller.expectOne('/api/a').flush(problem401, unauthorized);
    controller.expectOne(REFRESH).flush(null, { status: 204, statusText: 'No Content' });
    controller.expectOne('/api/a').flush({});
    await first;

    const second = firstValueFrom(http.get('/api/b'));
    controller.expectOne('/api/b').flush(problem401, unauthorized);
    controller.expectOne(REFRESH).flush(null, { status: 204, statusText: 'No Content' });
    controller.expectOne('/api/b').flush({});
    await expect(second).resolves.toEqual({});
  });

  it('retries only once: a second 401 reaches the caller as an ApiProblemError', async () => {
    const result = firstValueFrom(http.get('/api/a'));
    controller.expectOne('/api/a').flush(problem401, unauthorized);
    controller.expectOne(REFRESH).flush(null, { status: 204, statusText: 'No Content' });
    controller.expectOne('/api/a').flush(problem401, unauthorized);

    await expect(result).rejects.toSatisfy((e: unknown) => isApiProblemError(e) && e.status === 401);
    controller.expectNone(REFRESH);
  });

  it('never refreshes for /api/auth/* (a 401 from login is an answer)', async () => {
    const result = firstValueFrom(TestBed.inject(AuthApi).login({ email: 'a@b.dz', password: 'x' }));
    controller.expectOne('/api/auth/login').flush(problem401, unauthorized);

    await expect(result).rejects.toSatisfy((e: unknown) => isApiProblemError(e) && e.status === 401);
    controller.expectNone(REFRESH);
  });

  it('ignores non-/api URLs and non-401 errors', async () => {
    const asset = firstValueFrom(http.get('/i18n/fr.json'));
    controller.expectOne('/i18n/fr.json').flush('', unauthorized);
    await expect(asset).rejects.toBeDefined();

    const forbidden = firstValueFrom(http.get('/api/a'));
    controller.expectOne('/api/a').flush({ type: 't', title: 'Forbidden', status: 403 }, { status: 403, statusText: 'Forbidden' });
    await expect(forbidden).rejects.toSatisfy((e: unknown) => isApiProblemError(e) && e.status === 403);
    controller.expectNone(REFRESH);
  });

  it('treats 409 refresh-race as success and retries', async () => {
    const result = firstValueFrom(http.get('/api/a'));
    controller.expectOne('/api/a').flush(problem401, unauthorized);
    controller.expectOne(REFRESH).flush(
      { type: 'urn:hrforce:problem:refresh-race', title: 'Conflict', status: 409 },
      { status: 409, statusText: 'Conflict' },
    );
    controller.expectOne('/api/a').flush({ ok: true });

    await expect(result).resolves.toEqual({ ok: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('on refresh failure clears the session and navigates to /login?returnUrl=<current page>', async () => {
    const result = firstValueFrom(http.get('/api/a'));
    controller.expectOne('/api/a').flush(problem401, unauthorized);
    controller.expectOne(REFRESH).flush(
      { type: 'urn:hrforce:problem:session-expired', title: 'Unauthorized', status: 401 },
      unauthorized,
    );

    await expect(result).rejects.toSatisfy((e: unknown) => isApiProblemError(e) && e.status === 401);
    expect(session.isAuthenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/' } });
  });

  it('does not navigate when the request opted out (the startup /api/me check)', async () => {
    const result = firstValueFrom(TestBed.inject(AuthApi).me());
    controller.expectOne('/api/me').flush(problem401, unauthorized);
    controller.expectOne(REFRESH).flush(problem401, unauthorized);

    await expect(result).rejects.toBeDefined();
    expect(session.isAuthenticated()).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('re-stamps a retried POST with the XSRF token the refresh re-issued', async () => {
    document.cookie = 'XSRF-TOKEN=before; path=/';
    const result = firstValueFrom(http.post('/api/things', { a: 1 }));
    const original = controller.expectOne('/api/things');
    expect(original.request.headers.get('X-XSRF-TOKEN')).toBe('before');
    original.flush(problem401, unauthorized);

    const refresh = controller.expectOne(REFRESH);
    expect(refresh.request.headers.get('X-XSRF-TOKEN')).toBe('before');
    document.cookie = 'XSRF-TOKEN=after; path=/'; // what the refresh response's Set-Cookie does
    refresh.flush(null, { status: 204, statusText: 'No Content' });

    const retried = controller.expectOne('/api/things');
    expect(retried.request.headers.get('X-XSRF-TOKEN')).toBe('after');
    expect(retried.request.body).toEqual({ a: 1 });
    retried.flush({ id: 1 });
    await expect(result).resolves.toEqual({ id: 1 });
  });
});
