import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { effect } from '@angular/core';
import { ME_FIXTURE, ME_LECTURE, meWith } from '../../../testing/auth-fixtures';
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

  describe('permissions', () => {
    it('signed out: holds nothing', () => {
      expect(session.permissions().size).toBe(0);
      expect(session.scopes()).toEqual({});
      expect(session.can('org_unit.read')).toBe(false);
    });

    it('can(code) answers "held anywhere" from /api/me permissions; scopes are exposed as sent', () => {
      session.set(ME_LECTURE);

      expect(session.can('org_unit.read')).toBe(true);
      expect(session.can('access.read')).toBe(false);
      expect(session.scopes()['org_unit.read']).toEqual([{ unitId: 'r-ouest', includeDescendants: true }]);
    });

    it('fails closed on a /me without permissions (API from before the Authorization step)', () => {
      const legacy = { user: ME_FIXTURE.user, company: ME_FIXTURE.company, companies: ME_FIXTURE.companies };
      session.set(legacy as unknown as typeof ME_FIXTURE);

      expect(session.can('org_unit.read')).toBe(false);
      expect(session.scopes()).toEqual({});
    });

    it('can() is reactive inside a computed/effect; allows() notifies only when the answer flips', () => {
      const seen: boolean[] = [];
      const canGrant = session.allows('access.grant');
      TestBed.runInInjectionContext(() => effect(() => seen.push(canGrant())));
      TestBed.tick();

      session.set(meWith(['access.grant']));
      TestBed.tick();
      // Same answer again (a different /me object, still holding access.grant): no new notification.
      session.set(meWith(['access.grant', 'access.read']));
      TestBed.tick();
      session.clear();
      TestBed.tick();

      expect(seen).toEqual([false, true, false]);
    });
  });
});
