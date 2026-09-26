import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { flushLeaveTypes } from '../../../testing/leave-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../auth/session';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { LanguageService } from '../i18n/language.service';
import { LeaveCatalog, pickLabel } from './leave-catalog';

describe('pickLabel', () => {
  it('picks the language, falls back to French, accepts plain strings', () => {
    expect(pickLabel({ fr: 'Fête', ar: 'عيد', en: 'Feast' }, 'ar')).toBe('عيد');
    expect(pickLabel({ fr: 'Fête', ar: '', en: '' }, 'en')).toBe('Fête');
    expect(pickLabel('Yennayer', 'ar')).toBe('Yennayer');
    expect(pickLabel(null, 'fr')).toBe('');
  });
});

describe('LeaveCatalog', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  it('asks nothing while signed out, then loads GET /leave/types once', async () => {
    const catalog = TestBed.inject(LeaveCatalog);
    TestBed.tick();
    http.expectNone('/api/leave/types');
    expect(catalog.nameOf('t-annual')).toBe('t-annual');

    TestBed.inject(Session).set(ME_FIXTURE);
    TestBed.tick();
    flushLeaveTypes(http);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(TestBed.inject(LeaveCatalog)).toBe(catalog);
    expect(catalog.activeTypes().map((t) => t.code)).toEqual(['annual', 'sick']);
  });

  it('names follow the active language', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    const catalog = TestBed.inject(LeaveCatalog);
    TestBed.tick();
    flushLeaveTypes(http);
    await TestBed.inject(ApplicationRef).whenStable();
    const language = TestBed.inject(LanguageService);

    expect(catalog.nameOf('t-annual')).toBe('Congé annuel');
    language.use('ar', { remember: false });
    expect(catalog.nameOf('t-annual')).toBe('عطلة سنوية');
    expect(catalog.labelOf({ fr: 'Responsable', ar: 'المسؤول', en: 'Manager' })).toBe('المسؤول');
    language.use('en', { remember: false });
    expect(catalog.nameOf('t-sick')).toBe('Sick leave');
  });
});
