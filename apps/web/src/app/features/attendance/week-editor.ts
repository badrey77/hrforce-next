/**
 * `<app-week-editor [week]="form.controls.week" idPrefix="new-schedule" />` — the 7-row week grid of a schedule
 * (docs/contracts/attendance.md › Settings › Horaires): Sunday first in the display (the Algerian week), the ISO number
 * underneath (what the API and the error messages speak), a "rest" toggle, start, end, break start and end.
 *
 * Angular concepts:
 * - **Passing a form PART to a child**: the parent owns the whole form (and submits it); the child receives the
 *   `FormArray` as an input and binds its controls with `[formControl]="group.controls.start"`. The child needs no
 *   `ControlValueAccessor` and no `formGroupName` chain: a control object IS the binding.
 * - **Why it still re-renders correctly with OnPush**: `[formControl]` directives update the `<input>`s themselves;
 *   the only thing this template computes from form STATE is whether a row is a rest day and its error line, and
 *   both are read through `rowState`, a signal fed by the array's `events` (as shared field errors do — chapter 14):
 *   `toSignal(toObservable(this.week).pipe(switchMap(a => a.events)))`.
 * - **`<input type="time">`**: the browser's own time picker; its value is always "HH:MM" (24 h) whatever the
 *   display locale, exactly the API's format. `dir="ltr"` keeps "08:00" readable in the Arabic UI.
 * - **Day names from the locale** (`DatePipe` 'EEEE' on a date that falls on that weekday, chapter 13).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { map, startWith, switchMap } from 'rxjs';
import { DISPLAY_WEEK, scheduledMinutesOf, weekdayDate, type WeekdayNumber } from '../../core/attendance/attendance.models';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { MinutesPipe } from '../../shared/attendance/minutes.pipe';
import { type WeekForm, weekFromForm } from './week-form';

interface RowState {
  readonly day: WeekdayNumber;
  readonly index: number;
  readonly rest: boolean;
  readonly minutes: number;
  /** A translation key, or the server's own text for a field error the API named (`week.3.end`). */
  readonly error: { readonly key: string } | { readonly text: string } | null;
}

function serverError(group: WeekForm['controls'][number]): RowState['error'] {
  for (const control of [group, ...Object.values(group.controls)]) {
    const key: unknown = control.getError('serverKey');
    if (typeof key === 'string') return { key };
    const text: unknown = control.getError('server');
    if (typeof text === 'string') return { text };
  }
  return null;
}

@Component({
  selector: 'app-week-editor',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, MinutesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './week-editor.html',
  styles: `
    .week { display: grid; gap: var(--space-2); margin: 0 0 var(--space-3); padding: 0; border: 0; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); padding-block: var(--space-1); border-block-end: 1px solid var(--color-border); }
    .name { min-inline-size: 8rem; }
    .name small { display: block; color: var(--color-text-muted); }
    .times { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-2); }
    .times label { font-size: 0.8125rem; color: var(--color-text-muted); }
    input[type='time'] { padding-block: 0; padding-inline: var(--space-1); border: 1px solid var(--color-border); border-radius: var(--radius); }
    legend { font-weight: 600; margin-block-end: var(--space-2); }
  `,
})
export class WeekEditor {
  private readonly lang = inject(LanguageService).current;
  protected readonly language = this.lang;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly week = input.required<WeekForm>();
  /** Unique prefix for the inputs' ids (two editors can share a page). */
  readonly idPrefix = input.required<string>();

  protected readonly weekdayDate = weekdayDate;

  protected readonly rows = toSignal(
    toObservable(this.week).pipe(
      switchMap((array) =>
        array.events.pipe(
          startWith(null),
          map(() => this.rowsOf(array)),
        ),
      ),
    ),
    { initialValue: [] as readonly RowState[] },
  );
  protected readonly weekly = computed(() => this.rows().reduce((sum, row) => sum + row.minutes, 0));
  protected readonly noWorkingDay = computed(() => this.rows().length > 0 && this.rows().every((row) => row.rest));

  protected group(index: number) {
    return this.week().at(index);
  }

  private rowsOf(array: WeekForm): readonly RowState[] {
    const week = weekFromForm(array);
    return DISPLAY_WEEK.map((day) => {
      const index = day - 1;
      const group = array.at(index);
      const value = week[index];
      const error: RowState['error'] = group.hasError('invalid_break')
        ? { key: 'attendance.week.invalidBreak' }
        : group.hasError('invalid_time')
          ? { key: 'attendance.week.invalidTime' }
          : serverError(group);
      return {
        day,
        index,
        rest: group.controls.rest.value,
        minutes: value && !group.hasError('invalid_time') && !group.hasError('invalid_break') ? scheduledMinutesOf(value) : 0,
        error,
      };
    });
  }
}
