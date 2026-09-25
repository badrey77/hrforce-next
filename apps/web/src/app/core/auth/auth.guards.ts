/**
 * Route guards for the Identity slice: `authGuard` (signed-in only) and `guestGuard` (signed-out only).
 *
 * Angular concepts:
 * - **Functional guards.** A guard is a plain function the router calls while it decides whether a route may be
 *   used. It runs in an injection context, so `inject(Session)` works inside it: no class, no `implements`.
 *   (Class-based `CanActivate` guards still exist but are the old style.)
 * - **`canMatch` vs `canActivate` — why these are `CanMatchFn`.** The router works in phases: it first MATCHES
 *   the URL against the config (and downloads `loadChildren` chunks as it goes, since it needs their routes to
 *   keep matching), THEN runs `canActivate` guards, THEN downloads `loadComponent` chunks. So a `canActivate` on
 *   `/organization` (a `loadChildren` route) would run only after the Organization chunk was fetched for a
 *   signed-out visitor. `canMatch` runs during matching, before any lazy code of that route is loaded, so
 *   signed-out visitors never download feature code. It is also the guard the route config reads as "this
 *   route does not exist for you", which is exactly right for a login gate.
 *   Trap: a `canMatch` that returns `false` makes the router try the NEXT route (ending at `**`, the 404 page).
 *   These guards never return `false`; they return a `UrlTree`.
 * - **Returning a `UrlTree` instead of calling `router.navigate()`.** A `UrlTree` is a parsed URL. Returned from
 *   a guard, it tells the router "cancel this navigation and go there instead", as ONE navigation: history,
 *   events and the `returnUrl` stay consistent. Calling `navigate()` inside a guard starts a second navigation
 *   while the first is still running, and the guard then has to return `false` as well.
 * - **Where the attempted URL comes from.** `canMatch` receives the route and URL segments of the level being
 *   matched, not the whole URL. `router.currentNavigation()` (a signal, Angular ≥ 20.2) holds the navigation in
 *   progress; its `extractedUrl` is the full target, query string included, which becomes `returnUrl`.
 *
 * The session is already known when these run: the app initializer (session-init.ts) awaits `GET /api/me`
 * before the router's first navigation.
 */
import { inject } from '@angular/core';
import { type CanMatchFn, Router, type UrlSegment } from '@angular/router';
import { Session } from './session';

/** Lets signed-in users through; sends everyone else to `/login?returnUrl=<the URL they asked for>`. */
export const authGuard: CanMatchFn = (_route, segments: UrlSegment[]) => {
  if (inject(Session).isAuthenticated()) {
    return true;
  }
  const router = inject(Router);
  const attempted = router.currentNavigation()?.extractedUrl;
  const returnUrl = attempted ? router.serializeUrl(attempted) : `/${segments.map((s) => s.path).join('/')}`;
  return router.createUrlTree(['/login'], { queryParams: { returnUrl } });
};

/** For `/login`: a user who is already signed in goes home instead of seeing the form again. */
export const guestGuard: CanMatchFn = () =>
  inject(Session).isAuthenticated() ? inject(Router).createUrlTree(['/']) : true;
