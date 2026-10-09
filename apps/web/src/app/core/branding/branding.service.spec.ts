import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { BRANDING_DEFAULT_URL, EFFECTIVE_BRANDED, PUBLIC_BRANDED, PUBLIC_UNSET } from '../../../testing/branding-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import type { Me } from '../auth/auth.models';
import { Session } from '../auth/session';
import { LanguageService } from '../i18n/language.service';
import { BRAND_STORAGE_KEY, BRANDING_START_LIMIT_MS, BrandingService, TITLE_STORAGE_KEY } from './branding.service';

const ME_BRANDED: Me = { ...ME_FIXTURE, branding: EFFECTIVE_BRANDED };
const root = () => document.documentElement;
const themeColor = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;

/** The palette rules of styles.css that these tests rely on (the real file is not loaded in unit tests). */
const PALETTE_CSS = `
  :root { --color-primary: #1f4e79; }
  [data-brand='teal'] { --color-primary: #0b6470; }
  [data-brand='plum'] { --color-primary: #6d2c6b; }
`;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('BrandingService (docs/contracts/branding.md › Web › State)', () => {
  let http: HttpTestingController;
  let style: HTMLStyleElement;

  function setup(): BrandingService {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    return TestBed.inject(BrandingService);
  }

  beforeEach(() => {
    localStorage.clear();
    style = document.createElement('style');
    style.textContent = PALETTE_CSS;
    document.head.append(style);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    http.verify();
    style.remove();
    document.querySelector('meta[name="theme-color"]')?.remove();
    root().removeAttribute('data-brand');
    root().lang = 'fr';
    root().dir = 'ltr';
    document.title = '';
    localStorage.clear();
  });

  describe('start-up, signed out', () => {
    it('waits for the public default and shows it: title, colour, logo, footer, sign-in message', async () => {
      const branding = setup();
      const started = branding.init();
      http.expectOne(BRANDING_DEFAULT_URL).flush(PUBLIC_BRANDED);
      await started;
      TestBed.tick();

      expect(branding.titleText()).toBe('Portail RH');
      expect(branding.title()).toEqual({ text: 'Portail RH', lang: 'fr' });
      expect(branding.color()).toBe('teal');
      expect(branding.appLogo()).toEqual(PUBLIC_BRANDED.appLogo);
      expect(branding.footer()?.text).toBe('Groupe Démo — assistance : support@demo.dz');
      expect(branding.signInMessage()?.text).toBe('Environnement de démonstration : données fictives.');
      // Not part of the installation default.
      expect(branding.welcomeTitle()).toBeNull();
      expect(branding.welcomeMessage()).toBeNull();
      expect(branding.companyLogo()).toBeNull();
    });

    it('nothing set: the built-in title and the default colour; no footer, no sign-in message', async () => {
      const branding = setup();
      const started = branding.init();
      http.expectOne(BRANDING_DEFAULT_URL).flush(PUBLIC_UNSET);
      await started;
      TestBed.tick();

      expect(branding.title()).toBeNull();
      expect(branding.titleText()).toBe('HRForce');
      expect(branding.color()).toBe('blue');
      expect(branding.footer()).toBeNull();
      expect(branding.signInMessage()).toBeNull();
      expect(document.title).toBe('HRForce');
    });

    it('a failed request falls back to what this device cached, without rejecting', async () => {
      localStorage.setItem(BRAND_STORAGE_KEY, 'plum');
      localStorage.setItem(TITLE_STORAGE_KEY, 'RH Groupe Démo');
      const branding = setup();
      const started = branding.init();
      http.expectOne(BRANDING_DEFAULT_URL).error(new ProgressEvent('error'), { status: 0, statusText: '' });
      await expect(started).resolves.toBeUndefined();
      TestBed.tick();

      expect(branding.color()).toBe('plum');
      expect(branding.titleText()).toBe('RH Groupe Démo');
      expect(root().getAttribute('data-brand')).toBe('plum');
      expect(document.title).toBe('RH Groupe Démo');
    });

    it('a failed request with nothing cached (or a cache that is not a palette code) shows the built-in brand', async () => {
      localStorage.setItem(BRAND_STORAGE_KEY, 'red;}body{display:none');
      localStorage.setItem(TITLE_STORAGE_KEY, 'x'.repeat(41));
      const branding = setup();
      const started = branding.init();
      http.expectOne(BRANDING_DEFAULT_URL).flush(null, { status: 503, statusText: 'Service Unavailable' });
      await started;
      TestBed.tick();

      expect(branding.color()).toBe('blue');
      expect(branding.titleText()).toBe('HRForce');
      expect(root().getAttribute('data-brand')).toBe('blue');
    });

    it(`stops waiting after ${BRANDING_START_LIMIT_MS} ms (cached brand first); a late answer still applies`, async () => {
      localStorage.setItem(BRAND_STORAGE_KEY, 'plum');
      const branding = setup();
      vi.useFakeTimers();
      let finished = false;
      const started = branding.init().then(() => (finished = true));
      const pending = http.expectOne(BRANDING_DEFAULT_URL);

      await vi.advanceTimersByTimeAsync(BRANDING_START_LIMIT_MS - 1);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await started;
      expect(finished).toBe(true);
      expect(branding.color()).toBe('plum');

      pending.flush(PUBLIC_BRANDED);
      expect(branding.color()).toBe('teal');
      expect(branding.titleText()).toBe('Portail RH');
    });
  });

  describe('following the session', () => {
    it('signed in at start-up: me.branding, and the public default is not requested', async () => {
      const branding = setup();
      TestBed.inject(Session).set(ME_BRANDED);
      await branding.init();
      http.expectNone(BRANDING_DEFAULT_URL);

      expect(branding.effective()).toEqual(EFFECTIVE_BRANDED);
      expect(branding.titleText()).toBe('RH Groupe Démo');
      expect(branding.color()).toBe('plum');
      expect(branding.companyLogo()).toEqual(EFFECTIVE_BRANDED.companyLogo);
      expect(branding.welcomeTitle()?.text).toBe('Bonjour et bienvenue');
      expect(branding.signInMessage()).toBeNull();
    });

    it('sign-in switches to the company; sign-out goes back to the default and reads it again', async () => {
      const branding = setup();
      const session = TestBed.inject(Session);
      const started = branding.init();
      http.expectOne(BRANDING_DEFAULT_URL).flush(PUBLIC_BRANDED);
      await started;
      TestBed.tick();
      expect(branding.color()).toBe('teal');

      session.set(ME_BRANDED);
      TestBed.tick();
      expect(branding.color()).toBe('plum');
      expect(branding.titleText()).toBe('RH Groupe Démo');
      expect(branding.signInMessage()).toBeNull();
      http.expectNone(BRANDING_DEFAULT_URL);

      session.clear();
      TestBed.tick();
      // At once: the default already known; then the fresh one.
      expect(branding.color()).toBe('teal');
      expect(branding.titleText()).toBe('Portail RH');
      http.expectOne(BRANDING_DEFAULT_URL).flush({ ...PUBLIC_BRANDED, color: 'olive' });
      await flushPromises();
      expect(branding.color()).toBe('olive');
      expect(branding.signInMessage()?.text).toContain('démonstration');
    });

    it('a /me without branding (older API) is the built-in brand', () => {
      const branding = setup();
      TestBed.inject(Session).set(ME_FIXTURE);
      TestBed.tick();
      expect(branding.titleText()).toBe('HRForce');
      expect(branding.color()).toBe('blue');
      expect(branding.footer()).toBeNull();
    });
  });

  describe('language', () => {
    it('re-resolves when the language changes: active → fr → built-in, with the language of the text', () => {
      const branding = setup();
      const language = TestBed.inject(LanguageService);
      TestBed.inject(Session).set(ME_BRANDED);
      TestBed.tick();

      language.use('ar', { remember: false });
      TestBed.tick();
      expect(branding.title()).toEqual({ text: 'الموارد البشرية', lang: 'ar' });
      expect(branding.langAttr(branding.title())).toBeNull();
      // No Arabic footer: the French one, marked as French.
      expect(branding.footer()).toEqual({ text: 'Groupe Démo — assistance : support@demo.dz', lang: 'fr' });
      expect(branding.langAttr(branding.footer())).toBe('fr');
      expect(document.title).toBe('الموارد البشرية');

      language.use('en', { remember: false });
      TestBed.tick();
      expect(branding.titleText()).toBe('Demo Group HR');
      expect(branding.welcomeTitle()).toEqual({ text: 'Bonjour et bienvenue', lang: 'fr' });

      language.use('fr', { remember: false });
      TestBed.tick();
      expect(branding.langAttr(branding.footer())).toBeNull();
    });
  });

  describe('effects on the document', () => {
    it('sets data-brand, the tab title, theme-color from the computed CSS variable, and both storage keys', () => {
      setup();
      TestBed.inject(Session).set(ME_BRANDED);
      TestBed.tick();

      expect(root().getAttribute('data-brand')).toBe('plum');
      expect(document.title).toBe('RH Groupe Démo');
      expect(themeColor()).toBe('#6d2c6b');
      expect(localStorage.getItem(BRAND_STORAGE_KEY)).toBe('plum');
      expect(localStorage.getItem(TITLE_STORAGE_KEY)).toBe('RH Groupe Démo');

      TestBed.inject(Session).set({ ...ME_FIXTURE, branding: { ...EFFECTIVE_BRANDED, color: 'teal', appTitle: { fr: null, ar: null, en: null } } });
      TestBed.tick();
      expect(root().getAttribute('data-brand')).toBe('teal');
      expect(themeColor()).toBe('#0b6470');
      expect(document.title).toBe('HRForce');
      expect(localStorage.getItem(BRAND_STORAGE_KEY)).toBe('teal');
      expect(localStorage.getItem(TITLE_STORAGE_KEY)).toBe('HRForce');
    });

    it('a title made of markup is set as text: the tab title holds the characters, the page gains no element', () => {
      setup();
      const title = '<img src=x onerror=alert(1)>';
      TestBed.inject(Session).set({ ...ME_FIXTURE, branding: { ...EFFECTIVE_BRANDED, appTitle: { fr: title, ar: null, en: null } } });
      TestBed.tick();
      expect(document.title).toBe(title);
      expect(document.querySelector('img[src="x"]')).toBeNull();
    });

    it('blocked storage does not throw: the brand is applied all the same', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('blocked', 'SecurityError');
      });
      const branding = setup();
      TestBed.inject(Session).set(ME_BRANDED);
      expect(() => TestBed.tick()).not.toThrow();
      expect(branding.color()).toBe('plum');
      expect(root().getAttribute('data-brand')).toBe('plum');
      expect(document.title).toBe('RH Groupe Démo');
    });
  });
});
