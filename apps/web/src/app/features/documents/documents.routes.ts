/**
 * Routes of the Documents feature, mounted under `/documents` by app.routes.ts (`loadChildren`, signed in and holding
 * any of `document.read` / `document.issue` / `document.configure`).
 *
 * Angular concepts (met before — chapters 05, 12 and 15, features/leave/leave.routes.ts):
 * - **A permission per child route.** The register and the detail need `document.read`, issuing `document.issue`,
 *   the settings `document.configure`. A regional HR user holds read + issue, only the central HR admin configures
 *   (docs/contracts/documents.md › Permissions), so the parent requires ANY of the three and each child carries its
 *   own `canMatch: [permissionGuard('…')]`.
 * - **`NOT_FOUND_ROUTE` last**, as in Leave: without it, `/documents` for a user who may configure but not read
 *   would match the parent with an empty outlet (a blank page) instead of showing the 404 page.
 * - **Static paths before `:id`, each followed by its refusal.** `new` and `settings` come first. Without the
 *   permission they do not match and the router would try `:id`, asking the API for document "new". The entry
 *   right after each, `{ ...NOT_FOUND_ROUTE, path: 'new' }` (an object spread: the 404 entry with another `path`),
 *   catches the word first and shows the app's 404 page, like every other refused URL.
 * - Every page is a `loadComponent`: the register is small, but the issue form and the settings tabs are not, and a
 *   regional HR user may never open the settings.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';

export const DOCUMENTS_ROUTES: Routes = [
  {
    path: '',
    canMatch: [permissionGuard('document.read')],
    loadComponent: () => import('./register.page').then((m) => m.RegisterPage),
  },
  {
    path: 'new',
    canMatch: [permissionGuard('document.issue')],
    loadComponent: () => import('./issue.page').then((m) => m.IssuePage),
  },
  { ...NOT_FOUND_ROUTE, path: 'new' },
  {
    path: 'settings',
    canMatch: [permissionGuard('document.configure')],
    loadComponent: () => import('./settings.page').then((m) => m.DocumentSettingsPage),
  },
  { ...NOT_FOUND_ROUTE, path: 'settings' },
  {
    path: ':id',
    canMatch: [permissionGuard('document.read')],
    loadComponent: () => import('./document-detail.page').then((m) => m.DocumentDetailPage),
  },
  NOT_FOUND_ROUTE,
];
