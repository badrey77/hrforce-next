import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { isApiProblemError } from '../http/api-problem';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { OrgApi } from './org-api';

describe('OrgApi', () => {
  let api: OrgApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    api = TestBed.inject(OrgApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('searches /api/org/units with q, repeated kind params and asOf, omitting empty values', async () => {
    const full = firstValueFrom(api.search({ q: ' cen ', kinds: ['region', 'agency'], asOf: '2025-01-31' }));
    const req = http.expectOne((r) => r.url === '/api/org/units');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.getAll('kind')).toEqual(['region', 'agency']);
    expect(req.request.urlWithParams).toBe('/api/org/units?q=cen&kind=region&kind=agency&asOf=2025-01-31');
    req.flush({ items: [] });
    await expect(full).resolves.toEqual({ items: [] });

    void firstValueFrom(api.search({ q: '  ', kinds: [] }));
    expect(http.expectOne('/api/org/units').request.params.keys()).toEqual([]);
  });

  it('gets, creates and changes units on the contract URLs', () => {
    void firstValueFrom(api.get('u-1'));
    expect(http.expectOne('/api/org/units/u-1').request.method).toBe('GET');

    const body = { kind: 'agency', code: 'AG-ORAN', name: 'Agence Oran', parentId: 'r-1', siteId: null, validFrom: '2025-01-01' };
    void firstValueFrom(api.create(body));
    const post = http.expectOne('/api/org/units');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual(body);

    void firstValueFrom(api.change('u-1', { siteId: null }));
    const patch = http.expectOne('/api/org/units/u-1');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ siteId: null });
  });

  it('creates sites and lists them as a resource that follows q', async () => {
    const site = { code: 'ORAN', name: 'Oran', wilaya: 'Oran', address: '2 bd Front de mer' };
    void firstValueFrom(api.createSite(site));
    const post = http.expectOne('/api/org/sites');
    expect(post.request.method).toBe('POST');
    expect(post.request.body).toEqual(site);

    const q = signal('');
    const sites = TestBed.runInInjectionContext(() => api.sitesResource(q));
    TestBed.tick();
    const all = http.expectOne((r) => r.url === '/api/org/sites');
    expect(all.request.params.keys()).toEqual([]);
    all.flush({ items: [] });

    q.set(' ora ');
    TestBed.tick();
    const filtered = http.expectOne((r) => r.url === '/api/org/sites');
    expect(filtered.request.urlWithParams).toBe('/api/org/sites?q=ora');
    filtered.flush({ items: [{ id: 's-1', ...site }] });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(sites.value()?.items[0]?.code).toBe('ORAN');
  });

  it('treeResource requests /api/org/tree?asOf= and follows the signal', async () => {
    const asOf = signal<string | undefined>(undefined);
    const tree = TestBed.runInInjectionContext(() => api.treeResource(asOf));

    TestBed.tick();
    http.expectNone((r) => r.url === '/api/org/tree');
    expect(tree.status()).toBe('idle');

    asOf.set('2025-06-30');
    TestBed.tick();
    const req = http.expectOne((r) => r.url === '/api/org/tree');
    expect(req.request.urlWithParams).toBe('/api/org/tree?asOf=2025-06-30');
    const root = { id: 'dg', kind: 'direction_generale', code: 'DG', name: 'Direction Générale', site: null, children: [], _actions: [] };
    req.flush({ asOf: '2025-06-30', root });
    await TestBed.inject(ApplicationRef).whenStable();

    expect(tree.value()?.root.code).toBe('DG');
  });

  it('unitResource surfaces API errors as ApiProblemError', async () => {
    const id = signal<string | null>('missing');
    const unit = TestBed.runInInjectionContext(() => api.unitResource(id));
    TestBed.tick();

    http
      .expectOne('/api/org/units/missing')
      .flush({ type: 'about:blank', title: 'Not Found', status: 404 }, { status: 404, statusText: 'Not Found' });
    await TestBed.inject(ApplicationRef).whenStable();

    expect(unit.status()).toBe('error');
    const error = unit.error();
    expect(isApiProblemError(error)).toBe(true);
    expect(error).toMatchObject({ status: 404 });
  });
});
