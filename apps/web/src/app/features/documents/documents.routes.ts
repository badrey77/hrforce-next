/**
 * Routes of the Documents feature, mounted under `/documents` by app.routes.ts (`loadChildren`, signed-in only).
 *
 * Angular concepts (met before — chapters 05 and 15, features/leave/leave.routes.ts):
 * - **A permission per child route.** The register and the detail need `document.read`, issuing `document.issue`,
 *   the settings `document.configure`. A regional HR user holds read + issue, only the central HR admin configures
 *   (docs/contracts/documents.md › Permissions), so the parent cannot require one of them: each child carries its own
 *   `canMatch: [permissionGuard('…')]`.
 * - **Static paths before `:id`.** `new` and `settings` come first. Without the permission they do not match and the
 *   router falls through to `:id`, which asks the API for document "new" → "not found" (the `roles/new` precedent).
 * - Every page is a `loadComponent`: the register is small, but the issue form and the settings tabs are not, and a
 *   regional HR user may never open the settings.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';

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
  {
    path: 'settings',
    canMatch: [permissionGuard('document.configure')],
    loadComponent: () => import('./settings.page').then((m) => m.DocumentSettingsPage),
  },
  {
    path: ':id',
    canMatch: [permissionGuard('document.read')],
    loadComponent: () => import('./document-detail.page').then((m) => m.DocumentDetailPage),
  },
];
