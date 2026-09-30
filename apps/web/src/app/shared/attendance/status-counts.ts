/**
 * `<app-status-counts [counts]="board.counts" [selected]="query.status" (select)="filter($event)" />` — one chip per
 * board status with its count; clicking a chip filters the list by that status, clicking it again clears the filter
 * (docs/contracts/attendance.md › Web › Presence board: "status chips with the counts (click = filter)"). The counts
 * are over every matching employee BEFORE the status filter (contract), so they stay put while filtering.
 *
 * Angular concepts:
 * - **`output()`** — the component emits a value and lets the PAGE decide what it means (the board writes it to the
 *   URL). The chips never navigate themselves: the same component serves the HR board and "Mon équipe".
 * - **Toggle buttons**: `aria-pressed` says which chip is the active filter (a screen reader reads "pressed"), a
 *   better fit than a radio group because "none pressed" is a valid state (no filter).
 */
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { BOARD_STATUSES, type BoardStatus, type Counts, statusTone } from '../../core/attendance/attendance.models';

@Component({
  selector: 'app-status-counts',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div *transloco="let t" class="chips" role="group" [attr.aria-label]="t('attendance.board.countsLabel')">
      <span class="total" data-count="total">{{ t('attendance.board.total', { count: counts().total }) }}</span>
      @for (status of statuses; track status) {
        <button type="button" class="chip" [attr.data-status]="status" [attr.data-tone]="tone(status)"
          [attr.aria-pressed]="selected() === status" (click)="select.emit(selected() === status ? null : status)">
          {{ t('attendance.status.' + status) }} <strong>{{ counts()[status] }}</strong>
        </button>
      }
    </div>
  `,
  styles: `
    .chips { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-block: var(--space-3); }
    .total { font-weight: 600; margin-inline-end: var(--space-2); }
    .chip {
      padding-block: var(--space-1);
      padding-inline: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: 999px;
      background: var(--color-surface);
      color: inherit;
      cursor: pointer;
    }
    .chip[data-tone='ok'] strong { color: #116329; }
    .chip[data-tone='warn'] strong { color: #7d4e00; }
    .chip[data-tone='bad'] strong { color: var(--color-danger); }
    .chip[aria-pressed='true'] { border-color: var(--color-primary); background: var(--color-primary); color: var(--color-on-primary); }
    .chip[aria-pressed='true'] strong { color: inherit; }
  `,
})
export class StatusCounts {
  readonly counts = input.required<Counts>();
  readonly selected = input<BoardStatus | null>(null);
  readonly select = output<BoardStatus | null>();

  protected readonly statuses = BOARD_STATUSES;
  protected readonly tone = statusTone;
}
