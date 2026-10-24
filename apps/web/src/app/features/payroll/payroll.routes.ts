/**
 * Routes of the Payroll feature, mounted under `/payroll` by app.routes.ts (signed in and holding any of
 * `payroll.read` / `payroll.configure`): the month needs `payroll.read`, the settings `payroll.configure`. Each
 * refused child falls to this table's own 404 entry (docs/contracts/payroll-variables.md › Web).
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';

export const PAYROLL_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canMatch: [permissionGuard('payroll.read')],
    loadComponent: () => import('./payroll.page').then((m) => m.PayrollPage),
  },
  {
    path: 'settings',
    canMatch: [permissionGuard('payroll.configure')],
    loadComponent: () => import('./payroll-settings.page').then((m) => m.PayrollSettingsPage),
  },
  NOT_FOUND_ROUTE,
];
