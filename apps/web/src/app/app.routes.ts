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
 *   it the route does not match and the visitor lands on `**` (404) — see core/auth/permission.guard.ts. Leave and
 *   Documents need a different permission per child: their parent asks for ANY of them (`data: { permission: [...] }`)
 *   and their child table ends with the same 404 entry, `NOT_FOUND_ROUTE` (shared/not-found/not-found.route.ts
 *   explains why the app-level `**` alone left `/leave` blank). app.routes.spec.ts opens every guarded URL as users
 *   who lack the permission and expects the 404 page.
 * - Two-step sign-in enforcement (docs/contracts/mfa.md › Web): every signed-in route uses `...signedIn`
 *   (`[authGuard, mfaEnrollmentGuard]`) instead of `authGuard` alone, EXCEPT `/me/security`, the page that fixes the
 *   problem (a guard on it would redirect to itself forever). Spreading one shared array keeps "a new page forgot the
 *   enforcement guard" out of reach; `mfaEnrollmentGuard` comes after `authGuard` so a signed-out visitor still gets
 *   the /login redirect first (the first non-`true` result wins). Sign-out is a button (POST), not a route, so it
 *   always works.
 * - Attendance (docs/contracts/attendance.md › Web):
 *   - `/kiosk` has NO guard and `data: { chrome: false }`: the entrance tablet is a paired device, never signed in,
 *     and the page owns the whole screen (the root component reads the flag — app.ts `chromeOf`). Its own lazy chunk
 *     (with the QR encoder), so no other page pays for it.
 *   - `/punch` has no guard either: the phone may arrive signed out (the session often expired overnight). The page
 *     scans first, then sends the visitor to /login itself with `returnUrl=/punch` (features/punch/punch.page.ts).
 *   - `/me/attendance` needs `attendance.punch_self`; `/me/team` only a signed-in user (a unit head needs no
 *     permission — the API returns an empty team to anyone else); `/attendance` asks for ANY of `attendance.read` /
 *     `attendance.configure`, each child for its own (features/attendance/attendance.routes.ts).
 * Order still matters (first match wins, `**` last); a guard only decides whether its route may match.
 */
import type { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth.guards';
import { mfaEnrollmentGuard } from './core/auth/mfa-enrollment';
import { permissionGuard } from './core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from './shared/not-found/not-found.route';

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
    // HR leave: list/detail need leave.read, settings leave.configure — checked per child (see leave.routes.ts). The
    // parent asks for ANY of the two, so a user with neither never downloads the chunk.
    path: 'leave',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: ['leave.read', 'leave.configure'] },
    loadChildren: () => import('./features/leave/leave.routes').then((m) => m.LEAVE_ROUTES),
  },
  {
    // Documents (register, detail, issue, settings): read/issue/configure are checked per child (documents.routes.ts),
    // like Leave (the parent asks for ANY of the three). Its own lazy chunk, so the PDF and settings screens cost
    // nothing to users who never open them.
    path: 'documents',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: ['document.read', 'document.issue', 'document.configure'] },
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
    // Entrance kiosk (attendance ADR 009): a paired device, no user session, no app chrome.
    path: 'kiosk',
    data: { chrome: false },
    loadComponent: () => import('./features/kiosk/kiosk.page').then((m) => m.KioskPage),
  },
  {
    // Phone landing of a scanned QR code: works signed out (scan first, then sign in, then punch).
    path: 'punch',
    loadComponent: () => import('./features/punch/punch.page').then((m) => m.PunchPage),
  },
  {
    // Pointage (self-service attendance): today, my month, the Law 18-07 notice.
    path: 'me/attendance',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: 'attendance.punch_self' },
    loadComponent: () => import('./features/my-attendance/my-attendance.page').then((m) => m.MyAttendancePage),
  },
  {
    // Mon équipe: the presence of the units the user heads today (no permission: the API decides from org_unit_head).
    path: 'me/team',
    canMatch: signedIn,
    loadComponent: () => import('./features/my-team/my-team.page').then((m) => m.MyTeamPage),
  },
  {
    // HR presence board and attendance settings: read / configure checked per child (attendance.routes.ts).
    path: 'attendance',
    canMatch: [...signedIn, permissionGuard()],
    data: { permission: ['attendance.read', 'attendance.configure'] },
    loadChildren: () => import('./features/attendance/attendance.routes').then((m) => m.ATTENDANCE_ROUTES),
  },
  {
    // Personal settings (for now: email notification preferences).
    path: 'settings',
    canMatch: signedIn,
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  NOT_FOUND_ROUTE,
];
