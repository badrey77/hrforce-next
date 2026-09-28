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
 * - `canMatch: [...signedIn, permissionGuard()]` + `data: { permission }` on features that need a permission
 *   (docs/contracts/authorization.md › Web): Organization needs `org_unit.read`, Access needs `access.read`, Employees
 *   needs `employee.read` (docs/contracts/employment.md › Web), My leave needs `leave.request_self`
 *   (docs/contracts/leave.md › Web), My documents needs `document.request_self` (docs/contracts/documents.md › Web). Without
 *   it the route does not match and the visitor lands on `**` (404) — see core/auth/permission.guard.ts.
 * - Two-step sign-in enforcement (docs/contracts/mfa.md › Web): every signed-in route uses `...signedIn`
 *   (`[authGuard, mfaEnrollmentGuard]`) instead of `authGuard` alone, EXCEPT `/me/security`, the page that fixes the
 *   problem (a guard on it would redirect to itself forever). Spreading one shared array keeps "a new page forgot the
 *   enforcement guard" out of reach; `mfaEnrollmentGuard` comes after `authGuard` so a signed-out visitor still gets
 *   the /login redirect first (the first non-`true` result wins). Sign-out is a button (POST), not a route, so it
 *   always works.
 * Order still matters (first match wins, `**` last); a guard only decides whether its route may match.
 */
import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guards';
import { mfaEnrollmentGuard } from './core/auth/mfa-enrollment';
import { permissionGuard } from './core/auth/permission.guard';

/** Signed in AND not blocked by the two-step sign-in policy. */
const signedIn = [authGuard, mfaEnrollmentGuard];

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
    canMatch: signedIn,
    loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage),
  },
  {
    // Employees (list, create, detail): its own lazy chunk, never downloaded without employee.read.
    path: 'employees',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: 'employee.read' },
    loadChildren: () => import('./features/employees/employees.routes').then((m) => m.EMPLOYEES_ROUTES),
  },
  {
    // loadChildren: the feature owns its sub-routes (see features/organization/organization.routes.ts).
    path: 'organization',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: 'org_unit.read' },
    loadChildren: () =>
      import('./features/organization/organization.routes').then((m) => m.ORGANIZATION_ROUTES),
  },
  {
    // Access management (users, grants, roles): its own lazy chunk, never downloaded without access.read.
    path: 'access',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: 'access.read' },
    loadChildren: () => import('./features/access/access.routes').then((m) => m.ACCESS_ROUTES),
  },
  {
    // My leave (self-service): needs leave.request_self; the page itself handles "no linked employment".
    path: 'me/leave',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: 'leave.request_self' },
    loadComponent: () => import('./features/my-leave/my-leave.page').then((m) => m.MyLeavePage),
  },
  {
    // My documents (docs/contracts/documents.md › Web): self-service attestation requests and my issued documents.
    path: 'me/documents',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: 'document.request_self' },
    loadComponent: () => import('./features/my-documents/my-documents.page').then((m) => m.MyDocumentsPage),
  },
  {
    // My tasks: every signed-in user may be a candidate (a unit head needs no permission), so no permission guard.
    path: 'tasks',
    canMatch: signedIn,
    loadComponent: () => import('./features/tasks/tasks.page').then((m) => m.TasksPage),
  },
  {
    // HR leave: list/detail need leave.read, settings leave.configure — checked per child (see leave.routes.ts).
    path: 'leave',
    canMatch: signedIn,
    loadChildren: () => import('./features/leave/leave.routes').then((m) => m.LEAVE_ROUTES),
  },
  {
    // Documents (register, detail, issue, settings): read/issue/configure are checked per child (documents.routes.ts),
    // like Leave. Its own lazy chunk, so the PDF and settings screens cost nothing to users who never open them.
    path: 'documents',
    canMatch: signedIn,
    loadChildren: () => import('./features/documents/documents.routes').then((m) => m.DOCUMENTS_ROUTES),
  },
  {
    // Notifications (docs/contracts/notifications.md › Web): every signed-in user has their own.
    path: 'notifications',
    canMatch: signedIn,
    loadComponent: () => import('./features/notifications/notifications.page').then((m) => m.NotificationsPage),
  },
  {
    // Two-step sign-in (docs/contracts/mfa.md › Web): status, enrollment wizard, recovery codes. authGuard ONLY — this
    // is where mfaEnrollmentGuard sends people, so it must stay reachable while enrollment is required.
    path: 'me/security',
    canMatch: [authGuard],
    loadComponent: () => import('./features/security/security.page').then((m) => m.SecurityPage),
  },
  {
    // Personal settings (for now: email notification preferences).
    path: 'settings',
    canMatch: signedIn,
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  {
    path: '**',
    loadComponent: () => import('./features/not-found/not-found.page').then((m) => m.NotFoundPage),
  },
];
