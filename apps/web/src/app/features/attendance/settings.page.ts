/**
 * /attendance/settings (`attendance.configure`) — Horaires · Affectations · Bornes · Politique, as tabs
 * (docs/contracts/attendance.md › Web › Settings). Everything configured here is DATA: the contract's Algerian
 * defaults (hours, tolerance, Ramadan, retention) are edited, never coded.
 *
 * Angular concepts: the /documents/settings pattern (chapter 14) — tabs as a local `linkedSignal` of an optional
 * `?tab=` entry parameter, each tab a self-contained section component that owns its resources, forms and feedback;
 * `@switch` renders only the active one, so opening the settings loads only the schedules. Writes need the permission
 * over the WHOLE company: a narrower holder gets 403 `forbidden-scope`, which each section explains.
 */
import { ChangeDetectionStrategy, Component, input, linkedSignal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { CanDirective } from '../../shared/can/can.directive';
import { AssignmentsSettings } from './assignments-settings';
import { AttendancePolicySettings } from './attendance-policy-settings';
import { KiosksSettings } from './kiosks-settings';
import { OverridesSettings } from './overrides-settings';
import { SchedulesSettings } from './schedules-settings';

export type AttendanceSettingsTab = 'schedules' | 'assignments' | 'kiosks' | 'policy';
export const ATTENDANCE_SETTINGS_TABS: readonly AttendanceSettingsTab[] = ['schedules', 'assignments', 'kiosks', 'policy'];

@Component({
  selector: 'app-attendance-settings-page',
  imports: [TranslocoDirective, RouterLink, CanDirective, SchedulesSettings, OverridesSettings, AssignmentsSettings, KiosksSettings, AttendancePolicySettings],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './attendance.css',
  template: `
    <ng-container *transloco="let t">
      <p *appCan="'attendance.read'"><a routerLink="/attendance">{{ t('attendance.settings.back') }}</a></p>
      <header class="page-header">
        <h1>{{ t('attendance.settings.title') }}</h1>
      </header>
      <p class="field-hint">{{ t('attendance.settings.intro') }}</p>

      <div class="tabs" role="tablist" [attr.aria-label]="t('attendance.settings.tabs')">
        @for (name of tabs; track name) {
          <button type="button" role="tab" [id]="'att-settings-tab-' + name" [attr.data-tab]="name"
            [attr.aria-selected]="active() === name" aria-controls="att-settings-panel" (click)="active.set(name)">
            {{ t('attendance.settings.tab.' + name) }}
          </button>
        }
      </div>
      <div id="att-settings-panel" role="tabpanel" [attr.aria-labelledby]="'att-settings-tab-' + active()">
        @switch (active()) {
          @case ('schedules') {
            <app-attendance-schedules-settings />
            <app-attendance-overrides-settings />
          }
          @case ('assignments') {
            <app-attendance-assignments-settings />
          }
          @case ('kiosks') {
            <app-attendance-kiosks-settings />
          }
          @case ('policy') {
            <app-attendance-policy-settings />
          }
        }
      </div>
    </ng-container>
  `,
})
export class AttendanceSettingsPage {
  protected readonly tabs = ATTENDANCE_SETTINGS_TABS;
  /** `?tab=assignments|kiosks|policy` (bound by the router). */
  readonly tab = input<string | undefined>();
  protected readonly active = linkedSignal<string | undefined, AttendanceSettingsTab>({
    source: this.tab,
    computation: (tab) =>
      (ATTENDANCE_SETTINGS_TABS as readonly string[]).includes(tab ?? '') ? (tab as AttendanceSettingsTab) : 'schedules',
  });
}
