import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../../testing/auth-fixtures';
import {
  APP_LOGO,
  BRANDING_SETTINGS_URL,
  COMPANY_LOGO,
  EFFECTIVE_BRANDED,
  MARKUP,
  NO_TEXT,
  SETTINGS_OTHER,
  SETTINGS_OWNER,
} from '../../../../testing/branding-fixtures';
import { installDialogPolyfill } from '../../../../testing/dialog-polyfill';
import { translocoTesting } from '../../../../testing/transloco-testing';
import { Session } from '../../../core/auth/session';
import type { BrandingSettingsView } from '../../../core/branding/branding.models';
import { apiProblemInterceptor } from '../../../core/http/api-problem.interceptor';
import { LanguageService } from '../../../core/i18n/language.service';
import { SETTINGS_ROUTES } from '../settings.routes';

type Level = 'installation' | 'company';

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
  TestBed.tick();
}

const png = (size = 1200, name = 'logo.png') => new File([new Uint8Array(size)], name, { type: 'image/png' });

function refuse(req: TestRequest, status: number, slug: string, errors?: { field: string; code: string }[]): void {
  req.flush(
    { type: `urn:hrforce:problem:${slug}`, title: 'x', status, errors: errors?.map((e) => ({ ...e, message: 'server text' })) },
    { status, statusText: 'x' },
  );
}

