/**
 * Routes of the Attendance HR feature, mounted under `/attendance` by app.routes.ts (`loadChildren`, signed in and
 * holding `attendance.read` OR `attendance.configure`).
 *
 * Angular concepts (met before — chapters 05 and 12, features/leave/leave.routes.ts):
 * - **A permission per child route.** The presence board needs `attendance.read` (HR, regional HR, `lecture`);
 *   the settings need `attendance.configure` (the central HR admin only — contract assumption 10). The parent asks
 *   for ANY of the two, each child for its own `canMatch: [permissionGuard('…')]`.
 * - **`NOT_FOUND_ROUTE` last**: a configure-only user opening `/attendance` would otherwise get the parent with an
 *   empty outlet (a blank page); `{ ...NOT_FOUND_ROUTE, path: 'settings' }` answers a read-only user's `/settings`.
 * - Both pages are `loadComponent`s: a `lecture` user never downloads the settings' schedule editors.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';

export const ATTENDANCE_ROUTES: Routes = [
  {
    path: '',
    canMatch: [permissionGuard('attendance.read')],
    loadComponent: () => import('./presence-board.page').then((m) => m.PresenceBoardPage),
  },
  {
    path: 'settings',
    canMatch: [permissionGuard('attendance.configure')],
    loadComponent: () => import('./settings.page').then((m) => m.AttendanceSettingsPage),
  },
  { ...NOT_FOUND_ROUTE, path: 'settings' },
  NOT_FOUND_ROUTE,
];
