import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { flushAccessCatalog, ROLE_CUSTOM, ROLES } from '../../../testing/access-fixtures';
import { ME_FIXTURE, ME_LECTURE } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../auth/session';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { LanguageService } from '../i18n/language.service';
import { AccessApi } from './access-api';
import { AccessCatalog } from './access-catalog';

describe('AccessCatalog / AccessApi', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.inject(LanguageService).use('fr');
  });

  it('sends nothing without access.read (signed out, or a read-only user)', () => {
    const catalog = TestBed.inject(AccessCatalog);
    TestBed.tick();
    http.expectNone('/api/access/permissions');
    http.expectNone('/api/access/roles');

    TestBed.inject(Session).set(ME_LECTURE);
    TestBed.tick();
    http.expectNone('/api/access/roles');
    expect(catalog.roles()).toEqual([]);
  });

  it('loads once access.read is held; labels, groups and role names follow the active language', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    const catalog = TestBed.inject(AccessCatalog);
    TestBed.tick();
    flushAccessCatalog(http);
    await TestBed.inject(ApplicationRef).whenStable();

    expect(catalog.groups().map((g) => g.group)).toEqual(['organization', 'access', 'employee', 'sensitive']);
    expect(catalog.permissionLabel('access.grant')).toBe('Attribuer des rôles');
    expect(catalog.permissionLabel('unknown.code')).toBe('unknown.code');
    expect(catalog.isSensitive('employee.salary.read')).toBe(true);
    expect(catalog.roleName(ROLE_CUSTOM)).toBe('Gestionnaire paie');

    TestBed.inject(LanguageService).use('ar');
    expect(catalog.permissionLabel('access.grant')).toBe('إسناد الأدوار');
    expect(catalog.roleName(ROLE_CUSTOM)).toBe('مسير الأجور');
  });

  it('a new /me for the same company does not re-fetch roles; another company does', async () => {
    const session = TestBed.inject(Session);
    session.set(ME_FIXTURE);
    TestBed.inject(AccessCatalog);
    TestBed.tick();
    flushAccessCatalog(http);
    await TestBed.inject(ApplicationRef).whenStable();

    session.set({ ...ME_FIXTURE });
    TestBed.tick();
    http.expectNone('/api/access/roles');

    session.set({ ...ME_FIXTURE, company: { id: 'c-other', code: 'OTHER', name: 'Autre' } });
    TestBed.tick();
    http.expectOne('/api/access/roles').flush({ items: ROLES });
  });

  it('AccessApi: grants query params, and the write endpoints', () => {
    const api = TestBed.inject(AccessApi);
    TestBed.runInInjectionContext(() => api.grantsResource(() => ({ userId: 'u-1', includeEnded: true })));
    TestBed.runInInjectionContext(() => api.grantsResource(() => ({ unitId: 'r-est', includeEnded: false })));
    TestBed.tick();
    http.expectOne('/api/access/grants?userId=u-1&includeEnded=true').flush({ items: [] });
    http.expectOne('/api/access/grants?unitId=r-est').flush({ items: [] });

    api.endGrant('g-1', '2026-10-01').subscribe();
    const end = http.expectOne('/api/access/grants/g-1/end');
    expect(end.request.method).toBe('POST');
    expect(end.request.body).toEqual({ validTo: '2026-10-01' });
    end.flush({});

    api.updateRole('r-1', { permissions: ['site.read'] }).subscribe();
    const patch = http.expectOne('/api/access/roles/r-1');
    expect(patch.request.method).toBe('PATCH');
    patch.flush({});
  });
});
