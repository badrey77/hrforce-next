import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage),
  },
  {
    path: 'employees',
    loadComponent: () => import('./features/placeholder/placeholder.page').then((m) => m.PlaceholderPage),
    data: { titleKey: 'nav.employees' },
  },
  {
    path: 'organization',
    loadComponent: () => import('./features/placeholder/placeholder.page').then((m) => m.PlaceholderPage),
    data: { titleKey: 'nav.organization' },
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/placeholder/placeholder.page').then((m) => m.PlaceholderPage),
    data: { titleKey: 'nav.settings' },
  },
  {
    path: '**',
    loadComponent: () => import('./features/not-found/not-found.page').then((m) => m.NotFoundPage),
  },
];
