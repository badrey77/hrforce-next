/**
 * `PAGE_LOCATION` — leave the single-page app with a FULL page navigation (`location.assign(url)`).
 *
 *   private readonly location = inject(PAGE_LOCATION);
 *   …
 *   this.location.assign(redirectTo); // the browser unloads Angular and asks the server for `redirectTo`
 *
 * Angular concepts:
 * - **The router cannot leave the app.** `router.navigate()` / `navigateByUrl()` only switch between the app's OWN
 *   routes: they change the address bar with `history.pushState` and swap components; no request reaches the server.
 *   A URL the Angular route table does not know ends on its `**` route (the 404 page), not on the server. The SSO
 *   handoff (features/sso/sso-handoff.page.ts) must hand the browser over to the OpenID Connect provider at
 *   `/oidc/auth/<uid>`, which then redirects to ANOTHER site — only a real navigation does that. (`assign` rather than
 *   `replace`: Back from the app returns to the provider, which answers with its own "request expired" page instead
 *   of re-running a sign-in; either would work, `assign` is the plain, expected behaviour of a link.)
 * - **An `InjectionToken` with a `factory`** (chapter 04, like `KIOSK_RELOAD` in features/kiosk/kiosk.page.ts): the
 *   default value is built on first `inject()` from `DOCUMENT` (Angular's token for the page's `document`, so nothing
 *   touches a global directly). A test provides `{ provide: PAGE_LOCATION, useValue: { assign: spy } }` instead —
 *   assigning `window.location` in jsdom would try to navigate the test runner.
 * - `providedIn: 'root'`: one value for the whole app, like a root service.
 */
import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

export interface PageLocation {
  /** Full navigation to `url` (the SPA is unloaded). */
  assign(url: string): void;
}

export const PAGE_LOCATION = new InjectionToken<PageLocation>('PAGE_LOCATION', {
  providedIn: 'root',
  factory: () => {
    const document = inject(DOCUMENT);
    return { assign: (url: string) => document.defaultView?.location.assign(url) };
  },
});
