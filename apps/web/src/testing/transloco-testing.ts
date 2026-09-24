import { TranslocoTestingModule, type TranslocoTestingOptions } from '@jsverse/transloco';
import ar from '../../public/i18n/ar.json';
import en from '../../public/i18n/en.json';
import fr from '../../public/i18n/fr.json';
import { APP_LANGUAGES, DEFAULT_LANGUAGE } from '../app/core/i18n/languages';

/** Transloco with the real translation files, loaded synchronously, for unit tests. */
export function translocoTesting(options: TranslocoTestingOptions = {}) {
  return TranslocoTestingModule.forRoot({
    langs: { fr, ar, en },
    translocoConfig: {
      availableLangs: [...APP_LANGUAGES],
      defaultLang: DEFAULT_LANGUAGE,
      fallbackLang: DEFAULT_LANGUAGE,
      reRenderOnLangChange: true,
    },
    preloadLangs: true,
    ...options,
  });
}
