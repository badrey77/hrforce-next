/**
 * `<app-access-nav>` — the sections of the Access feature: Users (/access/users), Roles (/access/roles), Applications
 * (/access/apps) and Security policy (/access/security).
 * Same pattern as features/organization/org-nav.ts (routerLink + routerLinkActive + aria-current); here the default
 * `routerLinkActive` matching (prefix) is what we want: `/access/users/…` keeps "Users" active on a user's page.
 * Each tab is shown with `*appCan` for the permission its route needs (the routes have the same guards,
 * access.routes.ts): Users and Roles `access.read`, Applications `sso.read` (docs/contracts/sso.md), Security policy
 * `access.manage_roles`. A user who only reads connected apps sees the Applications tab alone.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { CanDirective } from '../../shared/can/can.directive';

@Component({
  selector: 'app-access-nav',
  imports: [RouterLink, RouterLinkActive, TranslocoDirective, CanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1>{{ t('access.title') }}</h1>
      <nav class="access-nav" [attr.aria-label]="t('access.nav.label')">
        <a *appCan="'access.read'" routerLink="/access/users" routerLinkActive="active" ariaCurrentWhenActive="page" data-tab="users">{{
          t('access.nav.users')
        }}</a>
        <a *appCan="'access.read'" routerLink="/access/roles" routerLinkActive="active" ariaCurrentWhenActive="page" data-tab="roles">{{
          t('access.nav.roles')
        }}</a>
        <a *appCan="'sso.read'" routerLink="/access/apps" routerLinkActive="active" ariaCurrentWhenActive="page" data-tab="apps">{{
          t('access.nav.apps')
        }}</a>
        <a *appCan="'access.manage_roles'" routerLink="/access/security" routerLinkActive="active" ariaCurrentWhenActive="page" data-tab="security">{{
          t('access.nav.security')
        }}</a>
      </nav>
    </ng-container>
  `,
  styles: `
    .access-nav {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-block-end: var(--space-4);
      border-block-end: 1px solid var(--color-border);
    }
    a {
      padding-block: var(--space-2);
      padding-inline: var(--space-3);
      color: inherit;
      text-decoration: none;
      border-block-end: 3px solid transparent;
    }
    a:hover { text-decoration: underline; }
    a.active { border-block-end-color: var(--color-primary); font-weight: 600; }
  `,
})
export class AccessNav {}
