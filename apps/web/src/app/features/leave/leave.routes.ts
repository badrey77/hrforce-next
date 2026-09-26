/**
 * Routes of the HR Leave feature, mounted under `/leave` by app.routes.ts (`loadChildren`, `canMatch: [authGuard]`).
 *
 * Angular concepts:
 * - **Different permissions per child route.** The list and request pages need `leave.read`; the settings page needs
 *   `leave.configure`. Neither implies the other, so the parent route cannot require one of them: it only requires a
 *   session, and each child carries its own `canMatch: [permissionGuard('…')]` (the guard factory, chapter 12).
 *   Trade-off: a signed-in user with neither permission downloads this (small) chunk before the children refuse to
 *   match and the router falls through to `**` (404). The code is not secret — the API checks every call — so the
 *   simpler route table wins.
 * - `settings` and `requests/:id` are `loadComponent`s: smaller chunks fetched on first visit.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
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
];
