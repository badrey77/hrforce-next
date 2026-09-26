/**
 * Routes owned by the Organization feature, mounted under `/organization` by app.routes.ts with `loadChildren`.
 *
 * Angular concepts:
 * - **`loadChildren` vs `loadComponent`.** Both lazy-load: the code is split into its own chunk and downloaded the
 *   first time the user navigates there. `loadComponent` lazy-loads ONE component for ONE path; `loadChildren`
 *   lazy-loads a whole `Routes` array, so the feature decides its own sub-paths without touching the app-level
 *   routes. That paid off with `/organization/sites` (v2): only this file changed.
 * - The tree page is imported statically (this file is already in the feature's lazy chunk and `''` is the
 *   landing page). The sites page uses `loadComponent` INSIDE the lazy feature: a second, smaller chunk that is
 *   downloaded only when someone opens the sites section.
 * - Query params (`?asOf=`, `?q=`) need no route config: with `withComponentInputBinding()` they reach the
 *   page's inputs.
 * - `permissionGuard('site.read')` — the guard factory with the code as an ARGUMENT (the app-level routes pass it
 *   through route `data` instead; see core/auth/permission.guard.ts). The parent `/organization` already needs
 *   `org_unit.read`; sites need `site.read` on top.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { OrganizationPage } from './organization.page';

export const ORGANIZATION_ROUTES: Routes = [
  { path: '', component: OrganizationPage },
  {
    path: 'sites',
    canMatch: [permissionGuard('site.read')],
    loadComponent: () => import('./sites.page').then((m) => m.SitesPage),
  },
];
