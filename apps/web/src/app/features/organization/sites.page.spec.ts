import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { SITES } from '../../../testing/org-fixtures';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { Site } from '../../core/org/org.models';
import { ORGANIZATION_ROUTES } from './organization.routes';

const isSites = (r: { url: string; method: string }) => r.url === '/api/org/sites' && r.method === 'GET';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('SitesPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'organization', children: ORGANIZATION_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    // Signed in as the admin (holds site.read: the Sites tab and route exist).
    TestBed.inject(Session).set(ME_FIXTURE);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(url: string, items: readonly Site[] = SITES): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne(isSites).flush({ items });
    await settle();
  }

  function rows(): string[][] {
    return [...el().querySelectorAll('table.sites tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim() ?? ''),
    );
  }

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`);
    if (!(input instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('lists sites with code, name, wilaya and address', async () => {
    await open('/organization/sites');
    expect(rows()).toEqual([
      ['ALG-HQ', 'Alger – Siège', 'Alger', ''],
      ['ANNABA', 'Annaba', 'Annaba', '1 rue du Port'],
      ['CNE', 'Constantine', 'Constantine', ''],
    ]);
    expect(el().querySelector('app-org-nav a[aria-current="page"]')?.textContent?.trim()).toBe('Sites');
  });

  it('searches through the ?q= query param', async () => {
    await open('/organization/sites');
    const search = el().querySelector('#sites-q') as HTMLInputElement;
    search.value = ' ann ';
    el().querySelector('form[role="search"]')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();

    expect(TestBed.inject(Router).url).toBe('/organization/sites?q=ann');
    const req = http.expectOne(isSites);
    expect(req.request.urlWithParams).toBe('/api/org/sites?q=ann');
    req.flush({ items: [] });
    await settle();
    expect(el().querySelector('table.sites tbody')?.textContent).toContain('Aucun site ne correspond à « ann ».');
  });

  it('creates a site and reloads the list; a blank address is left out', async () => {
    await open('/organization/sites');
    (el().querySelector('[data-action="create-site"]') as HTMLButtonElement).click();
    await settle();

    fill('create-site-code', 'ORAN');
    fill('create-site-name', ' Oran ');
    fill('create-site-wilaya', 'Oran');
    fill('create-site-address', '  ');
    el().querySelector('app-create-site-form form')?.dispatchEvent(new Event('submit'));
    await settle();

    const post = http.expectOne((r) => r.url === '/api/org/sites' && r.method === 'POST');
    expect(post.request.body).toEqual({ code: 'ORAN', name: 'Oran', wilaya: 'Oran' });
    const oran: Site = { id: 's-oran', code: 'ORAN', name: 'Oran', wilaya: 'Oran', address: null };
    post.flush(oran, { status: 201, statusText: 'Created' });
    await settle();

    http.expectOne(isSites).flush({ items: [...SITES, oran] });
    await settle();
    expect(el().querySelector('[role="status"]')?.textContent).toContain('Site « Oran » créé.');
    expect(el().querySelector('app-create-site-form')).toBeNull();
    expect(rows()).toHaveLength(4);
  });

  it('maps a 409 site-code-taken to the code field', async () => {
    await open('/organization/sites');
    (el().querySelector('[data-action="create-site"]') as HTMLButtonElement).click();
    await settle();
    fill('create-site-code', 'CNE');
    fill('create-site-name', 'Constantine 2');
    fill('create-site-wilaya', 'Constantine');
    el().querySelector('app-create-site-form form')?.dispatchEvent(new Event('submit'));
    await settle();

    http
      .expectOne((r) => r.url === '/api/org/sites' && r.method === 'POST')
      .flush(
        {
          type: 'urn:hrforce:problem:site-code-taken',
          title: 'Conflict',
          status: 409,
          errors: [{ field: 'code', code: 'taken', message: 'Site code already used.' }],
        },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();

    expect(el().querySelector('#create-site-code-error')?.textContent?.trim()).toBe('Ce code de site est déjà utilisé.');
    expect(el().querySelector('#create-site-code')?.getAttribute('aria-invalid')).toBe('true');
    expect(el().querySelector('app-create-site-form [role="alert"]')).toBeNull();
  });

  it('validates required fields client-side', async () => {
    await open('/organization/sites');
    (el().querySelector('[data-action="create-site"]') as HTMLButtonElement).click();
    await settle();
    fill('create-site-code', 'bad code');
    el().querySelector('app-create-site-form form')?.dispatchEvent(new Event('submit'));
    await settle();

    expect(el().querySelector('#create-site-code-error')?.textContent?.trim()).toBe('Format de code invalide.');
    expect(el().querySelector('#create-site-wilaya-error')?.textContent?.trim()).toBe('Ce champ est obligatoire.');
    http.expectNone((r) => r.method === 'POST');
  });
});
