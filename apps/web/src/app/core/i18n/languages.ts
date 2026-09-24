export const APP_LANGUAGES = ['fr', 'ar', 'en'] as const;

export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = 'fr';

export const RTL_LANGUAGES: ReadonlySet<AppLanguage> = new Set<AppLanguage>(['ar']);

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (APP_LANGUAGES as readonly string[]).includes(value);
}

export function directionOf(lang: AppLanguage): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';
}
