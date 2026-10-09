/**
 * BrandingService — which title, texts, logos and brand colour the app shows (docs/contracts/branding.md › Web).
 *
 * One rule: signed in → the session's company (`me.branding`, levels already resolved by the API); signed out → the
 * public installation default. The language is resolved here (active → fr → the app's own i18n text).
 *
 * This service is the only place that touches the document for branding: `<html data-brand>` (styles.css maps the
 * code to a colour), the tab title, `<meta name="theme-color">` and the device cache read by `public/lang-boot.js`
 * before Angular starts. No hex value exists in TypeScript: the theme colour is read back from the computed CSS.
 */
import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { TranslocoService } from '@jsverse/transloco';
import { Session } from '../auth/session';
import { LanguageService } from '../i18n/language.service';
import type { AppLanguage } from '../i18n/languages';
import { BrandingApi } from './branding-api';
import {
  BUILT_IN_BRANDING,
  type BrandColor,
  type EffectiveBranding,
  effectiveOf,
  effectiveOfPublic,
  isBrandColor,
  type LogoRef,
  type PublicBranding,
  type ResolvedText,
  resolve,
} from './branding.models';

export const BRAND_STORAGE_KEY = 'hrforce.brand';
export const TITLE_STORAGE_KEY = 'hrforce.title';
/** How long start-up waits for the public default before painting with the cached (or built-in) brand. */
export const BRANDING_START_LIMIT_MS = 1500;
/** Same limit as the API's app title and as `lang-boot.js`, in code points. */
const CACHED_TITLE_MAX = 40;
/** Used only until the translations are loaded; `app.title` is the real built-in title. */
const BUILT_IN_TITLE = 'HRForce';

@Injectable({ providedIn: 'root' })
export class BrandingService {
  private readonly api = inject(BrandingApi);
  private readonly session = inject(Session);
  private readonly language = inject(LanguageService);
  private readonly document = inject(DOCUMENT);
  private readonly tabTitle = inject(Title);
  private readonly meta = inject(Meta);

  private readonly publicDefault = signal<PublicBranding | null>(null);
  /** What the device remembered from the last visit; used only while nothing could be loaded. */
  private readonly cached = this.readCache();
  private readonly builtInTitle = toSignal(inject(TranslocoService).selectTranslate<string>('app.title'), { initialValue: BUILT_IN_TITLE });
  private readonly loaded = computed(() => this.session.isAuthenticated() || this.publicDefault() !== null);
  private wasSignedIn = false;

  readonly effective = computed<EffectiveBranding>(() => {
    if (this.session.isAuthenticated()) return effectiveOf(this.session.branding());
    const fallback = this.publicDefault();
    return fallback ? effectiveOfPublic(fallback) : BUILT_IN_BRANDING;
  });

  readonly color = computed<BrandColor>(() => (this.loaded() ? this.effective().color : (this.cached.color ?? this.effective().color)));
  readonly appLogo = computed<LogoRef | null>(() => this.effective().appLogo);
  readonly companyLogo = computed<LogoRef | null>(() => this.effective().companyLogo);

  /** The custom app title, or `null` when the built-in one applies. */
  readonly title = computed(() => this.resolved(this.effective().appTitle));
  /** The title to print: custom, else (nothing loaded) the one cached on this device, else the built-in `app.title`. */
  readonly titleText = computed(() => this.title()?.text ?? ((!this.loaded() && this.cached.title) || this.builtInTitle() || BUILT_IN_TITLE));
  readonly welcomeTitle = computed(() => this.resolved(this.effective().welcomeTitle));
  readonly welcomeMessage = computed(() => this.resolved(this.effective().welcomeMessage));
  readonly footer = computed(() => this.resolved(this.effective().footer));
  /** Only before sign-in (it belongs to the installation default). */
  readonly signInMessage = computed(() => (this.session.isAuthenticated() ? null : this.resolved(this.publicDefault()?.signInMessage)));

  constructor() {
    effect(() => {
      const color = this.color();
      untracked(() => this.applyColor(color));
    });
    effect(() => {
      const title = this.titleText();
      untracked(() => {
        this.tabTitle.setTitle(title);
        this.store(TITLE_STORAGE_KEY, title);
      });
    });
    // Follows the session: after a sign-out (or a failed refresh) the public default is read again.
    effect(() => {
      const signedIn = this.session.isAuthenticated();
      untracked(() => {
        if (this.wasSignedIn && !signedIn) void this.loadDefault();
        this.wasSignedIn = signedIn;
      });
    });
  }

  /**
   * Start-up step, awaited by the app initializer after `session.load()`: signed out → the public default, waited for
   * at most `limitMs` (then the cached or built-in brand shows, and a late answer still applies). Never rejects.
   */
  init(limitMs: number = BRANDING_START_LIMIT_MS): Promise<void> {
    return this.session.isAuthenticated() ? Promise.resolve() : this.loadDefault(limitMs);
  }

  /** `GET /api/branding/default`. Resolves when it answered, failed, or `limitMs` passed. */
  loadDefault(limitMs?: number): Promise<void> {
    return new Promise((resolveWait) => {
      const timer = limitMs === undefined ? undefined : setTimeout(resolveWait, limitMs);
      const done = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolveWait();
      };
      this.api.publicDefault().subscribe({
        next: (value) => {
          this.publicDefault.set(value);
          done();
        },
        error: done,
      });
    });
  }

  /** The `lang` attribute a branded text needs: its language when it differs from the UI language, else none. */
  langAttr(text: ResolvedText | null): AppLanguage | null {
    return text && text.lang !== this.language.current() ? text.lang : null;
  }

  private resolved(text: EffectiveBranding['appTitle'] | null | undefined): ResolvedText | null {
    return resolve(text, this.language.current());
  }

  private applyColor(color: BrandColor): void {
    const root = this.document.documentElement;
    root.setAttribute('data-brand', color);
    this.store(BRAND_STORAGE_KEY, color);
    // The colour itself comes from styles.css: read what `[data-brand]` resolved to.
    const primary = this.document.defaultView?.getComputedStyle(root).getPropertyValue('--color-primary').trim();
    if (primary) this.meta.updateTag({ name: 'theme-color', content: primary });
  }

  private readCache(): { readonly color: BrandColor | null; readonly title: string | null } {
    try {
      const storage = this.document.defaultView?.localStorage;
      const color = storage?.getItem(BRAND_STORAGE_KEY);
      const title = storage?.getItem(TITLE_STORAGE_KEY);
      return {
        color: isBrandColor(color) ? color : null,
        title: typeof title === 'string' && title.length >= 1 && [...title].length <= CACHED_TITLE_MAX ? title : null,
      };
    } catch {
      return { color: null, title: null };
    }
  }

  private store(key: string, value: string): void {
    try {
      this.document.defaultView?.localStorage.setItem(key, value);
    } catch {
      // Storage blocked: the next visit starts with the built-in brand until the API answers.
    }
  }
}
