import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { authRefreshInterceptor } from './auth-refresh.interceptor';
import { Session } from './session';

describe('Session', () => {
  let session: Session;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    session = TestBed.inject(Session);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('starts signed out', () => {
    expect(session.isAuthenticated()).toBe(false);
    expect(session.user()).toBeNull();
    expect(session.company()).toBeNull();
    expect(session.companies()).toEqual([]);
  });

  it('load() fills user, company and companies from GET /api/me', async () => {
    const done = session.load();
    const req = http.expectOne('/api/me');
    expect(req.request.method).toBe('GET');
    req.flush(ME_FIXTURE);
    await done;

    expect(session.isAuthenticated()).toBe(true);
    expect(session.user()?.displayName).toBe('Amina Benali');
    expect(session.company()?.name).toBe('Groupe Démo');
    expect(session.companies()).toHaveLength(1);
  });

  it('load() ends signed out on 401 (after the refresh also fails) without rejecting', async () => {
    session.set(ME_FIXTURE);
    const done = session.load();
    http.expectOne('/api/me').flush(null, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/auth/refresh').flush(null, { status: 401, statusText: 'Unauthorized' });

    await expect(done).resolves.toBeUndefined();
    expect(session.isAuthenticated()).toBe(false);
  });

  it('load() is signed in when the refresh succeeds (expired access token on reload)', async () => {
    const done = session.load();
    http.expectOne('/api/me').flush(null, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/auth/refresh').flush(null, { status: 204, statusText: 'No Content' });
    http.expectOne('/api/me').flush(ME_FIXTURE);
    await done;

    expect(session.isAuthenticated()).toBe(true);
  });

  it('clear() signs out', () => {
    session.set(ME_FIXTURE);
    session.clear();

    expect(session.isAuthenticated()).toBe(false);
    expect(session.user()).toBeNull();
  });
});
