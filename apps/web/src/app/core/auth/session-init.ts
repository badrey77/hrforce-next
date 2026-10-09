/**
 * Startup: `GET /api/auth/csrf`, THEN `GET /api/me` (docs/contracts/identity.md › Web).
 *
 * Angular concepts:
 * - **App initializers.** `provideAppInitializer(fn)` (app.config.ts) registers a function Angular runs while
 *   bootstrapping, in an injection context (so `inject()` works in it). If it returns a Promise or Observable,
 *   Angular WAITS for it before creating the root component and before the router's first navigation. That is
 *   what lets the guards trust `Session.isAuthenticated()` on the very first URL: without it, a reload of
 *   `/organization` would be judged "signed out" before `/api/me` answered and bounce to /login.
 * - **Several initializers run in parallel.** Angular starts every registered initializer and waits for all of
 *   them; it does NOT chain them. Ordering between two steps (csrf before me) therefore has to live INSIDE one
 *   initializer, as the two `await`s below. The language initializer runs alongside, independently.
 * - **Why the XSRF cookie must exist before the first POST.** Angular's XSRF support (`withXsrfConfiguration`)
 *   is passive: for each non-GET/HEAD request to the SAME ORIGIN as the page (relative `/api/...` URLs resolve to
 *   it; absolute URLs to another origin never get the header, so the token cannot leak), it reads the
 *   `XSRF-TOKEN` cookie and copies it into `X-XSRF-TOKEN` — if the cookie exists. It never asks the server for
 *   one. A first visit has no cookie, so the login POST would go out without the header and the API would
 *   answer 403 `xsrf`. `GET /api/auth/csrf` (a GET, so it needs no token itself) makes the API set the cookie.
 *
 * Failures never block bootstrap: `csrf` errors are ignored (the login page would then show a generic error),
 * and `Session.load()` never rejects (a failure just means "signed out").
 */
import { inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { BrandingService } from '../branding/branding.service';
import { LanguageService } from '../i18n/language.service';
import { AuthApi } from './auth-api';
import { Session } from './session';

export async function initializeSession(): Promise<void> {
  const api = inject(AuthApi);
  const session = inject(Session);
  const language = inject(LanguageService);
  const branding = inject(BrandingService);

  try {
    await firstValueFrom(api.csrf());
  } catch {
    // Unreachable API: carry on signed out; /api/me will fail the same way.
  }
  await session.load();

  const user = session.user();
  if (user) {
    // Already signed in on reload: show the account's language unless this device has an explicit choice.
    language.applyAccountLocale(user.locale);
  }
  // Signed out: the public default brand, waited for briefly so the first paint already has it
  // (docs/contracts/branding.md › Start-up). Signed in: `me.branding` is already there.
  await branding.init();
}
