import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { flushAccessCatalog } from '../../../testing/access-fixtures';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { assignment, created, SECRET, SSO_DEMO, SSO_DEMO_READ_ONLY } from '../../../testing/sso-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { ACCESS_ROUTES } from './access.routes';

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const ADMIN = ['sso.read', 'sso.manage_apps', 'sso.assign'];
const CLIENTS = '/api/sso/clients';
const DETAIL = `/api/sso/clients/${SSO_DEMO.id}`;

describe('Access › Applications', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'access', children: ACCESS_ROUTES }, { path: 'elsewhere', children: [] }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    http.verify();
    TestBed.inject(LanguageService).use('fr', { remember: false });
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const button = (action: string) => el().querySelector<HTMLButtonElement>(`[data-action="${action}"]`);

  async function start(permissions: readonly string[], url: string): Promise<void> {
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url);
    await settle();
  }

  function type(selector: string, value: string): void {
    const input = el().querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`missing ${selector}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  async function createApp(): Promise<void> {
    await start(ADMIN, '/access/apps/new');
    type('#sso-client-id', 'paie-app');
    type('#sso-name', 'Paie');
    type('#redirectUris-0', 'https://paie.example.dz/callback');
    el().querySelector('form[data-form="sso-app"]')?.dispatchEvent(new Event('submit'));
    await settle();
    const post = http.expectOne(CLIENTS);
    expect(post.request.body).toEqual({
      clientId: 'paie-app',
      name: 'Paie',
      redirectUris: ['https://paie.example.dz/callback'],
      postLogoutRedirectUris: [],
      clientAuthMethod: 'client_secret_basic',
    });
    post.flush(created({ ...SSO_DEMO, id: 'c-paie', clientId: 'paie-app' }), { status: 201, statusText: 'Created' });
    await settle();
  }

  it('/access sends an sso.read-only user to the Applications tab (the only tab shown)', async () => {
    await start(['sso.read'], '/access');
    http.expectOne(CLIENTS).flush({ items: [SSO_DEMO] });
    await settle();

    expect(router.url).toBe('/access/apps');
    const tabs = [...el().querySelectorAll('app-access-nav a')].map((a) => a.getAttribute('data-tab'));
    expect(tabs).toEqual(['apps']);
  });

  it('lists apps: names, client id (ltr), status, counts; no create button without sso.manage_apps', async () => {
    await start(['sso.read'], '/access/apps');
    http.expectOne(CLIENTS).flush({ items: [SSO_DEMO, { ...SSO_DEMO, id: 'c-2', clientId: 'old-app', name: 'Ancienne', nameAr: null, status: 'disabled' }] });
    await settle();

    const rows = [...el().querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Démo SSO');
    expect(rows[0]?.textContent).toContain('تطبيق تجريبي للدخول الموحد');
    expect(rows[0]?.querySelector('.code')?.getAttribute('dir')).toBe('ltr');
    expect(rows[0]?.textContent).toContain('Active');
    expect(rows[1]?.textContent).toContain('Désactivée');
    expect(button('new-app')).toBeNull();
    expect(el().querySelector('[data-note="read-only"]')).not.toBeNull();
  });

  it('/access/apps/new without sso.manage_apps is the 404 page', async () => {
    await start(['sso.read'], '/access/apps/new');
    expect(el().querySelector('h1')?.textContent?.trim()).toBe('404');
  });

  describe('new app and the show-once secret', () => {

    it('validates URIs before sending (http only for loopback, no fragment)', async () => {
      await start(ADMIN, '/access/apps/new');
      type('#sso-client-id', 'paie-app');
      type('#sso-name', 'Paie');
      type('#redirectUris-0', 'http://paie.example.dz/callback');
      el().querySelector('form[data-form="sso-app"]')?.dispatchEvent(new Event('submit'));
      await settle();
      http.expectNone(CLIENTS);
      expect(el().querySelector('#redirectUris-0-error')?.textContent).toContain('« http:// » est accepté uniquement pour localhost');

      button('add-redirectUris')?.click();
      await settle();
      expect(el().querySelector('#redirectUris-1')).not.toBeNull();
    });

    it('maps 409 sso-client-id-taken onto the client id field', async () => {
      await start(ADMIN, '/access/apps/new');
      type('#sso-client-id', 'sso-demo');
      type('#sso-name', 'Démo');
      type('#redirectUris-0', 'http://localhost:4300/callback');
      el().querySelector('form[data-form="sso-app"]')?.dispatchEvent(new Event('submit'));
      await settle();
      http.expectOne(CLIENTS).flush({ type: 'urn:hrforce:problem:sso-client-id-taken', title: 'taken', status: 409 }, { status: 409, statusText: 'Conflict' });
      await settle();
      expect(el().querySelector('#sso-client-id-error')?.textContent).toContain('déjà utilisé');
    });

    it('shows the secret once; "Terminer" is gated by the checkbox and opens the detail page', async () => {
      await createApp();
      const field = el().querySelector<HTMLInputElement>('[data-field="secret"]');
      expect(field?.value).toBe(SECRET);
      expect(field?.readOnly).toBe(true);
      expect(el().querySelector('[data-note="shown-once"]')?.textContent).toContain('Ce secret ne sera plus jamais affiché');

      const finish = button('finish');
      expect(finish?.disabled).toBe(true);
      const ack = el().querySelector<HTMLInputElement>('#sso-secret-ack');
      ack?.click();
      await settle();
      expect(finish?.disabled).toBe(false);

      finish?.click();
      // The detail page is a lazy chunk: wait for the navigation AND for the page's own request, however long the
      // import takes under load (the URL changes a tick before the new page sends its request).
      let detail = http.match('/api/sso/clients/c-paie');
      for (let i = 0; i < 50 && detail.length === 0; i++) {
        await settle();
        detail = http.match('/api/sso/clients/c-paie');
      }
      expect(router.url).toBe('/access/apps/c-paie');
      expect(detail).toHaveLength(1);
      detail[0]?.flush({ ...SSO_DEMO, id: 'c-paie' });
      await settle();
      expect(el().textContent).not.toContain(SECRET);
    });

    it('copies with the Clipboard API, or selects the text when it is refused', async () => {
      await createApp();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      button('copy-secret')?.click();
      await settle();
      expect(writeText).toHaveBeenCalledWith(SECRET);
      expect(el().querySelector('[data-state="copy"]')?.textContent).toContain('Secret copié.');

      writeText.mockRejectedValue(new Error('denied'));
      const select = vi.spyOn(HTMLInputElement.prototype, 'select');
      button('copy-secret')?.click();
      await settle();
      expect(select).toHaveBeenCalled();
      expect(el().querySelector('[data-state="copy"]')?.textContent).toContain('le secret est sélectionné');
    });

    it('leaving while the secret is shown asks first (canDeactivate); the secret is dropped with the page', async () => {
      await createApp();
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await router.navigateByUrl('/elsewhere');
      await settle();
      expect(confirm).toHaveBeenCalledWith('Le secret ne sera plus jamais affiché. Quitter cette page quand même ?');
      expect(router.url).toBe('/access/apps/new');

      confirm.mockReturnValue(true);
      await router.navigateByUrl('/elsewhere');
      await settle();
      expect(router.url).toBe('/elsewhere');
      expect(document.body.textContent).not.toContain(SECRET);
    });
  });

  describe('detail', () => {
    it('header actions follow _actions; a regional reader sees none and a read-only form', async () => {
      await start(['sso.read'], `/access/apps/${SSO_DEMO.id}`);
      http.expectOne(DETAIL).flush(SSO_DEMO_READ_ONLY);
      await settle();
      expect(button('rotate')).toBeNull();
      expect(button('disable')).toBeNull();
      expect(button('save-app')).toBeNull();
      expect(el().querySelector<HTMLInputElement>('#sso-name')?.disabled).toBe(true);
      expect(el().querySelector('[data-section="connect"]')?.textContent).toContain('http://localhost:4200/oidc/.well-known/openid-configuration');
      expect(el().querySelector('[data-app-tab="history"]')).toBeNull(); // no audit.read
    });

    it('rotate: a warning dialog, then the new secret in the same panel', async () => {
      await start(ADMIN, `/access/apps/${SSO_DEMO.id}`);
      http.expectOne(DETAIL).flush(SSO_DEMO);
      await settle();
      expect(el().querySelector<HTMLInputElement>('#sso-client-id')?.disabled).toBe(true); // immutable

      button('rotate')?.click();
      await settle();
      expect(el().querySelector('dialog[data-dialog="rotate"]')?.hasAttribute('open')).toBe(true);
      expect(el().querySelector('#rotate-text')?.textContent).toContain('cessera de fonctionner immédiatement');
      button('confirm-rotate')?.click();
      await settle();
      http.expectOne(`${DETAIL}/rotate-secret`).flush(created());
      await settle();
      http.expectOne(DETAIL).flush(SSO_DEMO);
      await settle();
      expect(el().querySelector<HTMLInputElement>('[data-field="secret"]')?.value).toBe(SECRET);
    });

    it('disable asks for a reason (3–500 characters)', async () => {
      await start(ADMIN, `/access/apps/${SSO_DEMO.id}`);
      http.expectOne(DETAIL).flush(SSO_DEMO);
      await settle();
      button('disable')?.click();
      await settle();
      el().querySelector('dialog[data-dialog="disable"] form')?.dispatchEvent(new Event('submit'));
      await settle();
      http.expectNone(`${DETAIL}/disable`);

      const reason = el().querySelector<HTMLTextAreaElement>('#disable-reason');
      if (reason) {
        reason.value = 'Application retirée';
        reason.dispatchEvent(new Event('input'));
      }
      el().querySelector('dialog[data-dialog="disable"] form')?.dispatchEvent(new Event('submit'));
      await settle();
      const post = http.expectOne(`${DETAIL}/disable`);
      expect(post.request.body).toEqual({ reason: 'Application retirée' });
      post.flush({ ...SSO_DEMO, status: 'disabled', _actions: ['enable'] });
      await settle();
      http.expectOne(DETAIL).flush({ ...SSO_DEMO, status: 'disabled', disabledAt: '2026-10-01T08:00:00Z', disabledReason: 'Application retirée', _actions: ['enable'] });
      await settle();
      expect(button('enable')).not.toBeNull();
      expect(el().querySelector('[data-field="disabled"]')?.textContent).toContain('Application retirée');
    });

    it('roles tab: delete is disabled with the reason while the role is assigned', async () => {
      await start(ADMIN, `/access/apps/${SSO_DEMO.id}`);
      http.expectOne(DETAIL).flush(SSO_DEMO);
      await settle();
      el().querySelector<HTMLButtonElement>('[data-app-tab="roles"]')?.click();
      await settle();

      const operator = el().querySelector('tr[data-role="operator"]');
      expect(operator?.querySelector<HTMLButtonElement>('[data-action="delete-role"]')?.disabled).toBe(true);
      expect(operator?.textContent).toContain('retirez ces attributions');
      const supervisor = el().querySelector('tr[data-role="supervisor"] [data-action="delete-role"]') as HTMLButtonElement;
      supervisor.click();
      await settle();
      button('confirm-delete-role')?.click();
      await settle();
      http.expectOne('/api/sso/roles/ar-supervisor').flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      http.expectOne(DETAIL).flush(SSO_DEMO);
      await settle();
      expect(el().textContent).toContain('Rôle « supervisor » supprimé.');
    });

    it('users tab: assigns a role to a searched user; the admin cannot pick themselves', async () => {
      await start([...ADMIN, 'access.read'], `/access/apps/${SSO_DEMO.id}`);
      flushAccessCatalog(http);
      http.expectOne(DETAIL).flush(SSO_DEMO);
      await settle();
      el().querySelector<HTMLButtonElement>('[data-app-tab="users"]')?.click();
      await settle();
      http.expectOne((r) => r.url === '/api/sso/assignments' && r.params.get('clientId') === SSO_DEMO.id).flush({ items: [assignment()] });
      await settle();
      expect(el().querySelector('tr[data-assignment="as-1"]')?.textContent).toContain('Nadia Agent');

      button('assign')?.click();
      await settle();
      http.expectOne((r) => r.url === '/api/access/users').flush({
        items: [
          { id: 'u-amina', email: 'rh.admin@demo.dz', displayName: 'Amina Benali', status: 'active', grants: [] },
          { id: 'u-chef', email: 'chef.annaba@demo.dz', displayName: 'Chef Annaba', status: 'active', grants: [] },
        ],
      });
      await settle();
      expect(el().querySelector('[data-user="u-amina"]')?.getAttribute('data-state')).toBe('self');
      expect(el().querySelector('#assign-user-u-amina')).toBeNull();

      el().querySelector<HTMLInputElement>('#assign-user-u-chef')?.click();
      const select = el().querySelector<HTMLSelectElement>('#assign-role');
      if (select) {
        select.value = 'ar-supervisor';
        select.dispatchEvent(new Event('change'));
      }
      button('confirm-assign')?.closest('form')?.dispatchEvent(new Event('submit'));
      await settle();
      const post = http.expectOne('/api/sso/assignments');
      expect(post.request.body).toEqual({ userId: 'u-chef', roleId: 'ar-supervisor' });
      post.flush(assignment({ id: 'as-2', user: { id: 'u-chef', email: 'chef.annaba@demo.dz', displayName: 'Chef Annaba' } }), { status: 201, statusText: 'Created' });
      await settle();
      http.expectOne((r) => r.url === '/api/sso/assignments').flush({ items: [assignment()] });
      http.expectOne(DETAIL).flush(SSO_DEMO);
      await settle();
      expect(el().textContent).toContain('Rôle attribué à');
    });
  });
});
