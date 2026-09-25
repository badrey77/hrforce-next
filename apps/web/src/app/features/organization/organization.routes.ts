/**
 * Routes owned by the Organization feature, mounted under `/organization` by app.routes.ts with `loadChildren`.
 *
 * Angular concepts:
 * - **`loadChildren` vs `loadComponent`.** Both lazy-load: the code is split into its own chunk and downloaded the
 *   first time the user navigates there. `loadComponent` lazy-loads ONE component for ONE path; `loadChildren`
 *   lazy-loads a whole `Routes` array, so the feature decides its own sub-paths (e.g. a future `/organization/:id`
 *   or `/organization/history`) without touching the app-level routes. We picked `loadChildren` because this
 *   feature will grow; the page itself is imported statically here, because this file is already in the lazy chunk.
 * - Query params (`?asOf=`) need no route config: with `withComponentInputBinding()` they reach the page's inputs.
 */
import type { Routes } from '@angular/router';
import { OrganizationPage } from './organization.page';

export const ORGANIZATION_ROUTES: Routes = [{ path: '', component: OrganizationPage }];
