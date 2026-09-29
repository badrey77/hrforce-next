/**
 * Routes of the HR Leave feature, mounted under `/leave` by app.routes.ts (`loadChildren`, signed in and holding
 * `leave.read` OR `leave.configure`).
 *
 * Angular concepts:
 * - **Different permissions per child route.** The list and request pages need `leave.read`; the settings page needs
 *   `leave.configure`. Neither implies the other, so the parent route cannot require one of them: it requires ANY of
 *   them (`data: { permission: [...] }`, core/auth/permission.guard.ts), and each child carries its own
 *   `canMatch: [permissionGuard('…')]` (the guard factory, chapter 12). A user with neither never downloads this chunk.
 * - **`NOT_FOUND_ROUTE` last.** A user with `leave.configure` only who opens `/leave`: the parent matches, the `''`
 *   child refuses, and with nothing left of the URL the router would keep the parent with an EMPTY outlet — a blank
 *   page (shared/not-found/not-found.route.ts explains the matching rule). The trailing `**` child shows the 404
 *   page instead, the same one the app shows everywhere else.
 * - `settings` and `requests/:id` are `loadComponent`s: smaller chunks fetched on first visit.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';
import { LeaveListPage } from './leave-list.page';

export const LEAVE_ROUTES: Routes = [
  { path: '', canMatch: [permissionGuard('leave.read')], component: LeaveListPage },
  {
    path: 'settings',
    canMatch: [permissionGuard('leave.configure')],
    loadComponent: () => import('./leave-settings.page').then((m) => m.LeaveSettingsPage),
  },
  {
    path: 'requests/:id',
    canMatch: [permissionGuard('leave.read')],
    loadComponent: () => import('./leave-request.page').then((m) => m.LeaveRequestPage),
  },
  NOT_FOUND_ROUTE,
];
