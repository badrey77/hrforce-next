import {
  provideHttpClient,
  withFetch,
  withInterceptors,
  withXsrfConfiguration,
} from '@angular/common/http';
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
import { authRefreshInterceptor } from './core/auth/auth-refresh.interceptor';
import { initializeSession } from './core/auth/session-init';
import { apiProblemInterceptor } from './core/http/api-problem.interceptor';
import { XSRF_COOKIE_NAME, XSRF_HEADER_NAME } from './core/http/xsrf';
import { LanguageService } from './core/i18n/language.service';
import { APP_LANGUAGES, DEFAULT_LANGUAGE } from './core/i18n/languages';
import { TranslocoHttpLoader } from './core/i18n/transloco-http-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(
      withFetch(),
      withXsrfConfiguration({ cookieName: XSRF_COOKIE_NAME, headerName: XSRF_HEADER_NAME }),
      // Order = nesting: the FIRST is the outermost. apiProblemInterceptor wraps the refresh logic, so callers
      // always get an ApiProblemError, retry or not (see core/auth/auth-refresh.interceptor.ts).
      withInterceptors([apiProblemInterceptor, authRefreshInterceptor]),
    ),
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
