import { DOCUMENT } from '@angular/common';
import { Injectable, inject, signal } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import {
  APP_LANGUAGES,
  type AppLanguage,
  DEFAULT_LANGUAGE,
  directionOf,
  isAppLanguage,
} from './languages';

export const LANGUAGE_STORAGE_KEY = 'hrforce.lang';

/**
 * Owns the active UI language: Transloco's active lang, `<html lang dir>`,
 * and the persisted choice (localStorage, best effort).
 *
 * Two sources of a language, in priority order:
 * 1. a choice the person made on THIS device with the language switcher (stored in localStorage);
 * 2. the signed-in account's `locale` (docs/contracts/identity.md › Web), applied after login and on reload
 *    through `applyAccountLocale()` — but NOT stored, so it never masquerades as a device choice (a second
 *    person signing in on the same computer still gets their own account language).
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly transloco = inject(TranslocoService);
  private readonly document = inject(DOCUMENT);

  private readonly currentLang = signal<AppLanguage>(DEFAULT_LANGUAGE);

  readonly available: readonly AppLanguage[] = APP_LANGUAGES;
  readonly current = this.currentLang.asReadonly();

  /** Restores the persisted language (or the default) and waits for its translations. */
  async init(): Promise<void> {
    const lang = this.readStored() ?? DEFAULT_LANGUAGE;
    // Not remembered: falling back to the default is not a choice (see hasStoredChoice()).
    this.use(lang, { remember: false });
    try {
      await firstValueFrom(this.transloco.load(lang));
    } catch {
      // Missing translation file: Transloco falls back to `fr`; do not block bootstrap.
    }
  }

  /** Switches the UI language. `remember: false` applies it for this page load only (nothing stored). */
  use(lang: AppLanguage, options: { remember?: boolean } = {}): void {
    this.transloco.setActiveLang(lang);
    const root = this.document.documentElement;
    root.lang = lang;
    root.dir = directionOf(lang);
    this.currentLang.set(lang);
    if (options.remember ?? true) {
      this.persist(lang);
    }
  }

  /** True when someone picked a language on this device (a valid value is stored). */
  hasStoredChoice(): boolean {
    return this.readStored() !== null;
  }

  /**
   * Applies the signed-in account's locale unless this device already has a stored choice.
   * Unknown values (not fr/ar/en) are ignored. Returns whether the language was applied.
   */
  applyAccountLocale(locale: string): boolean {
    if (this.hasStoredChoice() || !isAppLanguage(locale)) {
      return false;
    }
    this.use(locale, { remember: false });
    return true;
  }

  /**
   * Applies the first language of `hints` that the app speaks — the `ui_locales` of an app sending someone to sign in
   * through HRForce (docs/contracts/sso.md) — unless this device has a stored choice. Not stored, like the account
   * locale (which replaces it after sign-in). Returns whether a language was applied.
   */
  applyLanguageHint(hints: readonly string[]): boolean {
    const lang = hints.find(isAppLanguage);
    if (this.hasStoredChoice() || lang === undefined) {
      return false;
    }
    this.use(lang, { remember: false });
    return true;
  }

  private readStored(): AppLanguage | null {
    try {
      const value = this.document.defaultView?.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      return isAppLanguage(value) ? value : null;
    } catch {
      return null;
    }
  }

  private persist(lang: AppLanguage): void {
    try {
      this.document.defaultView?.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch {
      // Storage unavailable (private mode, blocked cookies): the choice lasts for this session only.
    }
  }
}
