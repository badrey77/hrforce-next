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
 * - **`:id/rehire`** (a new employment for the person of an ended one) is a route of its own, not a tab of the
 *   detail: it is a different task with its own guard (`employee.create`, like `new`). The router matches a path
 *   segment by segment, so `:id/rehire` and `:id` do not compete: `/employees/e-1` has one segment after
 *   `employees`, `/employees/e-1/rehire` two. Without the permission `:id/rehire` does not match, nothing else does
 *   either, and the app's `**` route shows "not found".
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
  {
    path: ':id/rehire',
    canMatch: [permissionGuard('employee.create')],
    loadComponent: () => import('./employee-rehire.page').then((m) => m.EmployeeRehirePage),
  },
  { path: ':id', loadComponent: () => import('./employee-detail.page').then((m) => m.EmployeeDetailPage) },
];
