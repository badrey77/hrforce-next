/**
 * Routes of the Deadlines feature, mounted under `/deadlines` by app.routes.ts (signed in and holding any of
 * `deadline.read` / `deadline.configure`): the board needs `deadline.read`, the policy `deadline.configure`. Each
 * refused child falls to this table's own 404 entry (as Documents and Leave).
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';

export const DEADLINES_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canMatch: [permissionGuard('deadline.read')],
    loadComponent: () => import('./deadlines-board.page').then((m) => m.DeadlinesBoardPage),
  },
  {
    path: 'settings',
    canMatch: [permissionGuard('deadline.configure')],
    loadComponent: () => import('./deadline-settings.page').then((m) => m.DeadlineSettingsPage),
  },
  NOT_FOUND_ROUTE,
];
