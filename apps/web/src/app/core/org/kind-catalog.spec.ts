import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { flushKinds } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { LanguageService } from '../i18n/language.service';
import { KindCatalog } from './kind-catalog';

describe('KindCatalog', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function loaded(): Promise<KindCatalog> {
    const catalog = TestBed.inject(KindCatalog);
    TestBed.tick();
    flushKinds(http);
    await TestBed.inject(ApplicationRef).whenStable();
    return catalog;
  }

  it('loads GET /org/kinds once per app, however many consumers inject it', async () => {
    const catalog = await loaded();
    expect(TestBed.inject(KindCatalog)).toBe(catalog);
    TestBed.tick();
    http.expectNone('/api/org/kinds');
    expect(catalog.kinds().map((k) => k.code)).toEqual(['direction_generale', 'department', 'region', 'agency', 'service']);
  });

  it('labels follow the active language, and fall back to the code', async () => {
    const catalog = await loaded();
    const language = TestBed.inject(LanguageService);

    language.use('fr');
    expect(catalog.labelOf('agency')).toBe('Agence');
    language.use('ar');
    expect(catalog.labelOf('agency')).toBe('وكالة');
    language.use('en');
    expect(catalog.labelOf('agency')).toBe('Agency');
    expect(catalog.labelOf('unknown_kind')).toBe('unknown_kind');
  });

  it('shows codes before the catalogue arrives', () => {
    const catalog = TestBed.inject(KindCatalog);
    expect(catalog.labelOf('region')).toBe('region');
    expect(catalog.allowedChildKinds('region')).toEqual([]);
    TestBed.tick();
    flushKinds(http);
  });

  it('derives allowed child and parent kinds from the data', async () => {
    const catalog = await loaded();
    expect(catalog.allowedChildKinds('direction_generale')).toEqual(['department']);
    expect(catalog.allowedChildKinds('department')).toEqual(['region', 'service']);
    expect(catalog.allowedChildKinds('region')).toEqual(['agency', 'service']);
    expect(catalog.allowedChildKinds('agency')).toEqual(['service']);
    expect(catalog.allowedChildKinds('service')).toEqual([]);
    expect(catalog.allowedParentKinds('service')).toEqual(['department', 'region', 'agency']);
    expect(catalog.allowedParentKinds('direction_generale')).toEqual([]);
  });

  it('exposes a load error and retries on reload()', async () => {
    const catalog = TestBed.inject(KindCatalog);
    TestBed.tick();
    http
      .expectOne('/api/org/kinds')
      .flush({ type: 'about:blank', title: 'Boom', status: 500 }, { status: 500, statusText: 'Server Error' });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(catalog.error()).toMatchObject({ status: 500 });

    catalog.reload();
    TestBed.tick();
    flushKinds(http);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(catalog.loaded()).toBe(true);
    expect(catalog.error()).toBeUndefined();
  });
});
