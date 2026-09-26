/**
 * `<app-access-nav>` — the two sections of the Access feature: Users (/access/users) and Roles (/access/roles).
 * Same pattern as features/organization/org-nav.ts (routerLink + routerLinkActive + aria-current); here the default
 * `routerLinkActive` matching (prefix) is what we want: `/access/users/…` keeps "Users" active on a user's page.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';

@Component({
  selector: 'app-access-nav',
  imports: [RouterLink, RouterLinkActive, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1>{{ t('access.title') }}</h1>
      <nav class="access-nav" [attr.aria-label]="t('access.nav.label')">
        <a routerLink="/access/users" routerLinkActive="active" ariaCurrentWhenActive="page">{{ t('access.nav.users') }}</a>
        <a routerLink="/access/roles" routerLinkActive="active" ariaCurrentWhenActive="page">{{ t('access.nav.roles') }}</a>
      </nav>
    </ng-container>
  `,
  styles: `
    .access-nav {
      display: flex;
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
