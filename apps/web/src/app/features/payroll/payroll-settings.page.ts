/**
 * /payroll/settings (`payroll.configure`, company-wide writes; docs/contracts/payroll-variables.md › Web builder 2):
 * three tabs — Rubriques, Format d'export, Calendrier. `?tab=` picks the first tab shown.
 */
import { ChangeDetectionStrategy, Component, input, linkedSignal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { CanDirective } from '../../shared/can/can.directive';
import { CalendarSettings } from './calendar-settings';
import { FormatSettings } from './format-settings';
import { RubriquesSettings } from './rubriques-settings';

export type PayrollSettingsTab = 'rubriques' | 'format' | 'calendar';
export const PAYROLL_SETTINGS_TABS: readonly PayrollSettingsTab[] = ['rubriques', 'format', 'calendar'];

@Component({
  selector: 'app-payroll-settings-page',
  imports: [TranslocoDirective, RouterLink, CanDirective, RubriquesSettings, FormatSettings, CalendarSettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './payroll-settings.css',
  template: `
    <ng-container *transloco="let t">
      <p *appCan="'payroll.read'"><a routerLink="/payroll" data-link="back">{{ t('payroll.settings.back') }}</a></p>
      <header class="page-header">
        <h1>{{ t('payroll.settings.title') }}</h1>
      </header>
      <div class="tabs" role="tablist" [attr.aria-label]="t('payroll.settings.title')">
        @for (name of tabs; track name) {
          <button type="button" role="tab" [id]="'pay-settings-tab-' + name" [attr.data-tab]="name" [attr.aria-selected]="active() === name"
            aria-controls="pay-settings-panel" (click)="active.set(name)">
            {{ t('payroll.settings.tab.' + name) }}
          </button>
        }
      </div>
      <div id="pay-settings-panel" role="tabpanel" [attr.aria-labelledby]="'pay-settings-tab-' + active()">
        @switch (active()) {
          @case ('rubriques') {
            <app-payroll-rubriques-settings />
          }
          @case ('format') {
            <app-payroll-format-settings />
          }
          @case ('calendar') {
            <app-payroll-calendar-settings />
          }
        }
      </div>
    </ng-container>
  `,
})
export class PayrollSettingsPage {
  protected readonly tabs = PAYROLL_SETTINGS_TABS;
  readonly tab = input<string | undefined>();
  protected readonly active = linkedSignal<string | undefined, PayrollSettingsTab>({
    source: this.tab,
    computation: (tab) => ((PAYROLL_SETTINGS_TABS as readonly string[]).includes(tab ?? '') ? (tab as PayrollSettingsTab) : 'rubriques'),
  });
}
