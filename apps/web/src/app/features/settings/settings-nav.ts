/**
 * `<app-settings-nav>` — the page title and the sections of /settings: « Notifications » for everyone, « Identité
 * visuelle » only with `settings.branding` (the route has the same guard, settings.routes.ts).
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { CanDirective } from '../../shared/can/can.directive';

@Component({
  selector: 'app-settings-nav',
  imports: [RouterLink, RouterLinkActive, TranslocoDirective, CanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1>{{ t('settings.title') }}</h1>
      <nav class="settings-nav" [attr.aria-label]="t('settings.nav.label')">
        <a routerLink="/settings" routerLinkActive="active" ariaCurrentWhenActive="page" [routerLinkActiveOptions]="{ exact: true }" data-tab="notifications">{{
          t('settings.nav.notifications')
        }}</a>
        <a *appCan="'settings.branding'" routerLink="/settings/branding" routerLinkActive="active" ariaCurrentWhenActive="page" data-tab="branding">{{
          t('settings.nav.branding')
        }}</a>
      </nav>
    </ng-container>
  `,
  styles: `
    .settings-nav {
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
export class SettingsNav {}
