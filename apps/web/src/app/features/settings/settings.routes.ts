/**
 * /settings: personal notification preferences for every signed-in user, and the branding section for holders of
 * `settings.branding` (docs/contracts/branding.md › Settings section). A refused `/settings/branding` falls to this
 * table's own 404 entry: the page's chunk is never downloaded and the URL is kept.
 */
import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';
import { SettingsPage } from './settings.page';

export const BRANDING_PERMISSION = 'settings.branding';

export const SETTINGS_ROUTES: Routes = [
  { path: '', pathMatch: 'full', component: SettingsPage },
  {
    path: 'branding',
    canMatch: [permissionGuard(BRANDING_PERMISSION)],
    loadComponent: () => import('./branding/branding.page').then((m) => m.BrandingPage),
  },
  NOT_FOUND_ROUTE,
];
