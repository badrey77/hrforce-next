/**
 * `<app-correction-changes [changes]="c.changes" />` — the requested changes of a correction as a short list
 * (« Ajouter : départ 16:30 », « Retirer : arrivée 07:52 »). Used by the employee's list of requests, the HR list and
 * the correction detail.
 *
 * Angular concepts: the smallest kind of presentational component — one signal input, no logic, no injected state
 * but the translations. `@switch (change.action)` picks the sentence; the time sits in a `<time dir="ltr">` so
 * "16:30" never flips in an Arabic sentence. `:host { display: contents }` lets the host list element take part in
 * the parent's layout as if the component were not there.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import type { CorrectionChange } from '../../core/attendance/attendance.models';

@Component({
  selector: 'app-correction-changes',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul *transloco="let t" class="changes" data-field="changes">
      @for (change of changes(); track change.position) {
        <li [attr.data-action]="change.action">
          @switch (change.action) {
            @case ('add') {
              {{ t('attendance.corrections.addChange', { direction: t('attendance.direction.' + (change.direction ?? 'in')) }) }}
              <time dir="ltr">{{ change.time }}</time>
            }
            @case ('void') {
              {{ t('attendance.corrections.voidChange', { direction: t('attendance.direction.' + (change.punch?.direction ?? 'in')) }) }}
              <time dir="ltr">{{ change.punch?.localTime ?? '—' }}</time>
            }
          }
        </li>
      }
    </ul>
  `,
  styles: `
    :host { display: contents; }
    .changes { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin: 0; padding: 0; list-style: none; }
    time { font-weight: 600; font-variant-numeric: tabular-nums; }
  `,
})
export class CorrectionChanges {
  readonly changes = input.required<readonly CorrectionChange[]>();
}
