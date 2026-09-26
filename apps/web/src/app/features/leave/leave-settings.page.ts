/**
 * /leave/settings (`leave.configure`) — leave configuration: types (inline edit), public holidays per year, policy.
 * Every number of the Algerian defaults (docs/contracts/leave.md › Assumptions) is DATA edited here, not code.
 *
 * Angular concepts: a page that only COMPOSES three self-contained section components. Each section owns its
 * resource, form and feedback, so they load, fail and save independently (a failing holidays request does not hide
 * the types table). The page has no state at all.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { CanDirective } from '../../shared/can/can.directive';
import { HolidaysSettings } from './holidays-settings';
import { LeaveTypesSettings } from './leave-types-settings';
import { PolicySettings } from './policy-settings';

@Component({
  selector: 'app-leave-settings-page',
  imports: [TranslocoDirective, RouterLink, CanDirective, LeaveTypesSettings, HolidaysSettings, PolicySettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <p *appCan="'leave.read'"><a routerLink="/leave">{{ t('leave.detail.back') }}</a></p>
      <header class="page-header">
        <h1>{{ t('leave.settings.title') }}</h1>
      </header>
      <p class="field-hint">{{ t('leave.settings.intro') }}</p>
      <app-leave-types-settings />
      <app-holidays-settings />
      <app-policy-settings />
    </ng-container>
  `,
})
export class LeaveSettingsPage {}
