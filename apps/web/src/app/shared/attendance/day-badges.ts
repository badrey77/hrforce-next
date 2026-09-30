/**
 * Small presentational pieces of every attendance screen (docs/contracts/attendance.md › Web):
 * - `<app-day-status [status]="day.status" />` — the status chip (Présent, En retard, Absent…);
 * - `<app-day-flags [flags]="day.flags" />` — the day's flags as small chips, each with its explanation.
 *
 * Never colour alone (WCAG 1.4.1): the chip's TEXT names the status; the colour family (`data-tone`, from the pure
 * `statusTone()`) only helps scanning a long board.
 *
 * Angular concepts:
 * - **Presentational components**: inputs in, markup out, no service, no state. `OnPush` + signal inputs mean they
 *   re-render only when their input changes, which matters on a board of 100 rows re-read every minute.
 * - **`:host` styles with an attribute selector** (`:host([data-tone='bad'])`): the component styles ITS OWN host
 *   element from a value it sets through `host: { '[attr.data-tone]': … }` — a host binding, the component-level
 *   twin of `[attr.x]` in a template.
 * - **Tooltips that also work on touch and for screen readers.** A `title` attribute shows on hover only; each flag
 *   also carries the explanation as visually hidden text, so a phone user reading with a screen reader gets it too.
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { type DayFlag, type DayStatus, statusTone } from '../../core/attendance/attendance.models';

@Component({
  selector: 'app-day-status',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[attr.data-tone]': 'tone()', '[attr.data-status]': 'status()' },
  template: `<ng-container *transloco="let t">{{ t('attendance.status.' + status()) }}</ng-container>`,
  styles: `
    :host {
      display: inline-block;
      padding-inline: var(--space-2);
      border-radius: 999px;
      border: 1px solid var(--color-border);
      background: var(--color-surface-alt);
      font-size: 0.8125rem;
      line-height: 1.5;
      white-space: nowrap;
    }
    :host([data-tone='ok']) { border-color: #1a7f37; color: #116329; background: #dafbe1; }
    :host([data-tone='warn']) { border-color: #9a6700; color: #7d4e00; background: #fff8c5; }
    :host([data-tone='bad']) { border-color: var(--color-danger); color: var(--color-danger); background: #ffebe9; }
    :host([data-tone='info']) { border-color: var(--color-primary); color: var(--color-primary); }
    :host([data-tone='off']) { color: var(--color-text-muted); }
  `,
})
export class DayStatusBadge {
  readonly status = input.required<DayStatus>();
  protected readonly tone = computed(() => statusTone(this.status()));
}

@Component({
  selector: 'app-day-flags',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @for (flag of flags(); track flag) {
        <span class="flag" [attr.data-flag]="flag" [attr.title]="t('attendance.flagHelp.' + flag)">
          {{ t('attendance.flags.' + flag) }}<span class="visually-hidden"> — {{ t('attendance.flagHelp.' + flag) }}</span>
        </span>
      }
    </ng-container>
  `,
  styles: `
    :host { display: inline-flex; flex-wrap: wrap; gap: var(--space-1); }
    .flag {
      position: relative;
      padding-inline: var(--space-1);
      border: 1px dashed var(--color-border);
      border-radius: var(--radius);
      font-size: 0.75rem;
      color: var(--color-text-muted);
      white-space: nowrap;
    }
    .flag[data-flag='shared_device'], .flag[data-flag='other_site'] { border-style: solid; border-color: #9a6700; color: #7d4e00; }
  `,
})
export class DayFlags {
  readonly flags = input.required<readonly DayFlag[]>();
}
