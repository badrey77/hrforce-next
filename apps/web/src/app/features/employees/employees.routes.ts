/**
 * Routes of the Employees feature, mounted under `/employees` by app.routes.ts (`loadChildren`, guarded by
 * `permissionGuard()` + `data: { permission: 'employee.read' }`).
 *
 * Angular concepts (all met before — chapter 05):
 * - The list is imported statically (landing page of an already-lazy chunk); the create and detail pages are
 *   `loadComponent`s, fetched when first opened.
 * - **`new` before `:id`.** `new` has `canMatch: [permissionGuard('employee.create')]`. Without the permission it
 *   does not match and the router falls through to `:id`, which asks the API for employee "new" and shows "not
 *   found" — the same fall-through as `roles/new` in the Access feature.
 * - `:id` (the EMPLOYMENT id) and the list's query params reach the pages as signal inputs
 *   (`withComponentInputBinding()`).
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { EmployeesPage } from './employees.page';

export const EMPLOYEES_ROUTES: Routes = [
  { path: '', component: EmployeesPage },
  {
    path: 'new',
    canMatch: [permissionGuard('employee.create')],
    loadComponent: () => import('./employee-create.page').then((m) => m.EmployeeCreatePage),
  },
  { path: ':id', loadComponent: () => import('./employee-detail.page').then((m) => m.EmployeeDetailPage) },
];
