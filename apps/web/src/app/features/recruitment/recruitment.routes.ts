import type { Routes } from '@angular/router';
import { permissionGuard } from '../../core/auth/permission.guard';
import { NOT_FOUND_ROUTE } from '../../shared/not-found/not-found.route';

const READ = 'recruitment.read';

/** `/recruitment` — HR screens. A refused route shows "not found" (and its code is not loaded). */
export const RECRUITMENT_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canMatch: [permissionGuard(READ)],
    loadComponent: () => import('./openings.page').then((m) => m.OpeningsPage),
  },
  {
    path: 'openings/new',
    canMatch: [permissionGuard(READ)],
    loadComponent: () => import('./opening-request.page').then((m) => m.OpeningRequestPage),
  },
  {
    path: 'openings/:id',
    canMatch: [permissionGuard(READ)],
    loadComponent: () => import('./opening-detail.page').then((m) => m.OpeningDetailPage),
  },
  {
    path: 'candidates',
    canMatch: [permissionGuard(READ)],
    loadComponent: () => import('./candidates.page').then((m) => m.CandidatesPage),
  },
  {
    path: 'candidates/:id',
    canMatch: [permissionGuard(READ)],
    loadComponent: () => import('./candidate.page').then((m) => m.CandidatePage),
  },
  {
    path: 'settings',
    canMatch: [permissionGuard('recruitment.configure')],
    loadComponent: () => import('./settings.page').then((m) => m.RecruitmentSettingsPage),
  },
  {
    path: 'notice',
    canMatch: [permissionGuard(READ)],
    loadComponent: () => import('./notice.page').then((m) => m.NoticePage),
  },
  NOT_FOUND_ROUTE,
];

/** `/me/recruitment` — the requester's / unit head's view: signed in, no permission (the API decides). */
export const MY_RECRUITMENT_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./my-openings.page').then((m) => m.MyOpeningsPage),
  },
  {
    path: 'new',
    data: { personal: true },
    loadComponent: () => import('./opening-request.page').then((m) => m.OpeningRequestPage),
  },
  {
    path: 'openings/:id',
    loadComponent: () => import('./my-opening-detail.page').then((m) => m.MyOpeningDetailPage),
  },
  NOT_FOUND_ROUTE,
];
