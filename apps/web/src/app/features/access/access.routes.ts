/**
 * Routes of the Access feature, mounted under `/access` by app.routes.ts (`loadChildren`, guarded by
 * `permissionGuard()` + `data: { permission: 'access.read' }`).
 *
 * Angular concepts:
 * - **`redirectTo`**: `/access` itself has no page; `pathMatch: 'full'` makes the redirect apply only to the empty
 *   remainder (without it, `''` would prefix-match every child URL).
 * - **Static vs parameterised paths, and order.** `roles/new` must come BEFORE `roles/:id`, or `:id` would match
 *   the word "new". `roles/new` also has `canMatch: [permissionGuard('access.manage_roles')]`: without that
 *   permission it does not match and the router tries the NEXT entry — the `canMatch` "try the next route" semantics
 *   at work. That entry is `{ ...NOT_FOUND_ROUTE, path: 'roles/new' }` (the shared 404 entry with another path,
 *   shared/not-found/not-found.route.ts), so the user sees the app's 404 page, as for every refused URL. Without it
 *   the router would reach `roles/:id` with `id = 'new'` and the editor would say "role not found".
 * - **Route params as inputs**: `users/:id` and `roles/:id` reach the pages as `id = input<string>()` thanks to
 *   `withComponentInputBinding()` (app.config.ts); the same editor component serves `roles/new` (no `id`).
 * - The list pages are imported statically (they are the landing pages of an already-lazy chunk); the detail and
 *   editor pages are `loadComponent`s — smaller chunks, fetched when first opened.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';
import { RolesPage } from './roles.page';
import { UsersPage } from './users.page';

export const ACCESS_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'users' },
  { path: 'users', component: UsersPage },
  { path: 'users/:id', loadComponent: () => import('./user-detail.page').then((m) => m.UserDetailPage) },
  { path: 'roles', component: RolesPage },
  {
    path: 'roles/new',
    canMatch: [permissionGuard('access.manage_roles')],
    loadComponent: () => import('./role-editor.page').then((m) => m.RoleEditorPage),
  },
  { ...NOT_FOUND_ROUTE, path: 'roles/new' },
  { path: 'roles/:id', loadComponent: () => import('./role-editor.page').then((m) => m.RoleEditorPage) },
  {
    // Two-step sign-in policy (docs/contracts/mfa.md): manage_roles only; without it the route does not match (404).
    path: 'security',
    canMatch: [permissionGuard('access.manage_roles')],
    loadComponent: () => import('./security-policy.page').then((m) => m.SecurityPolicyPage),
  },
];
