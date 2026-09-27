/**
 * App-level routes.
 *
 * Guards (core/auth/auth.guards.ts, docs/contracts/identity.md › Web):
 * - `canMatch: [authGuard]` on every route except `/login`, `/password/setup`, `/password/forgot` and `**`.
 *   `canMatch` (not `canActivate`) so a signed-out visitor never downloads a feature's lazy chunk — see the
 *   guard file for the router phases.
 * - `canMatch: [guestGuard]` on `/login`: a signed-in user is sent home.
 * - The password pages have no guard: an emailed link must work whether or not someone is signed in on this
 *   browser.
 * - `canMatch: [authGuard, permissionGuard()]` + `data: { permission }` on features that need a permission
 *   (docs/contracts/authorization.md › Web): Organization needs `org_unit.read`, Access needs `access.read`, Employees
 *   needs `employee.read` (docs/contracts/employment.md › Web), My leave needs `leave.request_self`
 *   (docs/contracts/leave.md › Web). Without
 *   it the route does not match and the visitor lands on `**` (404) — see core/auth/permission.guard.ts.
 * Order still matters (first match wins, `**` last); a guard only decides whether its route may match.
 */
import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guards';
import { permissionGuard } from './core/auth/permission.guard';

export const routes: Routes = [
  {
    path: 'login',
    canMatch: [guestGuard],
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'password/setup',
    loadComponent: () => import('./features/auth/password-setup.page').then((m) => m.PasswordSetupPage),
  },
  {
    path: 'password/forgot',
    loadComponent: () => import('./features/auth/password-forgot.page').then((m) => m.PasswordForgotPage),
  },
  {
    path: '',
    pathMatch: 'full',
    canMatch: [authGuard],
    loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage),
  },
  {
    // Employees (list, create, detail): its own lazy chunk, never downloaded without employee.read.
    path: 'employees',
    canMatch: [authGuard, permissionGuard()],
    data: { permission: 'employee.read' },
    loadChildren: () => import('./features/employees/employees.routes').then((m) => m.EMPLOYEES_ROUTES),
  },
  {
    // loadChildren: the feature owns its sub-routes (see features/organization/organization.routes.ts).
    path: 'organization',
    canMatch: [authGuard, permissionGuard()],
    data: { permission: 'org_unit.read' },
    loadChildren: () =>
      import('./features/organization/organization.routes').then((m) => m.ORGANIZATION_ROUTES),
  },
  {
    // Access management (users, grants, roles): its own lazy chunk, never downloaded without access.read.
    path: 'access',
    canMatch: [authGuard, permissionGuard()],
    data: { permission: 'access.read' },
    loadChildren: () => import('./features/access/access.routes').then((m) => m.ACCESS_ROUTES),
  },
  {
    // My leave (self-service): needs leave.request_self; the page itself handles "no linked employment".
    path: 'me/leave',
    canMatch: [authGuard, permissionGuard()],
    data: { permission: 'leave.request_self' },
    loadComponent: () => import('./features/my-leave/my-leave.page').then((m) => m.MyLeavePage),
  },
  {
    // My tasks: every signed-in user may be a candidate (a unit head needs no permission), so no permission guard.
    path: 'tasks',
    canMatch: [authGuard],
    loadComponent: () => import('./features/tasks/tasks.page').then((m) => m.TasksPage),
  },
  {
    // HR leave: list/detail need leave.read, settings leave.configure — checked per child (see leave.routes.ts).
    path: 'leave',
    canMatch: [authGuard],
    loadChildren: () => import('./features/leave/leave.routes').then((m) => m.LEAVE_ROUTES),
  },
  {
    // Notifications (docs/contracts/notifications.md › Web): every signed-in user has their own.
    path: 'notifications',
    canMatch: [authGuard],
    loadComponent: () => import('./features/notifications/notifications.page').then((m) => m.NotificationsPage),
  },
  {
    // Personal settings (for now: email notification preferences).
    path: 'settings',
    canMatch: [authGuard],
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  {
    path: '**',
    loadComponent: () => import('./features/not-found/not-found.page').then((m) => m.NotFoundPage),
  },
];
