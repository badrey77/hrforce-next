import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  type ApplicationConfig,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideTransloco } from '@jsverse/transloco';
import { routes } from './app.routes';
import { initializeSession } from './core/auth/session-init';
import { appHttpFeatures } from './core/http/http-features';
import { LanguageService } from './core/i18n/language.service';
import { APP_LANGUAGES, DEFAULT_LANGUAGE } from './core/i18n/languages';
import { TranslocoHttpLoader } from './core/i18n/transloco-http-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    // fetch() transport + XSRF + interceptors [mfaEnrollment, apiProblem, authRefresh] (order = nesting, the first is
    // the outermost: see core/http/http-features.ts). Uploads with a progress bar use a second client built from the
    // same features over XMLHttpRequest (core/http/upload-http.ts).
    provideHttpClient(withFetch(), ...appHttpFeatures()),
    provideTransloco({
      config: {
        availableLangs: [...APP_LANGUAGES],
        defaultLang: DEFAULT_LANGUAGE,
        fallbackLang: DEFAULT_LANGUAGE,
        missingHandler: { useFallbackTranslation: true, logMissingKey: isDevMode() },
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
      },
      loader: TranslocoHttpLoader,
    }),
    // App initializers run in parallel and bootstrap waits for all of them (see core/auth/session-init.ts).
    provideAppInitializer(() => inject(LanguageService).init()),
    // csrf THEN /api/me, before the first navigation, so the guards know who is signed in.
    provideAppInitializer(initializeSession),
  ],
};
