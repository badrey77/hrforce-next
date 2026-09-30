/**
 * `<app-correction-preview [punches]="day.punches" [changes]="correction.changes" />` — a correction request as a
 * clear BEFORE / AFTER view of the day (docs/contracts/attendance.md › Web (Phase B)): on the left what is recorded
 * now, on the right what the day will hold once approved — removed punches struck through, added ones marked. Used by
 * My tasks (the approver decides from it), the HR correction detail, and the employee's own correction dialog (as a
 * live preview while they fill it in).
 *
 * Angular concepts:
 * - **A presentational component over a pure function.** The rules (which punch is kept, removed, added; in which
 *   order) live in `correctionPreview()` (core/attendance/attendance.models.ts, unit-tested without TestBed); a
 *   `computed()` calls it, so the lists are rebuilt only when `punches` or `changes` change — in the dialog that is
 *   on every keystroke of a time field, and nowhere else.
 * - **Semantic HTML carries the meaning, not colour.** A removed punch is a `<del>` and an added one an `<ins>`: the
 *   browser strikes/underlines them, assistive technologies can announce "deletion"/"insertion", and a visible word
 *   ("à retirer", "ajouté") says it again for everyone (WCAG 1.4.1: never colour alone).
 * - **`@for … track row.key`**: the key is the punch id, or `add-<position>` for a requested punch, so editing one
 *   added time updates that row instead of re-creating the list.
 * - **Two columns that stack on a phone** with a CSS grid (`repeat(auto-fit, minmax(…))`): no media query, and the
 *   BEFORE column comes first in reading order in both directions (RTL mirrors the grid by itself).
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import {
  type CorrectionChange,
  correctionPreview,
  type PunchView,
} from '../../core/attendance/attendance.models';

/** What the preview needs of a punch (a full `PunchView`, or an arrival/departure turned into one). */
export type PreviewSourcePunch = Pick<PunchView, 'id' | 'direction' | 'localTime' | 'status'>;
export type PreviewSourceChange = Pick<CorrectionChange, 'position' | 'action' | 'direction' | 'time' | 'punch'>;

@Component({
  selector: 'app-correction-preview',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div *transloco="let t" class="preview" data-panel="correction-preview">
      <section class="side" aria-labelledby="{{ idPrefix() }}-before">
        <h3 [id]="idPrefix() + '-before'">{{ t('attendance.corrections.before') }}</h3>
        <ol>
          @for (row of preview().before; track row.key) {
            <li [attr.data-row]="row.key">
              <time dir="ltr">{{ row.localTime }}</time> {{ t('attendance.direction.' + row.direction) }}
            </li>
          } @empty {
            <li class="muted" data-state="no-punch">{{ t('attendance.day.noPunch') }}</li>
          }
        </ol>
      </section>
      <section class="side" aria-labelledby="{{ idPrefix() }}-after">
        <h3 [id]="idPrefix() + '-after'">{{ t('attendance.corrections.after') }}</h3>
        <ol>
          @for (row of preview().after; track row.key) {
            <li [attr.data-row]="row.key" [attr.data-change]="row.change">
              @switch (row.change) {
                @case ('removed') {
                  <del><time dir="ltr">{{ row.localTime }}</time> {{ t('attendance.direction.' + row.direction) }}</del>
                  <span class="tag removed">{{ t('attendance.corrections.removed') }}</span>
                }
                @case ('added') {
                  <ins><time dir="ltr">{{ row.localTime }}</time> {{ t('attendance.direction.' + row.direction) }}</ins>
                  <span class="tag added">{{ t('attendance.corrections.added') }}</span>
                }
                @default {
                  <time dir="ltr">{{ row.localTime }}</time> {{ t('attendance.direction.' + row.direction) }}
                }
              }
            </li>
          } @empty {
            <li class="muted">{{ t('attendance.day.noPunch') }}</li>
          }
        </ol>
      </section>
    </div>
  `,
  styles: `
    .preview { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--space-3); }
    .side { padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); }
    h3 { margin-block: 0 var(--space-2); font-size: 0.9375rem; }
    ol { display: grid; gap: var(--space-1); margin: 0; padding: 0; list-style: none; }
    time { font-variant-numeric: tabular-nums; font-weight: 600; }
    del { color: var(--color-text-muted); }
    ins { text-decoration-thickness: 2px; }
    .tag { margin-inline-start: var(--space-2); padding-inline: var(--space-1); border: 1px solid currentColor; border-radius: var(--radius);
      font-size: 0.75rem; }
    .tag.removed { color: var(--color-danger); }
    .tag.added { color: #116329; }
  `,
})
export class CorrectionPreviewView {
  readonly punches = input.required<readonly PreviewSourcePunch[]>();
  readonly changes = input.required<readonly PreviewSourceChange[]>();
  /** Prefix of the heading ids (two previews on one page need different ids). */
  readonly idPrefix = input('correction-preview');

  protected readonly preview = computed(() => correctionPreview(this.punches(), this.changes()));
}

/** A task summary knows only arrival and departure: turn them into punches for the preview. */
export function punchesOfSummary(day: {
  readonly arrival: { readonly id: string; readonly localTime: string } | null;
  readonly departure: { readonly id: string; readonly localTime: string } | null;
}): PreviewSourcePunch[] {
  const punches: PreviewSourcePunch[] = [];
  if (day.arrival) punches.push({ id: day.arrival.id, direction: 'in', localTime: day.arrival.localTime, status: 'live' });
  if (day.departure) punches.push({ id: day.departure.id, direction: 'out', localTime: day.departure.localTime, status: 'live' });
  return punches;
}
