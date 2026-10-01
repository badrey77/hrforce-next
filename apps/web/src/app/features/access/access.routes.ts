/**
 * Routes of the Access feature, mounted under `/access` by app.routes.ts (`loadChildren`, guarded by
 * `permissionGuard()` + `data: { permission: ['access.read', 'sso.read'] }` — ANY of the two).
 *
 * Angular concepts:
 * - **A redirect decided at navigation time** (`redirectTo` as a FUNCTION): `/access` itself has no page. A user with
 *   `access.read` lands on Users, one who only reads connected apps (`sso.read`) on Applications. The function runs
 *   in an injection context, so it can `inject(Session)`; it returns the relative path to go to. `pathMatch: 'full'`
 *   makes the redirect apply only to the empty remainder (without it, `''` would prefix-match every child URL).
 * - **A parent guarded by ANY of two permissions, each child by its own** (chapter 12, like Leave and Documents):
 *   Users/Roles need `access.read`, Applications `sso.read`, creating an app `sso.manage_apps`. A refused child does not
 *   match, and the trailing `NOT_FOUND_ROUTE` shows the app's 404 page (shared/not-found/not-found.route.ts).
 * - **Static vs parameterised paths, and order.** `roles/new` must come BEFORE `roles/:id`, or `:id` would match
 *   the word "new". `roles/new` also has `canMatch: [permissionGuard('access.manage_roles')]`: without that
 *   permission it does not match and the router tries the NEXT entry — the `canMatch` "try the next route" semantics
 *   at work. That entry is `{ ...NOT_FOUND_ROUTE, path: 'roles/new' }` (the shared 404 entry with another path), so the
 *   user sees the app's 404 page, as for every refused URL. Without it the router would reach `roles/:id` with
 *   `id = 'new'` and the editor would say "role not found". `apps/new` follows the same pattern.
 * - **`canDeactivate`** on `apps/new` and `apps/:id` (`secretLeaveGuard`, features/access/secret-panel.ts): leaving
 *   while a just-issued client secret is still on screen asks for confirmation.
 * - **Route params as inputs**: `users/:id`, `roles/:id`, `apps/:id` reach the pages as `id = input<string>()` thanks
 *   to `withComponentInputBinding()` (app.config.ts); the same editor component serves `roles/new` (no `id`).
 * - The users and roles lists are imported statically (landing pages of an already-lazy chunk); the other pages are
 *   `loadComponent`s — smaller chunks, fetched when first opened.
 */
import { inject } from '@angular/core';
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { Session } from '../../core/auth/session';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';
import { RolesPage } from './roles.page';
import { secretLeaveGuard } from './secret-panel';
import { UsersPage } from './users.page';

const canReadAccess = permissionGuard('access.read');
const canReadApps = permissionGuard('sso.read');

export const ACCESS_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: () => (inject(Session).can('access.read') ? 'users' : 'apps') },
  { path: 'users', canMatch: [canReadAccess], component: UsersPage },
  { path: 'users/:id', canMatch: [canReadAccess], loadComponent: () => import('./user-detail.page').then((m) => m.UserDetailPage) },
  { path: 'roles', canMatch: [canReadAccess], component: RolesPage },
  {
    path: 'roles/new',
    canMatch: [canReadAccess, permissionGuard('access.manage_roles')],
    loadComponent: () => import('./role-editor.page').then((m) => m.RoleEditorPage),
  },
  { ...NOT_FOUND_ROUTE, path: 'roles/new' },
  { path: 'roles/:id', canMatch: [canReadAccess], loadComponent: () => import('./role-editor.page').then((m) => m.RoleEditorPage) },
  {
    // Two-step sign-in policy (docs/contracts/mfa.md): manage_roles only; without it the route does not match (404).
    path: 'security',
    canMatch: [permissionGuard('access.manage_roles')],
    loadComponent: () => import('./security-policy.page').then((m) => m.SecurityPolicyPage),
  },
  // Connected apps (docs/contracts/sso.md › Web).
  { path: 'apps', canMatch: [canReadApps], loadComponent: () => import('./apps.page').then((m) => m.AppsPage) },
  {
    path: 'apps/new',
    canMatch: [canReadApps, permissionGuard('sso.manage_apps')],
    canDeactivate: [secretLeaveGuard],
    loadComponent: () => import('./app-new.page').then((m) => m.AppNewPage),
  },
  { ...NOT_FOUND_ROUTE, path: 'apps/new' },
  {
    path: 'apps/:id',
    canMatch: [canReadApps],
    canDeactivate: [secretLeaveGuard],
    loadComponent: () => import('./app-detail.page').then((m) => m.AppDetailPage),
  },
  NOT_FOUND_ROUTE,
];
