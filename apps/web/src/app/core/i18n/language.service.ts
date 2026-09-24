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
    this.use(lang);
    try {
      await firstValueFrom(this.transloco.load(lang));
    } catch {
      // Missing translation file: Transloco falls back to `fr`; do not block bootstrap.
    }
  }

  use(lang: AppLanguage): void {
    this.transloco.setActiveLang(lang);
    const root = this.document.documentElement;
    root.lang = lang;
    root.dir = directionOf(lang);
    this.currentLang.set(lang);
    this.persist(lang);
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