describe('/settings/branding (docs/contracts/branding.md › Settings section)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function open(view: BrandingSettingsView | null = SETTINGS_OWNER, permissions: readonly string[] = ['settings.branding']): Promise<void> {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'settings', children: SETTINGS_ROUTES }]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/settings/branding');
    await settle();
    const request = http.expectOne(BRANDING_SETTINGS_URL);
    if (view) request.flush(view);
    else request.flush({ type: 'about:blank', title: 'x', status: 500 }, { status: 500, statusText: 'x' });
    await settle();
  }

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const panel = (level: Level) => el().querySelector(`[data-level="${level}"]`) as HTMLElement;
  const control = (level: Level, field: string, lang: string) => el().querySelector(`#${level}-${field}-${lang}`) as HTMLInputElement | HTMLTextAreaElement;
  const errorOf = (level: Level, name: string) => panel(level).querySelector(`[data-error="${name}"]`)?.textContent?.trim() ?? null;
  const counter = (level: Level, name: string) => panel(level).querySelector(`[data-count="${name}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
  const preview = (level: Level) => panel(level).querySelector('[data-preview]') as HTMLElement;
  const previewText = (level: Level, name: string) => preview(level).querySelector(`[data-preview-text="${name}"]`)?.textContent ?? null;
  const swatch = (level: Level, code: string) => panel(level).querySelector(`[data-swatch="${code}"] input`) as HTMLInputElement;
  const button = (level: Level, action: string) => panel(level).querySelector(`[data-action="${action}"]`) as HTMLButtonElement | null;
  const logo = (target: string) => el().querySelector(`[data-logo="${target}"]`) as HTMLElement;

  async function type(level: Level, field: string, lang: string, value: string): Promise<void> {
    const input = control(level, field, lang);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }

  async function save(level: Level): Promise<void> {
    button(level, 'save')?.click();
    await settle();
  }

  async function choose(target: string, file: File): Promise<void> {
    const input = logo(target).querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
  }

  /** The session reload that follows every successful write. */
  function expectSessionReload(permissions: readonly string[] = ['settings.branding']): TestRequest {
    const me = http.expectOne('/api/me');
    me.flush({ ...meWith(permissions), branding: EFFECTIVE_BRANDED });
    return me;
  }

  const dialog = (level: Level) => panel(level).querySelector('dialog') as HTMLDialogElement;
  const section = () => el().querySelector('[data-section="letterhead"]');
  const letterhead = (action: string) => el().querySelector<HTMLButtonElement>(`[data-section="letterhead"] [data-action="${action}"]`);
  const confirm = () => panel('company').querySelector<HTMLButtonElement>('dialog [data-action="confirm"]')?.click();

  describe('tabs', () => {
    it('owning company: « Installation (avant la connexion) » first and selected, then « Cette société »', async () => {
      await open();
      const tabs = [...el().querySelectorAll('[role="tab"]')];
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Installation (avant la connexion)', 'Cette société']);
      expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
      expect((el().querySelector('#branding-panel-installation') as HTMLElement).hidden).toBe(false);
      expect((el().querySelector('#branding-panel-company') as HTMLElement).hidden).toBe(true);
      expect(panel('installation').textContent).toContain('page de connexion et à toute société qui n’a pas défini les siens');

      (tabs[1] as HTMLButtonElement).click();
      await settle();
      expect((el().querySelector('#branding-panel-installation') as HTMLElement).hidden).toBe(true);
      expect((el().querySelector('#branding-panel-company') as HTMLElement).hidden).toBe(false);
    });

    it('another company (installation: null): no installation tab, no installation form', async () => {
      await open(SETTINGS_OTHER);
      expect(el().querySelector('[role="tablist"]')).toBeNull();
      expect(el().querySelector('[data-level="installation"]')).toBeNull();
      expect(el().querySelector('[data-form="installation"]')).toBeNull();
      expect(panel('company')).not.toBeNull();
      expect(el().textContent).not.toContain('Installation (avant la connexion)');
    });

    it('what was typed in a tab survives a visit to the other one', async () => {
      await open();
      await type('installation', 'appTitle', 'fr', 'Brouillon');
      (el().querySelector('[data-tab="company"]') as HTMLButtonElement).click();
      await settle();
      (el().querySelector('[data-tab="installation"]') as HTMLButtonElement).click();
      await settle();
      expect(control('installation', 'appTitle', 'fr').value).toBe('Brouillon');
    });

    it('a failed load offers a retry', async () => {
      await open(null);
      expect(el().querySelector('[data-error="load"]')?.textContent).toContain('Impossible de charger');
      expect(el().querySelector('app-branding-form')).toBeNull();
      (el().querySelector('[data-error="load"] button') as HTMLButtonElement).click();
      await settle();
      http.expectOne(BRANDING_SETTINGS_URL).flush(SETTINGS_OTHER);
      await settle();
      expect(panel('company')).not.toBeNull();
    });
  });

  describe('text fields', () => {
    it('one input per language with the stored value, direction and language; textareas for the two messages', async () => {
      await open();
      expect(control('installation', 'appTitle', 'fr').value).toBe('Portail RH');
      const arabic = control('installation', 'appTitle', 'ar');
      expect(arabic.value).toBe('بوابة الموارد البشرية');
      expect(arabic.getAttribute('dir')).toBe('rtl');
      expect(arabic.getAttribute('lang')).toBe('ar');
      expect(control('installation', 'appTitle', 'en').getAttribute('dir')).toBe('ltr');
      expect(control('installation', 'appTitle', 'fr').tagName).toBe('INPUT');
      expect(control('installation', 'signInMessage', 'fr').tagName).toBe('TEXTAREA');
      expect(control('company', 'welcomeMessage', 'fr').tagName).toBe('TEXTAREA');
      // Each level only has its own fields.
      expect(el().querySelector('#installation-welcomeTitle-fr')).toBeNull();
      expect(el().querySelector('#company-signInMessage-fr')).toBeNull();
    });

    it('counters against the limits, updated while typing (code points of the cleaned text)', async () => {
      await open();
      expect(counter('installation', 'appTitle.fr')).toBe('Caractères utilisés : 10 / 40');
      expect(counter('installation', 'signInMessage.ar')).toBe('Caractères utilisés : 0 / 500');
      expect(counter('installation', 'footer.fr')).toContain('/ 200');
      expect(counter('company', 'welcomeTitle.fr')).toContain('0 / 80');

      await type('installation', 'appTitle', 'fr', '  Mon   portail  ');
      expect(counter('installation', 'appTitle.fr')).toContain('11 / 40');
    });

    it('over the limit: the error under the input, the counter flagged, and no request on save', async () => {
      await open();
      await type('installation', 'appTitle', 'fr', 'x'.repeat(41));
      expect(errorOf('installation', 'appTitle.fr')).toBe('Texte trop long : 40 caractères au plus.');
      expect(control('installation', 'appTitle', 'fr').getAttribute('aria-invalid')).toBe('true');
      expect(panel('installation').querySelector('[data-count="appTitle.fr"]')?.classList.contains('over')).toBe(true);

      await save('installation');
      http.expectNone('/api/branding/installation');
      expect(errorOf('installation', 'form')).toBe('Corrigez les champs signalés avant d’enregistrer.');
    });

    it('French is required as soon as another language is filled', async () => {
      await open();
      await type('company', 'welcomeTitle', 'ar', 'مرحبًا');
      expect(errorOf('company', 'welcomeTitle.fr')).toBe('Le texte en français est obligatoire dès qu’une autre langue est renseignée.');
      await save('company');
      http.expectNone('/api/branding/company');

      await type('company', 'welcomeTitle', 'fr', 'Bienvenue');
      expect(errorOf('company', 'welcomeTitle.fr')).toBeNull();
    });

    it('company tab: an empty field shows what it inherits (placeholder per language, « Par défaut : … »)', async () => {
      await open();
      expect(control('company', 'appTitle', 'fr').getAttribute('placeholder')).toBe('Portail RH');
      expect(control('company', 'appTitle', 'ar').getAttribute('placeholder')).toBe('بوابة الموارد البشرية');
      const hint = panel('company').querySelector('[data-inherited="appTitle"]');
      expect(hint?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Par défaut : Portail RH');
      expect(panel('company').querySelector('[data-inherited="footer"]')?.textContent).toContain('support@demo.dz');
      // Welcome texts are the company's only: nothing to inherit.
      expect(panel('company').querySelector('[data-inherited="welcomeTitle"]')).toBeNull();
      // The installation tab inherits nothing.
      expect(panel('installation').querySelector('[data-inherited]')).toBeNull();

      await type('company', 'appTitle', 'fr', 'RH Démo');
      expect(panel('company').querySelector('[data-inherited="appTitle"]')).toBeNull();
    });
  });

  describe('save', () => {
    it('company: PUT with the five keys (cleaned texts, null when empty), then the view and the session are refreshed', async () => {
      await open();
      await type('company', 'appTitle', 'fr', '  RH   Démo ');
      await type('company', 'welcomeTitle', 'fr', 'Bonjour');
      await type('company', 'welcomeTitle', 'ar', 'مرحبًا');
      swatch('company', 'plum').click();
      await settle();
      await save('company');

      const put = http.expectOne('/api/branding/company');
      expect(put.request.method).toBe('PUT');
      expect(put.request.body).toEqual({
        appTitle: { fr: 'RH Démo', ar: null, en: null },
        welcomeTitle: { fr: 'Bonjour', ar: 'مرحبًا', en: null },
        welcomeMessage: SETTINGS_OWNER.company.welcomeMessage,
        footer: NO_TEXT,
        color: 'plum',
      });
      expect(button('company', 'save')?.disabled).toBe(true);
      const saved: BrandingSettingsView = {
        ...SETTINGS_OWNER,
        company: { ...SETTINGS_OWNER.company, appTitle: { fr: 'RH Démo', ar: null, en: null }, welcomeTitle: { fr: 'Bonjour', ar: 'مرحبًا', en: null }, color: 'plum' },
      };
      put.flush(saved);
      await settle();
      expectSessionReload();
      await settle();

      // The shell follows at once: the session now carries the new brand.
      expect(TestBed.inject(Session).branding()).toEqual(EFFECTIVE_BRANDED);
      expect(panel('company').querySelector('[data-state="feedback"]')?.textContent?.trim()).toBe('Identité visuelle enregistrée.');
      expect(panel('company').querySelector('[data-state="feedback"]')?.getAttribute('role')).toBe('status');
      expect(control('company', 'appTitle', 'fr').value).toBe('RH Démo');
      expect(button('company', 'save')?.disabled).toBe(false);
    });

    it('company: « Par défaut (installation) » sends color: null', async () => {
      await open({ ...SETTINGS_OWNER, company: { ...SETTINGS_OWNER.company, color: 'navy' } });
      expect(swatch('company', 'navy').checked).toBe(true);
      swatch('company', 'inherit').click();
      await settle();
      await save('company');
      const put = http.expectOne('/api/branding/company');
      expect(put.request.body.color).toBeNull();
      put.flush(SETTINGS_OWNER);
      await settle();
      expectSessionReload();
    });

    it('installation: PUT with appTitle, signInMessage, footer and a colour', async () => {
      await open();
      await type('installation', 'signInMessage', 'fr', 'Ligne 1\r\nLigne 2');
      swatch('installation', 'green').click();
      await settle();
      await save('installation');

      const put = http.expectOne('/api/branding/installation');
      expect(put.request.method).toBe('PUT');
      expect(put.request.body).toEqual({
        appTitle: SETTINGS_OWNER.installation?.appTitle,
        signInMessage: { fr: 'Ligne 1\nLigne 2', ar: null, en: null },
        footer: SETTINGS_OWNER.installation?.footer,
        color: 'green',
      });
      put.flush(SETTINGS_OWNER);
      await settle();
      expectSessionReload();
    });

    it('422: each error lands on its input, the colour on the palette; nothing is reloaded', async () => {
      await open();
      await save('company');
      refuse(http.expectOne('/api/branding/company'), 422, 'validation', [
        { field: 'appTitle.ar', code: 'too_long' },
        { field: 'footer.fr', code: 'fr_required' },
        { field: 'welcomeMessage.en', code: 'too_many_lines' },
        { field: 'color', code: 'invalid_color' },
      ]);
      await settle();

      expect(errorOf('company', 'appTitle.ar')).toBe('Texte trop long : 40 caractères au plus.');
      expect(errorOf('company', 'footer.fr')).toBe('Le texte en français est obligatoire dès qu’une autre langue est renseignée.');
      expect(errorOf('company', 'welcomeMessage.en')).toBe('Trop de lignes : 6 au plus.');
      expect(errorOf('company', 'color')).toBe('Couleur refusée : choisissez une couleur de la palette.');
      // The server's own message text is never printed.
      expect(panel('company').textContent).not.toContain('server text');
      expect(panel('company').querySelector('[data-error="form"]')?.getAttribute('role')).toBe('alert');
      http.expectNone('/api/me');
    });

    it('403 forbidden-scope: « Cette action demande le droit sur toute la société. »', async () => {
      await open();
      await save('installation');
      refuse(http.expectOne('/api/branding/installation'), 403, 'forbidden-scope');
      await settle();
      expect(errorOf('installation', 'form')).toBe('Cette action demande le droit sur toute la société.');
      // A holder on part of the company may read, not change: from now on the page says so and offers no write.
      expect(el().querySelector('[data-state="read-only"]')?.textContent).toContain('Lecture seule');
      for (const level of ['installation', 'company'] as const) {
        expect(button(level, 'save')?.disabled).toBe(true);
        expect(button(level, 'reset')?.disabled).toBe(true);
      }
      expect((logo('company').querySelector('[data-action="remove-logo"]') as HTMLButtonElement).disabled).toBe(true);
      expect((logo('app').querySelector('input[type="file"]') as HTMLInputElement).disabled).toBe(true);
    });

    it('shows the values the server stored (cleaned), also when nothing changed for the server', async () => {
      await open();
      expect(el().querySelector('[data-state="read-only"]')).toBeNull();
      await type('installation', 'appTitle', 'fr', '  Portail   RH  ');
      await save('installation');
      const put = http.expectOne('/api/branding/installation');
      expect(put.request.body.appTitle.fr).toBe('Portail RH');
      put.flush(SETTINGS_OWNER); // same stored values, updatedAt unchanged
      await settle();
      expectSessionReload();
      await settle();
      expect(control('installation', 'appTitle', 'fr').value).toBe('Portail RH');
    });
  });

  describe('palette and preview', () => {
    it('a labelled radio group: ten named swatches, each drawn through data-brand, the stored one checked', async () => {
      await open();
      const labels = [...panel('installation').querySelectorAll('[data-swatch]')];
      expect(labels.map((label) => label.getAttribute('data-swatch'))).toEqual(['blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate']);
      expect(labels.map((label) => label.querySelector('.chip')?.getAttribute('data-brand'))).toEqual(labels.map((label) => label.getAttribute('data-swatch')));
      expect(labels[0]?.textContent?.trim()).toBe('Bleu HRForce');
      expect(labels[9]?.textContent?.trim()).toBe('Ardoise');
      expect(swatch('installation', 'teal').checked).toBe(true);
      expect(new Set(labels.map((label) => label.querySelector('input')?.getAttribute('name')))).toEqual(new Set(['installation-color']));
      expect(panel('installation').querySelector('[data-field="color"] legend')?.textContent?.trim()).toBe('Couleur principale');
      // No inline style carries a colour.
      expect(panel('installation').querySelector('[data-field="color"] [style]')).toBeNull();

      // The company tab starts with « Par défaut (installation) », showing the inherited colour.
      const first = panel('company').querySelector('[data-swatch]');
      expect(first?.getAttribute('data-swatch')).toBe('inherit');
      expect(first?.textContent).toContain('Par défaut (installation)');
      expect(first?.querySelector('.chip')?.getAttribute('data-brand')).toBe('teal');
      expect(swatch('company', 'inherit').checked).toBe(true);
    });

    it('the preview follows the draft colour (data-brand on the panel) and is hidden from assistive tech, with a caption', async () => {
      await open();
      expect(preview('installation').getAttribute('data-brand')).toBe('teal');
      expect(preview('installation').getAttribute('aria-hidden')).toBe('true');
      expect(panel('installation').querySelector('figcaption')?.textContent?.trim()).toBe('Aperçu avant enregistrement');
      expect(preview('installation').querySelector('[style]')).toBeNull();

      swatch('installation', 'indigo').click();
      await settle();
      expect(preview('installation').getAttribute('data-brand')).toBe('indigo');

      // Company: the inherited colour until one is chosen.
      expect(preview('company').getAttribute('data-brand')).toBe('teal');
      swatch('company', 'brown').click();
      await settle();
      expect(preview('company').getAttribute('data-brand')).toBe('brown');
      swatch('company', 'inherit').click();
      await settle();
      expect(preview('company').getAttribute('data-brand')).toBe('teal');
    });

    it('the preview follows the draft texts in the UI language, with inheritance and built-in fallbacks', async () => {
      await open();
      expect(previewText('installation', 'title')).toBe('Portail RH');
      expect(previewText('installation', 'signInMessage')).toBe('Environnement de démonstration : données fictives.');
      expect(previewText('installation', 'footer')).toBe('Groupe Démo — assistance : support@demo.dz');
      expect(preview('installation').querySelector('.chip img')?.getAttribute('src')).toBe(SETTINGS_OWNER.installation?.appLogo?.url);

      await type('installation', 'appTitle', 'fr', 'Nouveau titre');
      expect(previewText('installation', 'title')).toBe('Nouveau titre');
      await type('installation', 'appTitle', 'fr', '');
      await type('installation', 'appTitle', 'ar', '');
      await type('installation', 'appTitle', 'en', '');
      expect(previewText('installation', 'title')).toBe('HRForce');

      // Company: inherited title and logo, its own welcome message, the built-in welcome title, no sign-in message.
      expect(previewText('company', 'title')).toBe('Portail RH');
      expect(previewText('company', 'welcomeTitle')).toBe('Bienvenue');
      expect(previewText('company', 'welcomeMessage')).toBe('Retrouvez ici vos tâches, vos congés et votre pointage.');
      expect(previewText('company', 'signInMessage')).toBeNull();
      expect(preview('company').querySelector('.chip img')?.getAttribute('src')).toBe(SETTINGS_OWNER.inherited.appLogo?.url);
      await type('company', 'welcomeTitle', 'fr', 'Bonjour à tous');
      expect(previewText('company', 'welcomeTitle')).toBe('Bonjour à tous');

      TestBed.inject(LanguageService).use('ar', { remember: false });
      await settle();
      expect(previewText('company', 'welcomeMessage')).toBe('تجدون هنا المهام والعطل وتسجيل الحضور.');
      expect(previewText('company', 'welcomeTitle')).toBe('Bonjour à tous');
    });

    it('markup typed into every field stays text in the form and in the preview', async () => {
      await open();
      for (const field of ['appTitle', 'signInMessage', 'footer']) await type('installation', field, 'fr', MARKUP);
      for (const field of ['welcomeTitle', 'welcomeMessage']) await type('company', field, 'fr', MARKUP);

      expect(previewText('installation', 'title')).toBe(MARKUP);
      expect(previewText('installation', 'signInMessage')).toBe(MARKUP);
      expect(previewText('installation', 'footer')).toBe(MARKUP);
      expect(previewText('company', 'welcomeTitle')).toBe(MARKUP);
      expect(previewText('company', 'welcomeMessage')).toBe(MARKUP);
      expect(el().querySelector('img[src="x"]')).toBeNull();
      expect(el().querySelector('script')).toBeNull();
    });

    it('stored markup (inherited title, « Par défaut : … ») stays text too', async () => {
      const text = { fr: MARKUP, ar: null, en: null };
      await open({ ...SETTINGS_OWNER, inherited: { ...SETTINGS_OWNER.inherited, appTitle: text, footer: text } });
      expect(panel('company').querySelector('[data-inherited="appTitle"] bdi')?.textContent).toBe(MARKUP);
      expect(control('company', 'appTitle', 'fr').getAttribute('placeholder')).toBe(MARKUP);
      expect(previewText('company', 'title')).toBe(MARKUP);
      expect(el().querySelector('img[src="x"]')).toBeNull();
      expect(el().querySelector('script')).toBeNull();
    });
  });

  describe('logos', () => {
    it('shows the stored logo, the inherited one, or none', async () => {
      await open();
      expect(logo('installation').querySelector('[data-image="current"]')?.getAttribute('src')).toBe(SETTINGS_OWNER.installation?.appLogo?.url);
      expect(logo('app').querySelector('[data-image="inherited"]')?.getAttribute('src')).toBe(SETTINGS_OWNER.inherited.appLogo?.url);
      expect(logo('company').querySelector('[data-image="current"]')?.getAttribute('src')).toBe(COMPANY_LOGO.url);
      expect(logo('app').querySelector('[data-action="remove-logo"]')).toBeNull();
      expect(logo('company').querySelector('[data-action="remove-logo"]')).not.toBeNull();
      const input = logo('app').querySelector('input[type="file"]');
      expect(input?.getAttribute('accept')).toBe('image/png,image/jpeg');
    });

    it('each file input has a page-unique id, so its label names it (the host element does not carry the same id)', async () => {
      await open();
      for (const target of ['installation', 'app', 'company']) {
        const input = logo(target).querySelector('input[type="file"]') as HTMLInputElement;
        expect(el().querySelectorAll(`[id="${input.id}"]`).length).toBe(1);
        expect(logo(target).querySelector('label')?.htmlFor).toBe(input.id);
      }
    });

    it('client pre-checks: an SVG and a file over 256 KB are refused before any request', async () => {
      await open();
      await choose('app', new File(['<svg onload="alert(1)"/>'], 'logo.svg', { type: 'image/svg+xml' }));
      expect(logo('app').querySelector('[data-error="logo"]')?.textContent?.trim()).toBe('PNG ou JPEG uniquement ; le format SVG n’est pas accepté.');
      expect((logo('app').querySelector('[data-action="upload-logo"]') as HTMLButtonElement).disabled).toBe(true);
      expect(logo('app').querySelector('[data-image="pending"]')).toBeNull();

      await choose('app', png(262145));
      expect(logo('app').querySelector('[data-error="logo"]')?.textContent?.trim()).toBe('Image trop lourde : 256 Ko au plus.');
      expect((logo('app').querySelector('[data-action="upload-logo"]') as HTMLButtonElement).disabled).toBe(true);

      // « Annuler » clears the refusal.
      (logo('app').querySelector('[data-action="cancel-logo"]') as HTMLButtonElement).click();
      await settle();
      expect(logo('app').querySelector('[data-error="logo"]')).toBeNull();
    });

    it('a valid file: a data: URL preview (also in the live preview), then the upload refreshes the view and the session', async () => {
      await open();
      await choose('app', png());
      const pending = logo('app').querySelector('[data-image="pending"]') as HTMLImageElement;
      expect(pending.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
      expect(preview('company').querySelector('.chip img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

      (logo('app').querySelector('[data-action="upload-logo"]') as HTMLButtonElement).click();
      await settle();
      const put = http.expectOne('/api/branding/company/logos/app');
      expect(put.request.method).toBe('PUT');
      const body = put.request.body as FormData;
      expect(body.get('file')).toBeInstanceOf(File);
      expect((body.get('file') as File).size).toBe(1200);
      put.flush({ ...SETTINGS_OWNER, company: { ...SETTINGS_OWNER.company, appLogo: APP_LOGO } });
      await settle();
      expectSessionReload();
      await settle();

      expect(logo('app').querySelector('[data-image="current"]')?.getAttribute('src')).toBe(APP_LOGO.url);
      expect(logo('app').querySelector('[data-state="logo-feedback"]')?.textContent?.trim()).toBe('Logo enregistré.');
      expect(preview('company').querySelector('.chip img')?.getAttribute('src')).toBe(APP_LOGO.url);
    });

    it('a logo upload does not throw away the texts being typed', async () => {
      await open();
      await type('company', 'appTitle', 'fr', 'En cours de saisie');
      await choose('company', png());
      (logo('company').querySelector('[data-action="upload-logo"]') as HTMLButtonElement).click();
      await settle();
      http.expectOne('/api/branding/company/logos/company').flush({ ...SETTINGS_OWNER, company: { ...SETTINGS_OWNER.company, companyLogo: { ...COMPANY_LOGO, url: `${COMPANY_LOGO.url}0` } } });
      await settle();
      expectSessionReload();
      await settle();
      expect(control('company', 'appTitle', 'fr').value).toBe('En cours de saisie');
    });

    it.each([
      ['unsupported_type', 'PNG ou JPEG uniquement ; le format SVG n’est pas accepté.'],
      ['too_large', 'Image trop lourde : 256 Ko au plus.'],
      ['dimensions_too_large', 'Image trop grande : 4 000 × 4 000 pixels au plus.'],
      ['required', 'Le fichier est vide ou manquant. Choisissez une image.'],
    ])('server refusal %s is shown under the file input and the file is dropped', async (code, message) => {
      await open();
      await choose('installation', png());
      (logo('installation').querySelector('[data-action="upload-logo"]') as HTMLButtonElement).click();
      await settle();
      const put = http.expectOne('/api/branding/installation/logo');
      expect(put.request.method).toBe('PUT');
      refuse(put, 422, 'validation', [{ field: 'file', code }]);
      await settle();

      expect(logo('installation').querySelector('[data-error="logo"]')?.textContent?.trim()).toBe(message);
      expect(logo('installation').querySelector('[data-image="pending"]')).toBeNull();
      expect((logo('installation').querySelector('[data-action="upload-logo"]') as HTMLButtonElement).disabled).toBe(true);
      http.expectNone('/api/me');
    });

    it('« Supprimer le logo »: DELETE, then the view is read again and the session reloaded', async () => {
      await open();
      (logo('company').querySelector('[data-action="remove-logo"]') as HTMLButtonElement).click();
      await settle();
      const del = http.expectOne('/api/branding/company/logos/company');
      expect(del.request.method).toBe('DELETE');
      del.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      http.expectOne(BRANDING_SETTINGS_URL).flush({ ...SETTINGS_OWNER, company: { ...SETTINGS_OWNER.company, companyLogo: null } });
      expectSessionReload();
      await settle();
      expect(logo('company').querySelector('[data-image="none"]')?.textContent?.trim()).toBe('Aucun logo.');
      expect(logo('company').querySelector('[data-state="logo-feedback"]')?.textContent?.trim()).toBe('Logo supprimé.');
    });
  });

  describe('reset', () => {
    it('asks first; « Annuler » sends nothing', async () => {
      await open();
      button('company', 'reset')?.click();
      await settle();
      expect(dialog('company').hasAttribute('open')).toBe(true);
      expect(dialog('company').textContent).toContain('Réinitialiser l’identité visuelle ?');
      expect(dialog('company').textContent).toContain('La société reprendra les réglages de l’installation.');
      (dialog('company').querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
      await settle();
      expect(dialog('company').hasAttribute('open')).toBe(false);
      http.expectNone('/api/branding/company');
    });

    it('confirmed: DELETE of the tab, the form is emptied, the view and the session are read again', async () => {
      await open();
      await type('company', 'appTitle', 'fr', 'Non enregistré');
      button('company', 'reset')?.click();
      await settle();
      (dialog('company').querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
      await settle();
      const del = http.expectOne('/api/branding/company');
      expect(del.request.method).toBe('DELETE');
      del.flush(null, { status: 204, statusText: 'No Content' });
      await settle();
      http.expectOne(BRANDING_SETTINGS_URL).flush({
        ...SETTINGS_OWNER,
        company: { appTitle: NO_TEXT, welcomeTitle: NO_TEXT, welcomeMessage: NO_TEXT, footer: NO_TEXT, color: null, appLogo: null, companyLogo: null, updatedAt: null },
      });
      expectSessionReload();
      await settle();

      expect(control('company', 'appTitle', 'fr').value).toBe('');
      expect(control('company', 'welcomeMessage', 'fr').value).toBe('');
      expect(logo('company').querySelector('[data-image="none"]')).not.toBeNull();
      expect(panel('company').querySelector('[data-state="feedback"]')?.textContent?.trim()).toBe('Identité visuelle réinitialisée.');
    });

    it('installation: its own DELETE and its own warning', async () => {
      await open();
      button('installation', 'reset')?.click();
      await settle();
      expect(dialog('installation').textContent).toContain('la couleur redeviendra le bleu par défaut');
      (dialog('installation').querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
      await settle();
      const del = http.expectOne('/api/branding/installation');
      expect(del.request.method).toBe('DELETE');
      refuse(del, 404, 'not-found');
      await settle();
      expect(errorOf('installation', 'form')).toBe('Ce réglage n’est pas disponible pour votre société. Rechargez la page.');
      http.expectNone('/api/me');
    });
  });

  describe('letterhead copies (document.configure)', () => {
    it('hidden without document.configure', async () => {
      await open();
      expect(section()).toBeNull();
    });

    it('« Reprendre le logo de l’en-tête des documents »: confirmation, GET the letterhead logo, upload it as the company logo', async () => {
      await open(SETTINGS_OWNER, ['settings.branding', 'document.configure']);
      letterhead('from-letterhead')?.click();
      await settle();
      http.expectNone('/api/documents/settings/profile/logo');
      confirm();
      await settle();
      const get = http.expectOne('/api/documents/settings/profile/logo');
      expect(get.request.method).toBe('GET');
      expect(get.request.responseType).toBe('blob');
      get.flush(new Blob([new Uint8Array(64)], { type: 'image/png' }));
      await settle();
      const put = http.expectOne('/api/branding/company/logos/company');
      expect(put.request.method).toBe('PUT');
      expect(((put.request.body as FormData).get('file') as File).size).toBe(64);
      put.flush(SETTINGS_OWNER);
      await settle();
      expectSessionReload(['settings.branding', 'document.configure']);
      await settle();
      expect(section()?.querySelector('[data-state="letterhead"]')?.textContent?.trim()).toBe('Logo de l’en-tête repris comme logo de la société.');
    });

    it('no letterhead logo (404): says so', async () => {
      await open(SETTINGS_OWNER, ['settings.branding', 'document.configure']);
      letterhead('from-letterhead')?.click();
      await settle();
      confirm();
      await settle();
      http.expectOne('/api/documents/settings/profile/logo').flush(new Blob(), { status: 404, statusText: 'Not Found' });
      await settle();
      expect(section()?.querySelector('[data-state="letterhead"]')?.textContent?.trim()).toBe('L’en-tête des documents n’a pas de logo.');
      expect(section()?.querySelector('[data-state="letterhead"]')?.getAttribute('role')).toBe('alert');
      http.expectNone('/api/branding/company/logos/company');
    });

    it('« Utiliser ce logo pour l’en-tête des documents »: GET the company logo by the API’s URL, PUT it on the letterhead', async () => {
      await open(SETTINGS_OWNER, ['settings.branding', 'document.configure']);
      letterhead('to-letterhead')?.click();
      await settle();
      confirm();
      await settle();
      const get = http.expectOne(COMPANY_LOGO.url);
      expect(get.request.responseType).toBe('blob');
      get.flush(new Blob([new Uint8Array(32)], { type: 'image/jpeg' }));
      await settle();
      const put = http.expectOne('/api/documents/settings/profile/logo');
      expect(put.request.method).toBe('PUT');
      expect(((put.request.body as FormData).get('file') as File).size).toBe(32);
      put.flush({});
      await settle();
      expect(section()?.querySelector('[data-state="letterhead"]')?.textContent?.trim()).toBe('Logo de la société copié vers l’en-tête des documents.');
      // The branding itself did not change: nothing to reload.
      http.expectNone('/api/me');
    });

    it('without a company logo there is nothing to copy to the letterhead', async () => {
      await open({ ...SETTINGS_OWNER, company: { ...SETTINGS_OWNER.company, companyLogo: null } }, ['settings.branding', 'document.configure']);
      expect(letterhead('from-letterhead')).not.toBeNull();
      expect(letterhead('to-letterhead')).toBeNull();
    });
  });

  describe('route and nav', () => {
    it('the tab bar shows « Notifications » and « Identité visuelle », the second one current', async () => {
      await open();
      const tabs = [...el().querySelectorAll('.settings-nav a')];
      expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Notifications', 'Identité visuelle']);
      expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual(['/settings', '/settings/branding']);
      expect(tabs[1]?.getAttribute('aria-current')).toBe('page');
      expect(tabs[0]?.getAttribute('aria-current')).toBeNull();
      expect(el().querySelector('h1')?.textContent?.trim()).toBe('Paramètres');
      expect(el().querySelector('h2')?.textContent?.trim()).toBe('Identité visuelle');
    });

    it('without settings.branding: the 404 page, the URL kept, and nothing asked from the API', async () => {
      await TestBed.configureTestingModule({
        imports: [translocoTesting()],
        providers: [provideRouter([{ path: 'settings', children: SETTINGS_ROUTES }]), provideHttpClient(), provideHttpClientTesting()],
      }).compileComponents();
      http = TestBed.inject(HttpTestingController);
      TestBed.inject(Session).set(meWith(['access.manage_roles', 'document.configure']));
      harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/settings/branding');
      await settle();

      expect(TestBed.inject(Router).url).toBe('/settings/branding');
      expect(el().querySelector('h1')?.textContent?.trim()).toBe('404');
      expect(el().querySelector('app-branding-form')).toBeNull();
      http.expectNone(BRANDING_SETTINGS_URL);
    });
  });
});
