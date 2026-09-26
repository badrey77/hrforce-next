/**
 * `permissionGuard` — a route exists only for users who hold a permission (docs/contracts/authorization.md › Web).
 *
 *   { path: 'access', canMatch: [authGuard, permissionGuard()], data: { permission: 'access.read' }, loadChildren }
 *   { path: 'roles/new', canMatch: [permissionGuard('access.manage_roles')], loadComponent }
 *
 * Angular concepts:
 * - **A guard FACTORY.** `authGuard` is a guard; `permissionGuard(code)` is a function that RETURNS a guard. The
 *   returned arrow function "closes over" `code` (a JavaScript closure), so one factory serves every permission.
 *   The router only ever sees a `CanMatchFn`; it never calls the factory itself — `permissionGuard('x')` runs once,
 *   when app.routes.ts is evaluated.
 * - **Or the code comes from route `data`.** `canMatch` receives the `Route` config object being matched, so
 *   `route.data` is the static `data: {…}` written next to it. `permissionGuard()` without an argument reads
 *   `data.permission`. Why offer both: `data` keeps the requirement visible in the route table (and readable by
 *   other code, e.g. a menu built from the routes); the closure is shorter for a one-off sub-route. If both are
 *   given, the argument wins. Neither → the guard denies (fail closed: a typo must not open a route).
 * - **Why `false` here, when `authGuard` never returns `false`.** For `canMatch`, `false` means "this route does not
 *   match — try the next one"; the router ends on `**`, the 404 page. For "not signed in", a redirect to /login is
 *   the fix, so `authGuard` returns a `UrlTree`. For "signed in but not allowed" nothing the user can do on another
 *   page fixes it, and the API itself answers out-of-scope ids with 404, not 403 (ADR 002): the route simply does
 *   not exist for this user. And because `canMatch` runs before `loadChildren`, the feature's code is never
 *   downloaded for them either.
 * - **Several `canMatch` guards on one route.** They all run; the router takes the FIRST non-`true` result in array
 *   order. With `[authGuard, permissionGuard()]` a signed-out visitor therefore gets authGuard's /login redirect,
 *   not this guard's `false`.
 * - It reads `Session.can()` — a signal read — once per navigation. The session is loaded before the first
 *   navigation (app initializer), so the answer is ready. The guard is NOT re-run when permissions change later;
 *   what is on screen then is kept in sync by `*appCan` / `@if (session.can(…))`, and the API stays the authority.
 */
import { inject } from '@angular/core';
import type { CanMatchFn } from '@angular/router';
import { Session } from './session';

/** Key of route `data` read by `permissionGuard()` when called without a code. */
export const PERMISSION_DATA_KEY = 'permission';

export function permissionGuard(code?: string): CanMatchFn {
  return (route) => {
    const fromData: unknown = route.data?.[PERMISSION_DATA_KEY];
    const required = code ?? (typeof fromData === 'string' ? fromData : undefined);
    return required !== undefined && inject(Session).can(required);
  };
}
