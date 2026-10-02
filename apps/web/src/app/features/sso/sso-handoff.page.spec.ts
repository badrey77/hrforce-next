import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ME_FIXTURE, ME_MFA_REQUIRED } from '../../../testing/auth-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { Me } from '../../core/auth/auth.models';
import { Session } from '../../core/auth/session';
import { PAGE_LOCATION } from '../../core/browser/page-location';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import type { SsoInteractionView } from '../../core/sso/sso.models';
import { isProviderUrl, SsoHandoffPage } from './sso-handoff.page';

@Component({ template: '<p>other page</p>' })
class OtherPage {}

const UID = 'Ab3_dE-fGhIjKlMnOpQrStU';
const BASE = `/api/sso/interactions/${UID}`;
const RESUME = `http://localhost:4200/oidc/auth/${UID}`;

function details(extra: Partial<SsoInteractionView> = {}): SsoInteractionView {
  return {
    uid: UID,
    client: { clientId: 'sso-demo', name: 'Démo SSO', nameAr: 'تطبيق تجريبي للدخول الموحد' },
    freshLoginRequired: false,
    uiLocales: [],
    ...extra,
  };
}

function problem(status: number, slug: string) {
  return [{ type: `urn:hrforce:problem:${slug}`, title: slug, status }, { status, statusText: 'Error' }] as const;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe('SsoHandoffPage (/sso/:uid)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    assign = vi.fn();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter(
          [
            { path: 'sso/:uid', component: SsoHandoffPage },
            { path: 'login', component: OtherPage },
            { path: 'me/security', component: OtherPage },
            { path: '', component: OtherPage },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        { provide: PAGE_LOCATION, useValue: { assign } },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement | null;
  const text = () => el()?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const button = (action: string) => el()?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`) ?? null;

  async function open(me: Me | null, view: SsoInteractionView = details(), url = `/sso/${UID}`): Promise<void> {
    if (me) TestBed.inject(Session).set(me);
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne(`${BASE}/details`).flush(view);
    await settle();
  }

  it('signed in: completes silently and leaves the SPA with location.assign (never the router)', async () => {
    await open(ME_FIXTURE);
    expect(text()).toContain('Connexion à « ⁨Démo SSO⁩ »…');
    const complete = http.expectOne(`${BASE}/complete`);
    expect(complete.request.method).toBe('POST');
    complete.flush({ redirectTo: RESUME });
    await settle();

    expect(assign).toHaveBeenCalledWith(RESUME);
    expect(router.url).toBe(`/sso/${UID}`);
    expect(text()).not.toContain(UID); // the page never renders the uid
  });

  it('shows the Arabic app name in the Arabic UI', async () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    await open(ME_FIXTURE);
    expect(text()).toContain('تطبيق تجريبي للدخول الموحد');
    http.expectOne(`${BASE}/complete`).flush({ redirectTo: RESUME });
    await settle();
  });

  it('signed out: goes to /login with returnUrl=/sso/<uid> (replacing this history entry)', async () => {
    await open(null);
    http.expectNone(`${BASE}/complete`);
    expect(decodeURIComponent(router.url)).toBe(`/login?returnUrl=/sso/${UID}`);
  });

  it("signed out: the app's ui_locales sets the sign-in language unless this device has a chosen one", async () => {
    const languages = TestBed.inject(LanguageService);
    // the precondition is "no language chosen on this device": never inherit one stored by another spec
    localStorage.clear();
    await open(null, details({ uiLocales: ['ar', 'fr'] }));
    expect(languages.current()).toBe('ar');
    expect(languages.hasStoredChoice()).toBe(false);
    expect(decodeURIComponent(router.url)).toBe(`/login?returnUrl=/sso/${UID}`);
    languages.use('fr');
    try {
      await open(null, details({ uiLocales: ['ar'] }), `/sso/${UID}?again=1`);
      expect(languages.current()).toBe('fr');
    } finally {
      localStorage.clear();
    }
  });

  it('details 404: "expired", a link home, no button back to an unknown app', async () => {
    await harness.navigateByUrl(`/sso/${UID}`);
    await settle();
    http.expectOne(`${BASE}/details`).flush(...problem(404, 'sso-interaction-not-found'));
    await settle();

    expect(el()?.querySelector('[data-problem="expired"]')?.textContent).toContain('Cette demande de connexion a expiré');
    expect(button('home')).not.toBeNull();
    expect(button('back-to-app')).toBeNull();
  });

  it('details 409: "app unavailable"', async () => {
    await harness.navigateByUrl(`/sso/${UID}`);
    await settle();
    http.expectOne(`${BASE}/details`).flush(...problem(409, 'sso-client-unavailable'));
    await settle();
    expect(el()?.querySelector('[data-problem="unavailable"]')?.textContent).toContain('Cette application est désactivée ou inconnue.');
  });

  it('complete 403 sso-not-member: names the app; back to the app = abort + location.assign', async () => {
    await open(ME_FIXTURE);
    http.expectOne(`${BASE}/complete`).flush(...problem(403, 'sso-not-member'));
    await settle();
    expect(text()).toContain('Ce compte n\'a pas accès à « ⁨Démo SSO⁩ ».');
    expect(text()).toContain('Amina Benali');

    button('back-to-app')?.click();
    await settle();
    http.expectOne(`${BASE}/abort`).flush({ redirectTo: RESUME });
    await settle();
    expect(assign).toHaveBeenCalledWith(RESUME);
  });

  it('complete 403 sso-not-member: switch account = logout, then /login back to this request', async () => {
    await open(ME_FIXTURE);
    http.expectOne(`${BASE}/complete`).flush(...problem(403, 'sso-not-member'));
    await settle();

    button('switch-account')?.click();
    await settle();
    http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(TestBed.inject(Session).isAuthenticated()).toBe(false);
    expect(decodeURIComponent(router.url)).toBe(`/login?returnUrl=/sso/${UID}`);
  });

  it('complete 403 account-disabled: the login page wording and a way back', async () => {
    await open(ME_FIXTURE);
    http.expectOne(`${BASE}/complete`).flush(...problem(403, 'account-disabled'));
    await settle();
    expect(text()).toContain('Ce compte est désactivé.');
    expect(button('back-to-app')).not.toBeNull();
    expect(button('switch-account')).toBeNull();
  });

  it('freshLoginRequired: signs out and signs in again automatically (fresh=1 marks the round trip)', async () => {
    await open(ME_FIXTURE, details({ freshLoginRequired: true }));
    http.expectNone(`${BASE}/complete`);
    http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(decodeURIComponent(router.url)).toBe(`/login?returnUrl=/sso/${UID}?fresh=1`);
  });

  it('complete 409 sso-fresh-login-required does the same', async () => {
    await open(ME_FIXTURE);
    http.expectOne(`${BASE}/complete`).flush(...problem(409, 'sso-fresh-login-required'));
    await settle();
    http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(decodeURIComponent(router.url)).toBe(`/login?returnUrl=/sso/${UID}?fresh=1`);
  });

  it('a second "fresh sign-in required" after the round trip stops with a message instead of looping', async () => {
    await open(ME_FIXTURE, details({ freshLoginRequired: true }), `/sso/${UID}?fresh=1`);
    http.expectNone('/api/auth/logout');
    expect(el()?.querySelector('[data-problem="fresh"]')?.textContent).toContain("L'application demande une nouvelle connexion.");
  });

  it('two-step sign-in required but not set up: the enrollment wizard, then back here', async () => {
    await open(ME_MFA_REQUIRED);
    http.expectNone(`${BASE}/complete`);
    expect(decodeURIComponent(router.url)).toBe(`/me/security?enroll=1&returnUrl=/sso/${UID}`);
  });

  it('refuses to follow a redirect that is not the provider', async () => {
    await open(ME_FIXTURE);
    http.expectOne(`${BASE}/complete`).flush({ redirectTo: 'https://evil.example/steal' });
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(el()?.querySelector('[data-problem="generic"]')).not.toBeNull();
  });

  it('isProviderUrl accepts http(s) URLs under /oidc/ only', () => {
    expect(isProviderUrl(RESUME, 'http://localhost:4200/')).toBe(true);
    expect(isProviderUrl('/oidc/auth/x', 'http://localhost:4200/')).toBe(true);
    expect(isProviderUrl('javascript:alert(1)', 'http://localhost:4200/')).toBe(false);
    expect(isProviderUrl('https://x.example/other', 'http://localhost:4200/')).toBe(false);
    expect(isProviderUrl(42, 'http://localhost:4200/')).toBe(false);
  });
});
